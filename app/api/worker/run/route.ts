import { randomUUID, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { sendTradingNotification } from '@/lib/notifications'
import { recordScheduleEvent, scheduleWindowAction } from '@/lib/scheduled-events'
import { claimScanLease, ensureScanSession, releaseScanLease } from '@/lib/scan-lock'
import { minimumScanLeaseIntervalSeconds, scanConfig } from '@/lib/scan-config'
import { closePaperPosition, loadFreshPaperMarketMarks, loadOpenPaperPositions, markPaperPosition, openPaperPosition, paperExecutionGuardrails, paperExitReason, positionExposure } from '@/lib/paper-trading'
import { decideEntry, isFlattenWindow, isTradingWindow, normalizeFloatShares, scoreCandidate, simulatedMarginBuyingPower, strategyGuardrails, type ScanCandidate } from '@/lib/strategy'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function isValidCandidate(value: unknown): value is ScanCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ScanCandidate>
  if (typeof candidate.symbol !== 'string' || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(candidate.symbol) || typeof candidate.price !== 'number' || !Number.isFinite(candidate.price) || candidate.price <= 0) return false
  const numericFields = [candidate.bid, candidate.ask, candidate.volume, candidate.averageVolume, candidate.float, candidate.changePercent, candidate.vwap, candidate.atr, candidate.socialScore, candidate.relativeVolume, candidate.relativeVolumeBaselineVolume, candidate.lastTradePrice, candidate.spreadPct]
  if (numericFields.some((field) => field !== undefined && (typeof field !== 'number' || !Number.isFinite(field)))) return false
  if (candidate.floatSource !== undefined && candidate.floatSource !== 'fmp' && candidate.floatSource !== 'finnhub') return false
  const textFields = [candidate.companyName, candidate.catalystType, candidate.catalystSummary, candidate.lastTradeAt, candidate.quoteAt]
  if (textFields.some((field) => field !== undefined && (typeof field !== 'string' || field.length > 500))) return false
  if (candidate.enrichmentErrors !== undefined && (!Array.isArray(candidate.enrichmentErrors) || candidate.enrichmentErrors.length > 20 || candidate.enrichmentErrors.some((value) => typeof value !== 'string' || value.length > 300))) return false
  if (candidate.relativeVolumeReliable !== undefined && typeof candidate.relativeVolumeReliable !== 'boolean') return false
  return candidate.hasNews === undefined || typeof candidate.hasNews === 'boolean'
}

function isAuthorized(request: NextRequest) {
  const configuredSecret = process.env.WORKER_RUN_SECRET?.trim()
  const authorization = request.headers.get('authorization')?.trim()
  const suppliedSecret = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!configuredSecret || !suppliedSecret) return false
  const configuredBytes = Buffer.from(configuredSecret)
  const suppliedBytes = Buffer.from(suppliedSecret)
  return configuredBytes.length === suppliedBytes.length && timingSafeEqual(configuredBytes, suppliedBytes)
}

type Evaluation = { candidate: ScanCandidate; decision: ReturnType<typeof decideEntry>; requestedPrice?: number }
type ScanContext = { scanId: string; sessionId: string; triggerSource: string; startedAt: Date; durationMs: number }
type ScanOutcome = { status: 'completed' | 'failed'; scannedCandidates: number; enterCandidates: number; positionsExited: number; error?: string }

function safeTriggerSource(value: unknown) {
  return value === 'railway-scheduler' || value === 'vercel-cron' || value === 'manual' || value === 'api' ? value : 'api'
}

function validScanId(value: unknown) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : randomUUID()
}

