import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { sendTradingNotification } from '@/lib/notifications'
import { recordScheduleEvent, scheduleWindowAction } from '@/lib/scheduled-events'
import { decideEntry, isFlattenWindow, isTradingWindow, normalizeFloatShares, scoreCandidate, strategyGuardrails, type ScanCandidate } from '@/lib/strategy'

export const dynamic = 'force-dynamic'

function isValidCandidate(value: unknown): value is ScanCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ScanCandidate>
  if (typeof candidate.symbol !== 'string' || !/^[A-Z]{1,5}$/.test(candidate.symbol) || typeof candidate.price !== 'number' || !Number.isFinite(candidate.price) || candidate.price <= 0) return false
  const numericFields = [candidate.bid, candidate.ask, candidate.volume, candidate.averageVolume, candidate.float, candidate.changePercent, candidate.vwap, candidate.atr, candidate.socialScore, candidate.relativeVolume]
  if (numericFields.some((field) => field !== undefined && (typeof field !== 'number' || !Number.isFinite(field)))) return false
  if (candidate.floatSource !== undefined && candidate.floatSource !== 'fmp' && candidate.floatSource !== 'finnhub') return false
  const textFields = [candidate.companyName, candidate.catalystType, candidate.catalystSummary]
  if (textFields.some((field) => field !== undefined && (typeof field !== 'string' || field.length > 500))) return false
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

