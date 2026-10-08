import { alpacaHeaders, supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { easternFourAmStart } from '@/lib/scheduled-events'
import { strategyRegime, type ScanCandidate } from '@/lib/strategy'
import type { PaperMarketMark, PaperPosition } from '@/lib/paper-trading'
import {
  advanceShadowOutcome,
  analyzeElliottWave,
  createElliottSignalDrafts,
  type ElliottBar,
  type ElliottRegime,
  type ElliottAnalysisResult,
} from '@/lib/elliott-wave'
import { elliottWaveConfig } from '@/lib/elliott-wave-config'

const SHADOW_RULES = ['ew_wave3', 'ew_wave4'] as const

type ScanContext = { scanId: string; sessionId: string; now: Date; signal?: AbortSignal }
type RealEntryLink = { positionId: string; tradeId: string }
type BarCacheEntry = { bars: ElliottBar[]; fetchedMinute: number }
type TrackedWaveCandidate = { candidate: ScanCandidate; startedAt: number }

const sessionBarCaches = new Map<string, Map<string, BarCacheEntry>>()
const trackedWaveCandidates = new Map<string, Map<string, TrackedWaveCandidate>>()

export function mergeIncrementalBars(previous: ElliottBar[], incoming: ElliottBar[]) {
  const barsByTime = new Map(previous.map((bar) => [bar.t, bar]))
  for (const bar of incoming) barsByTime.set(bar.t, bar)
  return [...barsByTime.values()].sort((left, right) => Date.parse(left.t) - Date.parse(right.t))
}

export function isBarCacheFresh(entry: Pick<BarCacheEntry, 'fetchedMinute'> | undefined, now: Date) {
  return entry?.fetchedMinute === Math.floor(now.getTime() / 60_000)
}

export function updateTrackedWaveCandidates(input: {
  tracked: Map<string, TrackedWaveCandidate>
  eligibleCandidates: ScanCandidate[]
  observedCandidates?: ScanCandidate[]
  now: Date
  invalidatedSymbols?: string[]
}) {
  const cutoff = input.now.getTime() - elliottWaveConfig.trackingWindowMinutes * 60_000
  for (const [symbol, tracked] of input.tracked) {
    if (tracked.startedAt <= cutoff || input.invalidatedSymbols?.includes(symbol)) input.tracked.delete(symbol)
  }
  for (const candidate of input.observedCandidates ?? []) {
    const tracked = input.tracked.get(candidate.symbol)
    if (tracked) input.tracked.set(candidate.symbol, { ...tracked, candidate })
  }
  for (const candidate of input.eligibleCandidates) {
    const tracked = input.tracked.get(candidate.symbol)
    input.tracked.set(candidate.symbol, { candidate, startedAt: tracked?.startedAt ?? input.now.getTime() })
  }
  return [...input.tracked.values()].map(({ candidate }) => candidate)
}
type ShadowSignalRow = {
  id: string
  symbol: string
  rule: 'ew_wave3' | 'ew_wave4' | 'ew_block_wave5' | 'ew_exit_signal'
  stop: number | null
  t1: number | null
  t2: number | null
  triggered_at: string | null
  would_be_shares: number
  metadata: Record<string, unknown>
}

function validNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function loadOneMinuteBars(symbol: string, now: Date, start: Date, signal: AbortSignal): Promise<ElliottBar[]> {
  const url = new URL(`${tradingConfig.alpacaDataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars`)
  url.search = new URLSearchParams({
    timeframe: '1Min',
    start: start.toISOString(),
    end: now.toISOString(),
    limit: '10000',
    feed: tradingConfig.alpacaDataFeed,
    sort: 'asc',
  }).toString()
  const response = await fetch(url, { headers: alpacaHeaders(), signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]), cache: 'no-store' })
  if (!response.ok) throw new Error(`Alpaca one-minute bars unavailable for ${symbol} (${response.status})`)
  const payload = await response.json() as { bars?: Array<{ t: string; h: number; l: number; c: number; v: number; vw?: number }> }
  return (payload.bars ?? []).filter((bar) => typeof bar.t === 'string').map((bar) => ({
    t: bar.t,
    h: Number(bar.h),
    l: Number(bar.l),
    c: Number(bar.c),
    v: Number(bar.v),
    vw: validNumber(bar.vw),
  }))
}

function getSessionBarCache(sessionId: string) {
  for (const cachedSession of sessionBarCaches.keys()) {
    if (cachedSession !== sessionId) sessionBarCaches.delete(cachedSession)
  }
  const cache = sessionBarCaches.get(sessionId) ?? new Map<string, BarCacheEntry>()
  sessionBarCaches.set(sessionId, cache)
  return cache
}