async function writeScanEvent(eventType: string, message: string, context: Partial<ScanContext>, payload: Record<string, unknown>) {
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      level: eventType === 'SCAN_FAILED' ? 'error' : 'info',
      event_type: eventType,
      message: message.slice(0, 240),
      session_id: context.sessionId ?? null,
      payload: { scanId: context.scanId, triggerSource: context.triggerSource, ...payload },
    }),
    signal: AbortSignal.timeout(5_000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase ${eventType} event write failed (${response.status})`)
}

async function createScanRun(scanId: string, triggerSource: string, startedAt: Date) {
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_scan_runs`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ scan_id: scanId, trigger_source: triggerSource, started_at: startedAt.toISOString() }),
    signal: AbortSignal.timeout(5_000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase scan heartbeat insert failed (${response.status})`)
}

async function updateScanRun(scanId: string, fields: Record<string, unknown>) {
  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_scan_runs`)
  url.search = new URLSearchParams({ scan_id: `eq.${scanId}` }).toString()
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
    signal: AbortSignal.timeout(5_000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase scan heartbeat update failed (${response.status})`)
}

async function persistWorkerActivity(evaluations: Evaluation[], context: ScanContext) {
  let persistenceWarning: string | null = null
  let scanRowsWritten = 0
  if (evaluations.length) {
    const scanRows = evaluations.map(({ candidate, decision }) => {
      const averageVolume = candidate.averageVolume ?? 0
      const relativeVolume = candidate.relativeVolume ?? (averageVolume > 0 ? (candidate.volume ?? 0) / averageVolume : null)
      const floatShares = normalizeFloatShares(candidate.float, candidate.floatSource)
      const catalystType = candidate.catalystType ?? (candidate.hasNews ? 'news' : (candidate.socialScore ?? 0) >= 60 ? 'social' : null)
      const catalystSummary = candidate.catalystSummary ?? (candidate.hasNews === true ? 'News catalyst identified; source summary was not provided.' : null)
      const missingEnrichmentFields = Object.entries({
        company_name: candidate.companyName,
        relative_volume: relativeVolume,
        float_shares: floatShares,
        atr: candidate.atr,
        vwap: candidate.vwap,
        catalyst_type: catalystType,
        catalyst_summary: catalystSummary,
        last_trade_at: candidate.lastTradeAt,
        spread_pct: candidate.spreadPct,
      }).filter(([, value]) => value == null).map(([field]) => field)

      return {
        scan_id: context.scanId,
        session_id: context.sessionId,
        symbol: candidate.symbol,
        company_name: candidate.companyName ?? null,
        price: candidate.price,
        change_percent: candidate.changePercent ?? null,
        volume: candidate.volume ?? null,
        relative_volume: Number.isFinite(relativeVolume) ? relativeVolume : null,
        float_shares: floatShares == null ? null : Math.round(floatShares),
        atr: candidate.atr ?? null,
        vwap: candidate.vwap ?? null,
        catalyst_type: catalystType,
        catalyst_summary: catalystSummary,
        score: scoreCandidate(candidate, context.startedAt),
        decision: decision.action === 'enter' ? 'enter' : 'watch',
        scanned_at: context.startedAt.toISOString(),
        last_trade_at: candidate.lastTradeAt ?? null,
        spread_pct: candidate.spreadPct ?? null,
        trigger_source: context.triggerSource,
        scan_duration_ms: context.durationMs,
        metadata: {
          source: context.triggerSource,
          strategy: 'rules-engine-paper-v1',
          floatSource: candidate.floatSource ?? null,
          quoteAt: candidate.quoteAt ?? null,
          relativeVolumeReliable: candidate.relativeVolumeReliable ?? null,
          relativeVolumeBaselineVolume: candidate.relativeVolumeBaselineVolume ?? null,
          missingEnrichmentFields,
          enrichmentErrors: candidate.enrichmentErrors ?? [],
          lastTradePrice: candidate.lastTradePrice ?? null,
          averageVolume: candidate.averageVolume ?? null,
          riskPerShare: decision.riskPerShare,
          suggestedShares: decision.suggestedShares,
        },
      }
    })
    const scansResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_watchlist_scans`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(scanRows),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    if (!scansResponse.ok) persistenceWarning = `Supabase enriched scan write failed (${scansResponse.status})`
    else scanRowsWritten = scanRows.length

    const incompleteRows = evaluations.filter(({ candidate }) => (candidate.enrichmentErrors?.length ?? 0) > 0)
    if (incompleteRows.length) {
      const diagnosticsResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`, {
        method: 'POST',
        headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify(incompleteRows.map(({ candidate }) => ({
          level: 'warning',
          event_type: 'SCAN_ENRICHMENT_INCOMPLETE',
          message: `${candidate.symbol} is missing one or more enrichment values`,
          symbol: candidate.symbol,
          session_id: context.sessionId,
          payload: { scanId: context.scanId, triggerSource: context.triggerSource, reasons: candidate.enrichmentErrors },
        }))),
        signal: AbortSignal.timeout(5_000),
        cache: 'no-store',
      })
      if (!diagnosticsResponse.ok) persistenceWarning ??= `Supabase enrichment diagnostic write failed (${diagnosticsResponse.status})`
    }
  }

  if (evaluations.length) {
    const signalsResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_strategy_signals`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(evaluations.map(({ candidate, decision }) => ({
        session_id: context.sessionId,
        symbol: candidate.symbol,
        action: decision.action,
        confidence: Math.max(0, Math.min(100, Math.round(decision.confidence * 100))),
        rationale: decision.reason,
        model: 'rules-engine-paper-v1',
        features: {
          scanId: context.scanId,
          triggerSource: context.triggerSource,
          price: candidate.price,
          lastTradePrice: candidate.lastTradePrice ?? null,
          spreadPct: candidate.spreadPct ?? null,
          relativeVolume: candidate.relativeVolume ?? null,
          atr: candidate.atr ?? null,
          riskPerShare: decision.riskPerShare,
          suggestedShares: decision.suggestedShares,
        },
      }))),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    if (!signalsResponse.ok) persistenceWarning ??= `Supabase strategy-signal write failed (${signalsResponse.status})`
  }

  const buyCount = evaluations.filter(({ decision }) => decision.action === 'enter').length
  try {
    await writeScanEvent(
      'STRATEGY_SCAN',
      `Evaluated ${evaluations.length} symbols; ${buyCount} passed paper guardrails for paper-only execution.`,
      context,
      { scannedCandidates: evaluations.length, buyCandidates: buyCount, scanDurationMs: context.durationMs },
    )
  } catch (error) {
    persistenceWarning ??= error instanceof Error ? error.message : 'Supabase scan completion event could not be written'
  }
  return { persistenceWarning, scanRowsWritten }
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (tradingConfig.mode !== 'paper' || strategyGuardrails.liveTradingEnabled) return NextResponse.json({ error: 'Live execution is disabled by guardrails.' }, { status: 403 })

  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const now = new Date()
  const scheduleAction = scheduleWindowAction(now)
  if (scheduleAction) {
    try {
      await recordScheduleEvent(scheduleAction, now)
    } catch (error) {
      console.error('[worker] scheduled system event could not be recorded', error)
      return NextResponse.json({ status: 'schedule_event_failed', error: 'Scheduled event could not be recorded.' }, { status: 503 })
    }
  }
  const flatten = isFlattenWindow(now)
  if (!isTradingWindow(now) && !flatten) return NextResponse.json({ status: 'sleeping', mode: 'paper', checkedAt: now.toISOString() })
  if (!tradingConfig.supabaseUrl || !tradingConfig.supabaseKey) return NextResponse.json({ error: 'Internal paper-trading ledger is unavailable.' }, { status: 503 })

  const candidates = !flatten && !body.scanError && Array.isArray(body.candidates) ? body.candidates.filter(isValidCandidate).slice(0, 50) : []
  const triggerSource = safeTriggerSource(request.headers.get('x-trigger-source') ?? body.triggerSource)
  const scanId = validScanId(request.headers.get('x-scan-id') ?? body.scanId)
  const scanStartedAtValue = typeof body.scanStartedAt === 'string' ? new Date(body.scanStartedAt) : now
  const scanStartedAt = Number.isFinite(scanStartedAtValue.getTime()) && scanStartedAtValue <= now ? scanStartedAtValue : now
  const upstreamScanError = typeof body.scanError === 'string' ? body.scanError.slice(0, 400) : null
  const ownerToken = randomUUID()

  let leaseStatus: 'acquired' | 'busy' | 'cooldown'
  try {
    leaseStatus = await claimScanLease(ownerToken, scanConfig.leaseSeconds, flatten ? 1 : minimumScanLeaseIntervalSeconds(now))
  } catch (error) {
    console.error('[worker] scan lease could not be acquired', { scanId, error })
    return NextResponse.json({ status: 'scan_lock_unavailable', error: 'Distributed scan lock is unavailable; no scan was run.' }, { status: 503 })
  }
  if (leaseStatus !== 'acquired') {
    return NextResponse.json({ status: leaseStatus === 'busy' ? 'overlap_skipped' : 'cadence_skipped', scanId, triggerSource }, { status: 202 })
  }

  let sessionId: string | null = null
  let scanRunCreated = false
  let outcome: ScanOutcome = { status: 'failed', scannedCandidates: candidates.length, enterCandidates: 0, positionsExited: 0 }
  let persistenceWarning: string | null = null
  let scanRowsWritten = 0
  const paperExecutions: Array<{ symbol: string; status: string; reason?: string; positionId?: string; fillPrice?: number }> = []
  const context: Partial<ScanContext> = { scanId, triggerSource, startedAt: scanStartedAt }
  try {
    await createScanRun(scanId, triggerSource, now)
    scanRunCreated = true
    sessionId = await ensureScanSession(now)
    context.sessionId = sessionId
    await updateScanRun(scanId, { session_id: sessionId, scanned_candidates: candidates.length })
    await writeScanEvent(flatten ? 'PAPER_FLATTEN_STARTED' : 'SCAN_STARTED', flatten ? 'Paper session flatten pass started.' : `Paper scan started for ${candidates.length} candidate(s).`, context, {
      startedAt: scanStartedAt.toISOString(),
      receivedAt: now.toISOString(),
      flatten,
    }).catch((error) => console.error('[worker] scan start event could not be written', { scanId, error }))

    const openPositions = await loadOpenPaperPositions()
    const marks = await loadFreshPaperMarketMarks([...openPositions.map((position) => position.symbol), ...candidates.map((candidate) => candidate.symbol)], now)
    let allOpenPositionsMarked = true
    for (const position of openPositions) {
      const mark = marks.get(position.symbol)
      if (!mark) {
        allOpenPositionsMarked = false
        await writeScanEvent('POSITION_EXIT_MARK_UNAVAILABLE', `No fresh quote available to manage ${position.symbol}; position remains open.`, context, {
          symbol: position.symbol,
          positionId: position.id,
          flatten,
        }).catch(() => undefined)
        continue
      }

      const markResult = await markPaperPosition(position.id, mark.price)
      if (markResult.status !== 'marked') {
        allOpenPositionsMarked = false
        continue
      }
      const exitReason = paperExitReason(position, mark, flatten)
      if (!exitReason) continue

      const closeResult = await closePaperPosition({
        sessionId,
        positionId: position.id,
        fillPrice: mark.bid * (1 - paperExecutionGuardrails().slippageFraction),
        exitReason,
        idempotencyKey: `close:${position.id}`,
      })
      if (closeResult.status === 'closed') outcome.positionsExited += 1
      if (closeResult.status !== 'closed' && closeResult.status !== 'already_executed') {
        allOpenPositionsMarked = false
        paperExecutions.push({ symbol: position.symbol, status: closeResult.status, reason: closeResult.reason ?? exitReason })
      }
    }

    if (upstreamScanError) throw new Error(`Upstream scanner failed: ${upstreamScanError}`)

    const ledgerResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_papermoney?select=starting_balance,cash_balance,equity&account_name=eq.paper-main&is_active=eq.true&limit=1`, {
      headers: supabaseHeaders(),
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    })
    if (!ledgerResponse.ok) throw new Error(`Paper account ledger read failed (${ledgerResponse.status})`)
    const ledger = await ledgerResponse.json() as Array<{ starting_balance?: number; cash_balance?: number; equity?: number }>
    const account = ledger[0]
    const startingBalance = Number(account?.starting_balance)
    const cashBalance = Number(account?.cash_balance)
    const equity = Number(account?.equity ?? startingBalance)
    if (!Number.isFinite(equity) || equity <= 0 || !Number.isFinite(cashBalance) || cashBalance < 0) {
      throw new Error('Internal paper-trading ledger has no valid sizing balance.')
    }

    const remainingPositions = await loadOpenPaperPositions()
    const currentExposure = positionExposure(remainingPositions)
    const exposureHeadroom = Math.max(0, equity * strategyGuardrails.maxAggregateExposureFraction - currentExposure)
    const marginBuyingPower = simulatedMarginBuyingPower(equity, cashBalance, currentExposure, strategyGuardrails.minimumMarginEquity)
    let remainingAllocation = allOpenPositionsMarked ? Math.min(exposureHeadroom, marginBuyingPower) : 0
    const evaluations: Evaluation[] = []
    for (const originalCandidate of candidates) {
      const mark = marks.get(originalCandidate.symbol)
      const lastTradeAt = originalCandidate.lastTradeAt ? Date.parse(originalCandidate.lastTradeAt) : Number.NaN
      const tradeAgeSeconds = (now.getTime() - lastTradeAt) / 1_000
      const decision = !mark
        ? { action: 'hold' as const, symbol: originalCandidate.symbol, confidence: 0, reason: 'Fresh executable quote unavailable; no paper order was opened.', riskPerShare: originalCandidate.atr ?? 0, suggestedShares: 0 }
        : !Number.isFinite(tradeAgeSeconds) || tradeAgeSeconds < 0 || tradeAgeSeconds > scanConfig.maxTradeAgeSeconds
          ? { action: 'hold' as const, symbol: originalCandidate.symbol, confidence: 0, reason: 'Latest trade became stale before execution; no paper order was opened.', riskPerShare: originalCandidate.atr ?? 0, suggestedShares: 0 }
          : decideEntry({ ...originalCandidate, price: mark.ask, bid: mark.bid, ask: mark.ask, quoteAt: mark.at, spreadPct: ((mark.ask - mark.bid) / ((mark.ask + mark.bid) / 2)) * 100 }, equity, now, remainingAllocation)
      const candidate = mark ? { ...originalCandidate, price: mark.ask, bid: mark.bid, ask: mark.ask, quoteAt: mark.at, spreadPct: ((mark.ask - mark.bid) / ((mark.ask + mark.bid) / 2)) * 100 } : originalCandidate
      evaluations.push({ candidate, decision, requestedPrice: originalCandidate.price })
      console.info('[worker] strategy decision', {
        scanId,
        triggerSource,
        symbol: candidate.symbol,
        action: decision.action,
        score: scoreCandidate(candidate, now),
        floatSource: candidate.floatSource ?? 'missing',
        floatShares: candidate.float ?? null,
        relativeVolume: candidate.relativeVolume ?? null,
        spreadPct: candidate.spreadPct ?? null,
        remainingAllocation,
      })
      if (decision.action === 'enter') remainingAllocation = Math.max(0, remainingAllocation - decision.suggestedShares * candidate.price)
    }

    const enterCount = evaluations.filter(({ decision }) => decision.action === 'enter').length
    const durationMs = Math.max(0, Date.now() - scanStartedAt.getTime())
    const scanContext: ScanContext = { scanId, sessionId, triggerSource, startedAt: scanStartedAt, durationMs }
    const persistence = await persistWorkerActivity(evaluations, scanContext)
    persistenceWarning = persistence.persistenceWarning
    scanRowsWritten = persistence.scanRowsWritten

    if (!flatten) {
      for (const { candidate, decision, requestedPrice } of evaluations) {
        if (decision.action !== 'enter') continue
        const mark = marks.get(candidate.symbol)
        if (!mark || !allOpenPositionsMarked) {
          paperExecutions.push({ symbol: candidate.symbol, status: 'blocked', reason: 'Open positions could not all be marked with fresh quotes.' })
          continue
        }
        const fillPrice = mark.ask * (1 + paperExecutionGuardrails().slippageFraction)
        try {
          const result = await openPaperPosition({
            sessionId,
            scanId,
            symbol: candidate.symbol,
            quantity: decision.suggestedShares,
            requestedPrice: requestedPrice ?? candidate.price,
            fillPrice,
            stopPrice: Math.max(0.01, fillPrice - decision.riskPerShare),
            targetPrice: fillPrice + decision.riskPerShare * 1.5,
            riskPerShare: decision.riskPerShare,
            idempotencyKey: `entry:${scanId}:${candidate.symbol}`,
            maxPositionFraction: strategyGuardrails.maxPositionFraction,
            maxAggregateExposureFraction: strategyGuardrails.maxAggregateExposureFraction,
            riskPerTradeFraction: strategyGuardrails.riskPerTradeFraction,
            maxDailyLossFraction: strategyGuardrails.maxDailyLossFraction,
            maxOpenPositions: strategyGuardrails.maxOpenPositions,
            minimumMarginEquity: strategyGuardrails.minimumMarginEquity,
            reentryCooldownMinutes: strategyGuardrails.reentryCooldownMinutes,
          })
          paperExecutions.push({ symbol: candidate.symbol, status: result.status, reason: result.reason, positionId: result.positionId, fillPrice: result.fillPrice })
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Paper entry could not be recorded'
          persistenceWarning ??= reason
          paperExecutions.push({ symbol: candidate.symbol, status: 'execution_error', reason })
        }
      }
    }

    const filledEntries = paperExecutions.filter((execution) => execution.status === 'filled')
    const notificationResults = body.notify && filledEntries.length
      ? await sendTradingNotification({ title: 'AItrading paper entries', message: `Paper-only entries filled: ${filledEntries.map(({ symbol }) => symbol).join(', ')}` })
      : []
    outcome = { status: 'completed', scannedCandidates: candidates.length, enterCandidates: enterCount, positionsExited: outcome.positionsExited }
    return NextResponse.json({
      status: flatten ? 'paper_flatten_complete' : 'paper_execution_complete',
      mode: 'paper-margin-simulation',
      checkedAt: now.toISOString(),
      scanId,
      triggerSource,
      scanDurationMs: durationMs,
      scannedCandidates: candidates.length,
      scanRowsWritten,
      positionsExited: outcome.positionsExited,
      decisions: evaluations.filter(({ decision }) => decision.action !== 'hold').map(({ decision }) => decision),
      paperExecutions,
      notificationResults,
      liveTradingEnabled: false,
      ...(persistenceWarning ? { persistenceWarning } : {}),
    })
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : 'Unexpected scan failure'
    console.error('[worker] paper scan failed', { scanId, triggerSource, error })
    return NextResponse.json({ status: 'paper_scan_failed', error: 'The paper scan could not be completed.', scanId }, { status: 503 })
  } finally {
    const durationMs = Math.max(0, Date.now() - now.getTime())
    await writeScanEvent(
      outcome.status === 'completed' ? 'SCAN_COMPLETED' : 'SCAN_FAILED',
      outcome.status === 'completed' ? `Paper scan completed in ${durationMs}ms.` : `Paper scan failed after ${durationMs}ms.`,
      { ...context, sessionId: sessionId ?? undefined, durationMs },
      { startedAt: scanStartedAt.toISOString(), endedAt: new Date().toISOString(), scanDurationMs: durationMs, ...outcome },
    ).catch((error) => console.error('[worker] scan end event could not be written', { scanId, error }))
    if (scanRunCreated) {
      await updateScanRun(scanId, {
        session_id: sessionId,
        status: outcome.status,
        completed_at: new Date().toISOString(),
        scanned_candidates: outcome.scannedCandidates,
        buy_candidates: outcome.enterCandidates,
        scan_duration_ms: durationMs,
        error: outcome.error ?? null,
      }).catch((error) => console.error('[worker] scan heartbeat could not be finalized', { scanId, error }))
    }
    await releaseScanLease(ownerToken).catch((error) => console.error('[worker] scan lease release failed', { scanId, error }))
  }
}
