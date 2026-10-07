import { randomUUID, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { sendTradingNotification } from '@/lib/notifications'
import { recordScheduleEvent, scheduleWindowAction } from '@/lib/scheduled-events'
import { claimScanLease, ensureScanSession, releaseScanLease } from '@/lib/scan-lock'
import { expectedScanIntervalSeconds, scanConfig } from '@/lib/scan-config'
import { decideEntry, isFlattenWindow, isTradingWindow, normalizeFloatShares, scoreCandidate, strategyGuardrails, type ScanCandidate } from '@/lib/strategy'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function isValidCandidate(value: unknown): value is ScanCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ScanCandidate>
  if (typeof candidate.symbol !== 'string' || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(candidate.symbol) || typeof candidate.price !== 'number' || !Number.isFinite(candidate.price) || candidate.price <= 0) return false
  const numericFields = [candidate.bid, candidate.ask, candidate.volume, candidate.averageVolume, candidate.float, candidate.changePercent, candidate.vwap, candidate.atr, candidate.socialScore, candidate.relativeVolume, candidate.lastTradePrice, candidate.spreadPct]
  if (numericFields.some((field) => field !== undefined && (typeof field !== 'number' || !Number.isFinite(field)))) return false
  if (candidate.floatSource !== undefined && candidate.floatSource !== 'fmp' && candidate.floatSource !== 'finnhub') return false
  const textFields = [candidate.companyName, candidate.catalystType, candidate.catalystSummary, candidate.lastTradeAt]
  if (textFields.some((field) => field !== undefined && (typeof field !== 'string' || field.length > 500))) return false
  if (candidate.enrichmentErrors !== undefined && (!Array.isArray(candidate.enrichmentErrors) || candidate.enrichmentErrors.some((value) => typeof value !== 'string' || value.length > 300))) return false
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

type Evaluation = { candidate: ScanCandidate; decision: ReturnType<typeof decideEntry> }
type ScanContext = { scanId: string; sessionId: string; triggerSource: string; startedAt: Date; durationMs: number }
type ScanOutcome = { status: 'completed' | 'failed'; scannedCandidates: number; buyCandidates: number; error?: string }

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

async function persistWorkerActivity(evaluations: Evaluation[], context: ScanContext) {
  let persistenceWarning: string | null = null
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
        decision: decision.action === 'buy' ? 'enter' : 'watch',
        scanned_at: context.startedAt.toISOString(),
        last_trade_at: candidate.lastTradeAt ?? null,
        spread_pct: candidate.spreadPct ?? null,
        trigger_source: context.triggerSource,
        scan_duration_ms: context.durationMs,
        metadata: {
          source: context.triggerSource,
          strategy: 'rules-engine-paper-v1',
          floatSource: candidate.floatSource ?? null,
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

  const buyCount = evaluations.filter(({ decision }) => decision.action === 'buy').length
  try {
    await writeScanEvent(
      'STRATEGY_SCAN',
      `Evaluated ${evaluations.length} symbols; ${buyCount} passed paper guardrails. No orders were submitted.`,
      context,
      { scannedCandidates: evaluations.length, buyCandidates: buyCount, scanDurationMs: context.durationMs },
    )
  } catch (error) {
    persistenceWarning ??= error instanceof Error ? error.message : 'Supabase scan completion event could not be written'
  }
  return persistenceWarning
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
  if (!isTradingWindow(now) && !isFlattenWindow(now)) return NextResponse.json({ status: 'sleeping', mode: 'paper', checkedAt: now.toISOString() })
  if (isFlattenWindow(now)) return NextResponse.json({ status: 'flatten_required', mode: 'paper', action: 'close_all_positions', checkedAt: now.toISOString() })
  if (!tradingConfig.supabaseUrl || !tradingConfig.supabaseKey) return NextResponse.json({ error: 'Internal paper-trading ledger is unavailable.' }, { status: 503 })

  const candidates = Array.isArray(body.candidates) ? body.candidates.filter(isValidCandidate) : []
  const triggerSource = safeTriggerSource(request.headers.get('x-trigger-source') ?? body.triggerSource)
  const scanId = validScanId(request.headers.get('x-scan-id') ?? body.scanId)
  const scanStartedAtValue = typeof body.scanStartedAt === 'string' ? new Date(body.scanStartedAt) : now
  const scanStartedAt = Number.isFinite(scanStartedAtValue.getTime()) && scanStartedAtValue <= now ? scanStartedAtValue : now
  const ownerToken = randomUUID()

  let leaseStatus: 'acquired' | 'busy' | 'cooldown'
  try {
    leaseStatus = await claimScanLease(ownerToken, scanConfig.leaseSeconds, expectedScanIntervalSeconds(now))
  } catch (error) {
    console.error('[worker] scan lease could not be acquired', { scanId, error })
    return NextResponse.json({ status: 'scan_lock_unavailable', error: 'Distributed scan lock is unavailable; no scan was run.' }, { status: 503 })
  }
  if (leaseStatus !== 'acquired') {
    return NextResponse.json({ status: leaseStatus === 'busy' ? 'overlap_skipped' : 'cadence_skipped', scanId, triggerSource }, { status: 202 })
  }

  let sessionId: string | null = null
  let outcome: ScanOutcome = { status: 'failed', scannedCandidates: candidates.length, buyCandidates: 0 }
  let persistenceWarning: string | null = null
  const context: Partial<ScanContext> = { scanId, triggerSource, startedAt: scanStartedAt }
  try {
    sessionId = await ensureScanSession(now)
    context.sessionId = sessionId
    await writeScanEvent('SCAN_STARTED', `Paper scan started for ${candidates.length} candidate(s).`, context, {
      startedAt: scanStartedAt.toISOString(),
      receivedAt: now.toISOString(),
    }).catch((error) => console.error('[worker] scan start event could not be written', { scanId, error }))

    const ledgerResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_papermoney?select=starting_balance,cash_balance,equity&account_name=eq.paper-main&is_active=eq.true&limit=1`, {
      headers: supabaseHeaders(),
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    })
    if (!ledgerResponse.ok) return NextResponse.json({ error: 'Internal paper-trading ledger could not be read.' }, { status: 503 })
    const ledger = await ledgerResponse.json() as Array<{ starting_balance?: number; cash_balance?: number; equity?: number }>
    const account = ledger[0]
    const startingBalance = Number(account?.starting_balance)
    const cashBalance = Number(account?.cash_balance)
    const equity = Math.min(Number(account?.equity ?? startingBalance), startingBalance)
    if (!Number.isFinite(equity) || equity <= 0 || !Number.isFinite(cashBalance) || cashBalance < 0) {
      return NextResponse.json({ error: 'Internal paper-trading ledger has no valid sizing balance.' }, { status: 503 })
    }

    const deployedCapital = Math.max(0, equity - cashBalance)
    const exposureLimit = equity * strategyGuardrails.maxAggregateExposureFraction
    let remainingAllocation = Math.max(0, Math.min(exposureLimit - deployedCapital, cashBalance))
    const evaluations: Evaluation[] = []
    for (const candidate of candidates) {
      const decision = decideEntry(candidate, equity, now, remainingAllocation)
      evaluations.push({ candidate, decision })
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
      if (decision.action !== 'hold') remainingAllocation = Math.max(0, remainingAllocation - decision.suggestedShares * candidate.price)
    }

    const buyCount = evaluations.filter(({ decision }) => decision.action === 'buy').length
    const durationMs = Math.max(0, Date.now() - scanStartedAt.getTime())
    const scanContext: ScanContext = { scanId, sessionId, triggerSource, startedAt: scanStartedAt, durationMs }
    persistenceWarning = await persistWorkerActivity(evaluations, scanContext)
    const notificationResults = body.notify && buyCount
      ? await sendTradingNotification({ title: 'AItrading paper scan', message: `${buyCount} paper decision(s) ready: ${evaluations.filter(({ decision }) => decision.action === 'buy').map(({ decision }) => `BUY ${decision.symbol}`).join(', ')}` })
      : []
    outcome = { status: 'completed', scannedCandidates: candidates.length, buyCandidates: buyCount }
    return NextResponse.json({
      status: 'paper_decisions_ready',
      mode: 'paper',
      checkedAt: now.toISOString(),
      scanId,
      triggerSource,
      scanDurationMs: durationMs,
      scannedCandidates: candidates.length,
      decisions: evaluations.filter(({ decision }) => decision.action !== 'hold').map(({ decision }) => decision),
      notificationResults,
      requiresOrderReview: true,
      liveTradingEnabled: false,
      ...(persistenceWarning ? { persistenceWarning } : {}),
    })
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : 'Unexpected scan failure'
    console.error('[worker] paper scan failed', { scanId, triggerSource, error })
    return NextResponse.json({ status: 'paper_scan_failed', error: 'The paper scan could not be completed.', scanId }, { status: 503 })
  } finally {
    const durationMs = Math.max(0, Date.now() - scanStartedAt.getTime())
    await writeScanEvent(
      outcome.status === 'completed' ? 'SCAN_COMPLETED' : 'SCAN_FAILED',
      outcome.status === 'completed' ? `Paper scan completed in ${durationMs}ms.` : `Paper scan failed after ${durationMs}ms.`,
      { ...context, sessionId: sessionId ?? undefined, durationMs },
      { startedAt: scanStartedAt.toISOString(), endedAt: new Date().toISOString(), scanDurationMs: durationMs, ...outcome },
    ).catch((error) => console.error('[worker] scan end event could not be written', { scanId, error }))
    await releaseScanLease(ownerToken).catch((error) => console.error('[worker] scan lease release failed', { scanId, error }))
  }
}