async function loadCachedCandidateBars(candidates: ScanCandidate[], sessionId: string, now: Date, signal: AbortSignal) {
  const cache = getSessionBarCache(sessionId)
  const output = new Map<string, ElliottBar[]>()
  let nextIndex = 0
  let requests = 0
  const failures: Error[] = []
  const currentMinute = Math.floor(now.getTime() / 60_000)
  const workers = Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (nextIndex < candidates.length && !signal.aborted) {
      const candidate = candidates[nextIndex++]
      const cached = cache.get(candidate.symbol)
      if (cached && isBarCacheFresh(cached, now)) {
        output.set(candidate.symbol, cached.bars)
        continue
      }
      requests += 1
      try {
        const start = cached?.bars.at(-1)?.t ? new Date(cached.bars.at(-1)!.t) : easternFourAmStart(now)
        const incoming = await loadOneMinuteBars(candidate.symbol, now, start, signal)
        if (signal.aborted) break
        const bars = mergeIncrementalBars(cached?.bars ?? [], incoming)
        cache.set(candidate.symbol, { bars, fetchedMinute: currentMinute })
        output.set(candidate.symbol, bars)
      } catch (error) {
        if (signal.aborted) break
        failures.push(error instanceof Error ? error : new Error(`Alpaca bars unavailable for ${candidate.symbol}`))
      }
    }
  })
  await Promise.all(workers)
  if (failures.length) throw failures[0]
  return { barsBySymbol: output, requests }
}

async function requestShadowTable(path: string, init?: RequestInit) {
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...supabaseHeaders(), ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(8_000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase Elliott Wave persistence failed (${response.status})`)
  return response
}

async function saveWaveState(context: ScanContext, symbol: string, analysis: ElliottAnalysisResult, regime: ElliottRegime) {
  const params = new URLSearchParams({ on_conflict: 'session_id,symbol' })
  await requestShadowTable(`ait_elliott_wave_state?${params}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    signal: context.signal,
    body: JSON.stringify({
      session_id: context.sessionId,
      symbol,
      scan_id: context.scanId,
      regime,
      current_wave: analysis.currentWave,
      pivots: analysis.pivots,
      invalidation_level: analysis.invalidationLevel,
      invalidation_reason: analysis.invalidationReason,
      wave_confidence: analysis.waveConfidence,
      wave5_exhaustion: analysis.exhaustion,
      valid: analysis.valid,
      updated_at: context.now.toISOString(),
    }),
  })
}

async function loadActiveSignals(sessionId: string, symbol: string, signal?: AbortSignal) {
  const params = new URLSearchParams({
    select: 'id,symbol,rule,stop,t1,t2,triggered_at,would_be_shares,metadata',
    session_id: `eq.${sessionId}`,
    symbol: `eq.${symbol}`,
    rule: `in.(${SHADOW_RULES.join(',')})`,
    outcome: 'is.null',
    order: 'created_at.asc',
  })
  const response = await requestShadowTable(`ait_shadow_signals?${params}`, { signal })
  return await response.json() as ShadowSignalRow[]
}