async function persistWorkerActivity(evaluations: Evaluation[], checkedAt: Date) {
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
      }).filter(([, value]) => value == null).map(([field]) => field)

      return {
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
        score: scoreCandidate(candidate, checkedAt),
        decision: decision.action === 'buy' ? 'enter' : 'watch',
        scanned_at: checkedAt.toISOString(),
        metadata: {
          source: 'paper-strategy-worker',
          strategy: 'rules-engine-paper-v1',
          floatSource: candidate.floatSource ?? null,
          missingEnrichmentFields,
          riskPerShare: decision.riskPerShare,
          suggestedShares: decision.suggestedShares,
        },
      }
    })
    const scansResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_watchlist_scans`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(scanRows),
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    })
    if (!scansResponse.ok) persistenceWarning = `Supabase enriched scan write failed (${scansResponse.status})`
  }

  const persistedEvaluations = evaluations.filter(({ candidate }) => candidate.symbol !== 'AMZN')
  if (persistedEvaluations.length) {
    const signalsResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_strategy_signals`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(persistedEvaluations.map(({ candidate, decision }) => ({
        symbol: candidate.symbol,
        action: decision.action,
        confidence: Math.max(0, Math.min(100, Math.round(decision.confidence * 100))),
        rationale: decision.reason,
        model: 'rules-engine-paper-v1',
        features: { source: 'paper-strategy-worker', price: candidate.price, riskPerShare: decision.riskPerShare, suggestedShares: decision.suggestedShares },
        created_at: checkedAt.toISOString(),
      }))),
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    })
    if (!signalsResponse.ok) persistenceWarning = `Supabase strategy-signal write failed (${signalsResponse.status})`
  }

  const recentEventUrl = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`)
  recentEventUrl.search = new URLSearchParams({
    select: 'id',
    event_type: 'eq.STRATEGY_SCAN',
    created_at: `gte.${new Date(checkedAt.getTime() - 5 * 60 * 1000).toISOString()}`,
    limit: '1',
  }).toString()
  const recentEventResponse = await fetch(recentEventUrl, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5000), cache: 'no-store' })
  if (!recentEventResponse.ok) return persistenceWarning ?? `Supabase strategy-event check failed (${recentEventResponse.status})`
  const recentEvents = await recentEventResponse.json() as Array<{ id: number }>
  if (recentEvents.length) return persistenceWarning

  const buyCount = evaluations.filter(({ decision }) => decision.action === 'buy').length
  const eventResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      level: buyCount ? 'success' : 'info',
      event_type: 'STRATEGY_SCAN',
      message: `Evaluated ${evaluations.length} symbols; ${buyCount} passed paper guardrails. No orders were submitted.`,
      payload: { evaluated: evaluations.length, persistedSignals: persistedEvaluations.length, omittedAmznSignals: evaluations.length - persistedEvaluations.length, buyCandidates: buyCount },
      created_at: checkedAt.toISOString(),
    }),
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  })
  if (!eventResponse.ok) return persistenceWarning ?? `Supabase strategy-event write failed (${eventResponse.status})`
  return persistenceWarning
}


export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (tradingConfig.mode !== 'paper' || strategyGuardrails.liveTradingEnabled) return NextResponse.json({ error: 'Live execution is disabled by guardrails.' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const now = new Date()
  const scheduleAction = scheduleWindowAction(now)
  if (scheduleAction) {
    try {
      await recordScheduleEvent(scheduleAction, now)
    } catch (error) {
      console.error('[worker] scheduled system event could not be recorded', error)
    }
  }
  if (!isTradingWindow(now) && !isFlattenWindow(now)) return NextResponse.json({ status: 'sleeping', mode: 'paper', checkedAt: now.toISOString() })
  if (isFlattenWindow(now)) return NextResponse.json({ status: 'flatten_required', mode: 'paper', action: 'close_all_positions', checkedAt: now.toISOString() })
  if (!tradingConfig.supabaseUrl || !tradingConfig.supabaseKey) {
    return NextResponse.json({ error: 'Internal paper-trading ledger is unavailable.' }, { status: 503 })
  }
  const ledgerResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_papermoney?select=starting_balance,cash_balance,equity&account_name=eq.paper-main&is_active=eq.true&limit=1`, {
    headers: supabaseHeaders(),
    cache: 'no-store',
  })
  if (!ledgerResponse.ok) return NextResponse.json({ error: 'Internal paper-trading ledger could not be read.' }, { status: 503 })
  const ledger = (await ledgerResponse.json()) as Array<{ starting_balance?: number; cash_balance?: number; equity?: number }>
  const account = ledger[0]
  const startingBalance = Number(account?.starting_balance)
  const cashBalance = Number(account?.cash_balance)
  const equity = Math.min(Number(account?.equity ?? startingBalance), startingBalance)
  if (!Number.isFinite(equity) || equity <= 0 || !Number.isFinite(cashBalance) || cashBalance < 0) return NextResponse.json({ error: 'Internal paper-trading ledger has no valid sizing balance.' }, { status: 503 })

  const deployedCapital = Math.max(0, equity - cashBalance)
  const exposureLimit = equity * strategyGuardrails.maxAggregateExposureFraction
  let remainingAllocation = Math.max(0, Math.min(exposureLimit - deployedCapital, cashBalance))
  const candidates = Array.isArray(body.candidates) ? body.candidates.filter(isValidCandidate) : []
  const decisions: Array<ReturnType<typeof decideEntry>> = []
  const evaluations: Evaluation[] = []
  for (const candidate of candidates) {
    const decision = decideEntry(candidate, equity, now, remainingAllocation)
    evaluations.push({ candidate, decision })
    console.info('[worker] strategy decision', {
      symbol: candidate.symbol,
      action: decision.action,
      floatSource: candidate.floatSource ?? 'missing',
      floatShares: candidate.float ?? null,
      normalizedFloatShares: candidate.float == null ? null : normalizeFloatShares(candidate.float, candidate.floatSource),
      remainingAllocation,
    })
    if (decision.action !== 'hold') {
      remainingAllocation = Math.max(0, remainingAllocation - decision.suggestedShares * candidate.price)
      decisions.push(decision)
    }
  }
  const persistenceWarning = await persistWorkerActivity(evaluations, now)
  const notificationResults = body.notify && decisions.length
    ? await sendTradingNotification({ title: 'AItrading paper scan', message: `${decisions.length} paper decision(s) ready: ${decisions.map((decision) => `${decision.action.toUpperCase()} ${decision.symbol}`).join(', ')}` })
    : []
  return NextResponse.json({ status: 'paper_decisions_ready', mode: 'paper', checkedAt: now.toISOString(), decisions, notificationResults, requiresOrderReview: true, ...(persistenceWarning ? { persistenceWarning } : {}) })
}
