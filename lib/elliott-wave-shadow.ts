import { alpacaHeaders, supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { easternFourAmStart } from '@/lib/scheduled-events'
import { strategyRegime, type ScanCandidate } from '@/lib/strategy'
import type { PaperMarketMark, PaperPosition } from '@/lib/paper-trading'
import {
  advanceShadowOutcome,
  analyzeElliottWave,
  createElliottSignalDrafts,
  createWaveState,
  type ElliottBar,
  type ElliottRegime,
  type ElliottAnalysisResult,
} from '@/lib/elliott-wave'
import { elliottWaveConfig } from '@/lib/elliott-wave-config'

const SHADOW_RULES = ['ew_wave3', 'ew_wave4'] as const

type ScanContext = { scanId: string; sessionId: string; now: Date }
type RealEntryLink = { positionId: string; tradeId: string }
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

async function loadOneMinuteBars(symbol: string, now: Date): Promise<ElliottBar[]> {
  const url = new URL(`${tradingConfig.alpacaDataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars`)
  url.search = new URLSearchParams({
    timeframe: '1Min',
    start: easternFourAmStart(now).toISOString(),
    end: now.toISOString(),
    limit: '10000',
    feed: tradingConfig.alpacaDataFeed,
    sort: 'asc',
  }).toString()
  const response = await fetch(url, { headers: alpacaHeaders(), signal: AbortSignal.timeout(8_000), cache: 'no-store' })
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

async function loadCandidateBars(candidates: ScanCandidate[], now: Date) {
  const output = new Map<string, ElliottBar[]>()
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (nextIndex < candidates.length) {
      const index = nextIndex++
      const candidate = candidates[index]
      output.set(candidate.symbol, await loadOneMinuteBars(candidate.symbol, now))
    }
  })
  await Promise.all(workers)
  return output
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

async function loadActiveSignals(sessionId: string, symbol: string) {
  const params = new URLSearchParams({
    select: 'id,symbol,rule,stop,t1,t2,triggered_at,would_be_shares,metadata',
    session_id: `eq.${sessionId}`,
    symbol: `eq.${symbol}`,
    rule: `in.(${SHADOW_RULES.join(',')})`,
    outcome: 'is.null',
    order: 'created_at.asc',
  })
  const response = await requestShadowTable(`ait_shadow_signals?${params}`)
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
  const signals = await loadActiveSignals(input.context.sessionId, input.symbol)
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
  marks: Map<string, PaperMarketMark>
  actualEntries: Map<string, RealEntryLink>
  actualExits?: Map<string, { exitReason: string; fillPrice: number; realizedPnl: number }>
  openPositions: PaperPosition[]
  equity: number
  currentExposure: number
  flatten: boolean
}) {
  if (!elliottWaveConfig.enabled || (!input.candidates.length && !input.openPositions.length)) return { analyzed: 0, signalsWritten: 0 }
  const candidateBySymbol = new Map(input.candidates.map((candidate) => [candidate.symbol, candidate]))
  for (const position of input.openPositions) {
    if (candidateBySymbol.has(position.symbol)) continue
    const mark = input.marks.get(position.symbol)
    const price = mark?.price ?? validNumber(position.current_price) ?? validNumber(position.entry_price) ?? 0
    candidateBySymbol.set(position.symbol, { symbol: position.symbol, price, relativeVolume: 0 })
  }
  const analysisCandidates = [...candidateBySymbol.values()]
  const barsBySymbol = await loadCandidateBars(analysisCandidates, input.context.now)
  const regime = strategyRegime(input.context.now)
  const regimeName = regime.name as ElliottRegime
  const openSymbols = new Set(input.openPositions.map((position) => position.symbol))
  let signalsWritten = 0

  for (const candidate of analysisCandidates) {
    const bars = barsBySymbol.get(candidate.symbol) ?? []
    const mark = input.marks.get(candidate.symbol)
    const analysis = analyzeElliottWave({
      bars,
      now: input.context.now,
      rvol: candidate.relativeVolume ?? 0,
      regimeRvol: regime.rvol,
    })
    await saveWaveState(input.context, candidate.symbol, analysis, regimeName)
    await advanceActiveSignals({ context: input.context, symbol: candidate.symbol, mark, analysis, flatten: input.flatten })
    if (!mark) continue

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
      await insertShadowDraft(input.context, candidate, regimeName, analysis, draft)
      signalsWritten += 1
    }
  }
  return { analyzed: barsBySymbol.size, signalsWritten }
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