async function advanceActiveSignals(input: {
  context: ScanContext
  symbol: string
  mark: PaperMarketMark | undefined
  analysis: ElliottAnalysisResult
  flatten: boolean
}) {
  if (!input.mark) return
  const signals = await loadActiveSignals(input.context.sessionId, input.symbol, input.context.signal)
  for (const row of signals) {
    const update = advanceShadowOutcome({
      signal: {
        stop: Number(row.stop ?? 0),
        t1: Number(row.t1 ?? 0),
        t2: Number(row.t2 ?? 0),
        triggered_at: row.triggered_at,
        would_be_shares: row.would_be_shares,
        metadata: row.metadata ?? {},
      },
      mark: input.mark,
      now: input.context.now,
      flatten: input.flatten,
      latestSwingLow: input.analysis.latestSwingLow,
    })
    const patchUrl = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_shadow_signals`)
    patchUrl.search = new URLSearchParams({ id: `eq.${row.id}` }).toString()
    await requestShadowTable(patchUrl.toString().replace(`${tradingConfig.supabaseUrl}/rest/v1/`, ''), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      signal: input.context.signal,
      body: JSON.stringify({
        outcome: update.outcome,
        outcome_at: update.outcomeAt,
        fill_price: update.fillPrice,
        r_multiple: update.rMultiple,
        metadata: update.metadata,
        updated_at: input.context.now.toISOString(),
      }),
    })
  }
}

async function insertShadowDraft(context: ScanContext, candidate: ScanCandidate, regime: ElliottRegime, analysis: ElliottAnalysisResult, draft: ReturnType<typeof createElliottSignalDrafts>[number]) {
  const timestampKey = typeof draft.metadata.linkedTradeId === 'string'
    ? draft.metadata.linkedTradeId
    : typeof draft.metadata.triggerBar === 'string'
      ? draft.metadata.triggerBar
      : typeof draft.metadata.setupAt === 'string'
        ? draft.metadata.setupAt
        : draft.triggeredAt ?? context.now.toISOString()
  const signalKey = `${context.sessionId}:${candidate.symbol}:${draft.rule}:${timestampKey}`
  const response = await requestShadowTable('ait_shadow_signals?on_conflict=signal_key', {
    method: 'POST',
    signal: context.signal,
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({
      signal_key: signalKey,
      symbol: candidate.symbol,
      scan_id: context.scanId,
      session_id: context.sessionId,
      trade_id: typeof draft.metadata.linkedTradeId === 'string' ? draft.metadata.linkedTradeId : null,
      rule: draft.rule,
      regime,
      wave_confidence: analysis.waveConfidence,
      pivots: analysis.impulsePivots,
      trigger_price: draft.triggerPrice,
      stop: draft.stop,
      t1: draft.t1,
      t2: draft.t2,
      would_be_shares: draft.wouldBeShares,
      triggered_at: draft.triggeredAt,
      outcome: draft.outcome,
      outcome_at: draft.outcomeAt,
      fill_price: draft.fillPrice,
      r_multiple: draft.rMultiple,
      metadata: draft.metadata,
    }),
  })
  return response
}

export async function runElliottShadowPass(input: {
  context: ScanContext
  candidates: ScanCandidate[]
  observedCandidates?: ScanCandidate[]
  marks: Map<string, PaperMarketMark>
  actualEntries: Map<string, RealEntryLink>
  actualExits?: Map<string, { exitReason: string; fillPrice: number; realizedPnl: number }>
  openPositions: PaperPosition[]
  equity: number
  currentExposure: number
  flatten: boolean
}) {
  if (!elliottWaveConfig.enabled) return { analyzed: 0, signalsWritten: 0, barRequests: 0, budgetExceeded: false }
  for (const sessionId of trackedWaveCandidates.keys()) {
    if (sessionId !== input.context.sessionId) trackedWaveCandidates.delete(sessionId)
  }
  const trackedForSession = trackedWaveCandidates.get(input.context.sessionId) ?? new Map<string, TrackedWaveCandidate>()
  trackedWaveCandidates.set(input.context.sessionId, trackedForSession)
  const trackedCandidates = updateTrackedWaveCandidates({
    tracked: trackedForSession,
    eligibleCandidates: input.candidates,
    observedCandidates: input.observedCandidates,
    now: input.context.now,
  })
  const candidateBySymbol = new Map(trackedCandidates.map((candidate) => [candidate.symbol, candidate]))
  for (const position of input.openPositions) {
    if (candidateBySymbol.has(position.symbol)) continue
    const mark = input.marks.get(position.symbol)
    const price = mark?.price ?? validNumber(position.current_price) ?? validNumber(position.entry_price) ?? 0
    candidateBySymbol.set(position.symbol, { symbol: position.symbol, price, relativeVolume: 0 })
  }
  const analysisCandidates = [...candidateBySymbol.values()]
  if (!analysisCandidates.length) return { analyzed: 0, signalsWritten: 0, barRequests: 0, budgetExceeded: false }

  const startedAt = Date.now()
  const budgetController = new AbortController()
  const budgetTimer = setTimeout(() => budgetController.abort(), elliottWaveConfig.shadowPassBudgetMs)
  const context = { ...input.context, signal: budgetController.signal }
  const regime = strategyRegime(input.context.now)
  const regimeName = regime.name as ElliottRegime
  const openSymbols = new Set(input.openPositions.map((position) => position.symbol))
  let analyzed = 0
  let signalsWritten = 0
  let barRequests = 0

  try {
    const loaded = await loadCachedCandidateBars(analysisCandidates, input.context.sessionId, input.context.now, budgetController.signal)
    const barsBySymbol = loaded.barsBySymbol
    barRequests = loaded.requests

    for (const candidate of analysisCandidates) {
      if (Date.now() - startedAt >= elliottWaveConfig.shadowPassBudgetMs) budgetController.abort()
      if (budgetController.signal.aborted) break
      const bars = barsBySymbol.get(candidate.symbol) ?? []
      const mark = input.marks.get(candidate.symbol)
      const analysis = analyzeElliottWave({
        bars,
        now: input.context.now,
        rvol: candidate.relativeVolume ?? 0,
        regimeRvol: regime.rvol,
      })
      if (budgetController.signal.aborted) break
      await saveWaveState(context, candidate.symbol, analysis, regimeName)
      analyzed += 1
      await advanceActiveSignals({ context, symbol: candidate.symbol, mark, analysis, flatten: input.flatten })
      if (mark) {
        const actualEntry = input.actualEntries.get(candidate.symbol)
        const drafts = createElliottSignalDrafts({
          analysis,
          regime: regimeName,
          equity: input.equity,
          currentExposure: input.currentExposure,
          mark,
          now: input.context.now,
          actualEntry: Boolean(actualEntry),
          allowEntries: input.candidates.some((eligible) => eligible.symbol === candidate.symbol),
          linkedTradeId: actualEntry?.tradeId,
        })
        const actualExit = input.actualExits?.get(candidate.symbol)
        const allowedExitLogging = regimeName === 'exits-only' || openSymbols.has(candidate.symbol) || Boolean(actualExit)
        for (const draft of drafts) {
          if (budgetController.signal.aborted) break
          if (draft.rule === 'ew_exit_signal' && !allowedExitLogging) continue
          if (draft.rule === 'ew_exit_signal' && openSymbols.has(candidate.symbol)) {
            const position = input.openPositions.find((item) => item.symbol === candidate.symbol)
            draft.metadata.positionId = position?.id ?? null
            draft.metadata.realPositionOpenAtSignal = position?.opened_at ?? null
          }
          if (draft.rule === 'ew_exit_signal' && actualExit) {
            draft.metadata.realExit = { ...actualExit, at: input.context.now.toISOString() }
            draft.metadata.realExitDid = actualExit.exitReason
          }
          await insertShadowDraft(context, candidate, regimeName, analysis, draft)
          signalsWritten += 1
        }
      }
      if (analysis.invalidationReason) {
        updateTrackedWaveCandidates({ tracked: trackedForSession, eligibleCandidates: [], now: input.context.now, invalidatedSymbols: [candidate.symbol] })
      }
    }
  } catch (error) {
    if (!budgetController.signal.aborted) throw error
  } finally {
    clearTimeout(budgetTimer)
    if (budgetController.signal.aborted) {
      console.warn('elliott_budget_exceeded', {
        scanId: input.context.scanId,
        budgetMs: elliottWaveConfig.shadowPassBudgetMs,
        elapsedMs: Date.now() - startedAt,
        analyzed,
        barRequests,
      })
    }
  }

  return { analyzed, signalsWritten, barRequests, budgetExceeded: budgetController.signal.aborted }
}

export async function attachElliottRealExit(input: { positionId: string; symbol: string; exitReason: string; fillPrice: number; realizedPnl: number; at: Date }) {
  const params = new URLSearchParams({
    select: 'id,metadata',
    rule: 'eq.ew_exit_signal',
    outcome: 'is.null',
    'metadata->>positionId': `eq.${input.positionId}`,
    order: 'created_at.desc',
    limit: '1',
  })
  const response = await requestShadowTable(`ait_shadow_signals?${params}`)
  const [signal] = await response.json() as Array<{ id: string; metadata: Record<string, unknown> }>
  if (!signal) return false
  const patch = new URLSearchParams({ id: `eq.${signal.id}` })
  await requestShadowTable(`ait_shadow_signals?${patch}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      metadata: {
        ...signal.metadata,
        realExit: { exitReason: input.exitReason, fillPrice: input.fillPrice, realizedPnl: input.realizedPnl, at: input.at.toISOString() },
        realExitDid: input.exitReason,
      },
      updated_at: input.at.toISOString(),
    }),
  })
  return true
}

export function markFromShadowOutcome(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const mark = value as { bid?: unknown; ask?: unknown; price?: unknown; at?: unknown }
  const bid = validNumber(mark.bid)
  const ask = validNumber(mark.ask)
  const price = validNumber(mark.price)
  if (bid == null || ask == null || price == null || bid <= 0 || ask < bid || price <= 0) return null
  return { bid, ask, price, at: typeof mark.at === 'string' ? mark.at : '' }
}
