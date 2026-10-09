import { loadFreshPaperMarketMarks, type PaperMarketMark } from '@/lib/paper-trading'
import { strategyGuardrails } from '@/lib/strategy'
import { alpacaHeaders, supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import type { StrategyDecision, StrategyId } from './live-strategy'

export const SHADOW_STRATEGY_RULE = 'strategy_a'
export const SHADOW_TARGET_R = 1.5

export type ShadowOutcome = 'stop' | 't1' | 'flatten'

export type OpenShadowRow = { id: string; symbol: string; stop: number; t1: number; trigger_price: number; would_be_shares: number; metadata: Record<string, unknown> }

export type ShadowEntryCandidate = {
  symbol: string
  ask: number
  liveDecision: StrategyDecision
  shadowDecision: StrategyDecision
}

export type ShadowLimits = {
  maxOpenPositions: number
  maxPositionFraction: number
  maxAggregateExposureFraction: number
  maxDailyLossFraction: number
  reentryCooldownMinutes: number
}

export const shadowLimits: ShadowLimits = {
  maxOpenPositions: strategyGuardrails.maxOpenPositions,
  maxPositionFraction: strategyGuardrails.maxPositionFraction,
  maxAggregateExposureFraction: strategyGuardrails.maxAggregateExposureFraction,
  maxDailyLossFraction: strategyGuardrails.maxDailyLossFraction,
  reentryCooldownMinutes: strategyGuardrails.reentryCooldownMinutes,
}

export type ShadowLedgerRow = {
  symbol: string
  session_id: string
  outcome: string | null
  outcome_at: string | null
  trigger_price: number
  would_be_shares: number
  fill_price: number | null
}

export type ShadowLedger = {
  sessionStartEquity: number
  equity: number
  dailyPnl: number
  dailyLossStopped: boolean
  openSymbols: Set<string>
  openExposure: number
  lastStopAt: Map<string, number>
}

export type ShadowBlockReason = 'max_open_positions' | 'daily_loss_stop' | 'reentry_cooldown' | 'exposure_cap' | 'symbol_already_open'

/** Pure: resolve a simulated shadow position against the latest mark, using the same stop/target/flatten rules as the paper ledger. */
export function resolveShadowOutcome(row: Pick<OpenShadowRow, 'stop' | 't1' | 'trigger_price'>, mark: Pick<PaperMarketMark, 'bid'>, flatten: boolean, slippageFraction: number) {
  const exitFill = mark.bid * (1 - slippageFraction)
  const risk = row.trigger_price - row.stop
  const outcome: ShadowOutcome | null = mark.bid <= row.stop ? 'stop' : mark.bid >= row.t1 ? 't1' : flatten ? 'flatten' : null
  if (!outcome) return null
  return { outcome, fillPrice: exitFill, rMultiple: risk > 0 ? (exitFill - row.trigger_price) / risk : 0 }
}

/** Pure: shadow entry levels for an A decision, matching the live entry's fill/stop/target math. */
export function shadowEntryLevels(ask: number, riskPerShare: number, slippageFraction: number) {
  const fill = ask * (1 + slippageFraction)
  return { fill, stop: Math.max(0.01, fill - riskPerShare), t1: fill + riskPerShare * SHADOW_TARGET_R }
}

/**
 * Pure: the shadow strategy's own simulated ledger. Equity starts from the paper account's starting balance and
 * moves only with shadow P&L, so shadow A is sized and limited independently of the live strategy.
 */
export function buildShadowLedger(input: {
  rows: ShadowLedgerRow[]
  sessionId: string
  startingBalance: number
  marks: Map<string, Pick<PaperMarketMark, 'bid'>>
  slippageFraction: number
  limits?: ShadowLimits
}): ShadowLedger {
  const limits = input.limits ?? shadowLimits
  let priorRealized = 0
  let sessionRealized = 0
  let unrealized = 0
  let openExposure = 0
  const openSymbols = new Set<string>()
  const lastStopAt = new Map<string, number>()
  for (const row of input.rows) {
    if (row.outcome == null) {
      if (row.session_id !== input.sessionId) continue
      openSymbols.add(row.symbol)
      openExposure += row.trigger_price * row.would_be_shares
      const mark = input.marks.get(row.symbol)
      if (mark) unrealized += (mark.bid * (1 - input.slippageFraction) - row.trigger_price) * row.would_be_shares
      continue
    }
    const pnl = ((row.fill_price ?? row.trigger_price) - row.trigger_price) * row.would_be_shares
    if (row.session_id === input.sessionId) {
      sessionRealized += pnl
      if (row.outcome === 'stop' && row.outcome_at) {
        const at = Date.parse(row.outcome_at)
        if (Number.isFinite(at)) lastStopAt.set(row.symbol, Math.max(lastStopAt.get(row.symbol) ?? 0, at))
      }
    } else {
      priorRealized += pnl
    }
  }
  const sessionStartEquity = input.startingBalance + priorRealized
  const dailyPnl = sessionRealized + unrealized
  return {
    sessionStartEquity,
    equity: sessionStartEquity + dailyPnl,
    dailyPnl,
    dailyLossStopped: dailyPnl <= -limits.maxDailyLossFraction * sessionStartEquity,
    openSymbols,
    openExposure,
    lastStopAt,
  }
}

/** Pure: capital A could still deploy on its shadow ledger this scan (0 once its daily loss stop or position cap is hit). */
export function shadowAvailableAllocation(ledger: ShadowLedger, limits: ShadowLimits = shadowLimits) {
  if (ledger.dailyLossStopped || ledger.openSymbols.size >= limits.maxOpenPositions) return 0
  return Math.max(0, ledger.equity * limits.maxAggregateExposureFraction - ledger.openExposure)
}

/**
 * Pure: apply A's real limits (max positions, per-position and aggregate exposure caps, re-entry cooldown after a
 * stop, daily loss stop) to one would-be entry. Mutates the ledger when the entry is admitted.
 */
export function admitShadowEntry(ledger: ShadowLedger, entry: { symbol: string; fill: number; shares: number; now: Date }, limits: ShadowLimits = shadowLimits):
  { admitted: true; shares: number } | { admitted: false; blockedBy: ShadowBlockReason } {
  if (ledger.dailyLossStopped) return { admitted: false, blockedBy: 'daily_loss_stop' }
  if (ledger.openSymbols.has(entry.symbol)) return { admitted: false, blockedBy: 'symbol_already_open' }
  if (ledger.openSymbols.size >= limits.maxOpenPositions) return { admitted: false, blockedBy: 'max_open_positions' }
  const lastStop = ledger.lastStopAt.get(entry.symbol)
  if (lastStop != null && entry.now.getTime() - lastStop < limits.reentryCooldownMinutes * 60_000) return { admitted: false, blockedBy: 'reentry_cooldown' }
  const positionCap = ledger.equity * limits.maxPositionFraction
  const aggregateRoom = Math.max(0, ledger.equity * limits.maxAggregateExposureFraction - ledger.openExposure)
  const shares = Math.floor(Math.min(entry.shares, positionCap / entry.fill, aggregateRoom / entry.fill))
  if (!(shares >= 1)) return { admitted: false, blockedBy: 'exposure_cap' }
  ledger.openSymbols.add(entry.symbol)
  ledger.openExposure += shares * entry.fill
  return { admitted: true, shares }
}

async function shadowRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...supabaseHeaders(), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Shadow strategy persistence failed (${response.status})`)
  return response
}

export async function loadOpenShadowRows(sessionId: string): Promise<OpenShadowRow[]> {
  const params = new URLSearchParams({
    select: 'id,symbol,stop,t1,trigger_price,would_be_shares,metadata',
    session_id: `eq.${sessionId}`,
    rule: `eq.${SHADOW_STRATEGY_RULE}`,
    outcome: 'is.null',
  })
  const rows = await (await shadowRequest(`ait_shadow_signals?${params}`)).json() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    symbol: String(row.symbol),
    stop: Number(row.stop),
    t1: Number(row.t1),
    trigger_price: Number(row.trigger_price),
    would_be_shares: Number(row.would_be_shares),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }))
}

async function loadShadowLedgerRows(): Promise<ShadowLedgerRow[]> {
  const pageSize = 1_000
  const rows: ShadowLedgerRow[] = []
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({
      select: 'symbol,session_id,outcome,outcome_at,trigger_price,would_be_shares,fill_price',
      rule: `eq.${SHADOW_STRATEGY_RULE}`,
      order: 'id.asc',
      limit: String(pageSize),
      offset: String(offset),
    })
    const page = await (await shadowRequest(`ait_shadow_signals?${params}`)).json() as Array<Record<string, unknown>>
    for (const row of page) {
      rows.push({
        symbol: String(row.symbol),
        session_id: String(row.session_id),
        outcome: row.outcome == null ? null : String(row.outcome),
        outcome_at: row.outcome_at == null ? null : String(row.outcome_at),
        trigger_price: Number(row.trigger_price),
        would_be_shares: Number(row.would_be_shares),
        fill_price: row.fill_price == null ? null : Number(row.fill_price),
      })
    }
    if (page.length < pageSize) return rows
  }
}

export async function loadShadowLedger(input: { sessionId: string; startingBalance: number; marks: Map<string, PaperMarketMark>; slippageFraction: number }) {
  return buildShadowLedger({ ...input, rows: await loadShadowLedgerRows() })
}

/** Latest bid per symbol, falling back to the last trade when the quote is missing. Used only to resolve the 15:55 flatten. */
async function loadFlattenPrices(symbols: string[]) {
  const prices = new Map<string, { bid: number; source: 'latest_bid' | 'last_trade' }>()
  const unique = [...new Set(symbols)]
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50)
    const url = new URL(`${tradingConfig.alpacaDataUrl}/v2/stocks/snapshots`)
    url.search = new URLSearchParams({ symbols: batch.join(','), feed: tradingConfig.alpacaDataFeed }).toString()
    let snapshots: Record<string, { latestQuote?: { bp?: number }; latestTrade?: { p?: number } }> | null = null
    for (let attempt = 0; attempt < 3 && !snapshots; attempt += 1) {
      const response = await fetch(url, { headers: alpacaHeaders(), signal: AbortSignal.timeout(8_000), cache: 'no-store' }).catch(() => null)
      if (response?.ok) snapshots = await response.json()
    }
    if (!snapshots) continue
    for (const symbol of batch) {
      const bid = Number(snapshots[symbol]?.latestQuote?.bp)
      const trade = Number(snapshots[symbol]?.latestTrade?.p)
      if (Number.isFinite(bid) && bid > 0) prices.set(symbol, { bid, source: 'latest_bid' })
      else if (Number.isFinite(trade) && trade > 0) prices.set(symbol, { bid: trade, source: 'last_trade' })
    }
  }
  return prices
}

/**
 * Fresh marks for every open shadow symbol, fetched independently of the scan candidate list (and its 50-symbol cap)
 * so shadow positions keep being managed after the symbol drops out of the scan.
 */
export async function loadShadowMarks(openRows: OpenShadowRow[], scanMarks: Map<string, PaperMarketMark>, now: Date) {
  const marks = new Map(scanMarks)
  const missing = [...new Set(openRows.map((row) => row.symbol))].filter((symbol) => !marks.has(symbol))
  for (let index = 0; index < missing.length; index += 50) {
    const fresh = await loadFreshPaperMarketMarks(missing.slice(index, index + 50), now)
    for (const [symbol, mark] of fresh) marks.set(symbol, mark)
  }
  return marks
}

export type ShadowResolutionStats = { resolved: number; stillOpen: number; flattenFallbackLastTrade: number; flattenUnpriced: number }

/** Resolves open shadow positions. During the flatten window every open row is closed so none carry past the session. */
export async function resolveShadowPositions(input: {
  openRows: OpenShadowRow[]
  now: Date
  flatten: boolean
  slippageFraction: number
  marks: Map<string, PaperMarketMark>
}): Promise<ShadowResolutionStats> {
  const stats: ShadowResolutionStats = { resolved: 0, stillOpen: 0, flattenFallbackLastTrade: 0, flattenUnpriced: 0 }
  const unmarked = input.openRows.filter((row) => !input.marks.has(row.symbol)).map((row) => row.symbol)
  const flattenPrices = input.flatten && unmarked.length ? await loadFlattenPrices(unmarked) : new Map<string, { bid: number; source: 'latest_bid' | 'last_trade' }>()

  for (const row of input.openRows) {
    const fresh = input.marks.get(row.symbol)
    const fallback = fresh ? null : flattenPrices.get(row.symbol)
    let exitBid = fresh?.bid ?? fallback?.bid
    let priceSource: string = fresh ? 'fresh_quote' : fallback?.source ?? 'none'
    if (exitBid == null) {
      if (!input.flatten) {
        stats.stillOpen += 1
        continue
      }
      exitBid = row.trigger_price
      priceSource = 'unpriced_entry_price'
      stats.flattenUnpriced += 1
    }
    if (priceSource === 'last_trade') stats.flattenFallbackLastTrade += 1
    const resolution = resolveShadowOutcome(row, { bid: exitBid }, input.flatten, priceSource === 'unpriced_entry_price' ? 0 : input.slippageFraction)
    if (!resolution) {
      stats.stillOpen += 1
      continue
    }
    await shadowRequest(`ait_shadow_signals?${new URLSearchParams({ id: `eq.${row.id}` })}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        outcome: resolution.outcome,
        outcome_at: input.now.toISOString(),
        fill_price: resolution.fillPrice,
        r_multiple: resolution.rMultiple,
        metadata: { ...row.metadata, pnl: (resolution.fillPrice - row.trigger_price) * row.would_be_shares, exitBid, exitPriceSource: priceSource },
        updated_at: input.now.toISOString(),
      }),
    })
    stats.resolved += 1
  }
  return stats
}

export type ShadowStrategyStats = ShadowResolutionStats & {
  strategy: StrategyId
  opened: number
  skippedOpen: number
  blocked: Partial<Record<ShadowBlockReason, number>>
  equity: number | null
  dailyPnl: number | null
  dailyLossStopped: boolean
}

/** Records the entries the shadow strategy would have taken after applying its own ledger limits. Never places orders. */
export async function openShadowEntries(input: {
  strategy: StrategyId
  scanId: string
  sessionId: string
  now: Date
  regime: string
  slippageFraction: number
  ledger: ShadowLedger
  entries: ShadowEntryCandidate[]
}) {
  const result = { opened: 0, skippedOpen: 0, blocked: {} as Partial<Record<ShadowBlockReason, number>> }
  for (const entry of input.entries) {
    if (entry.shadowDecision.action !== 'enter' || entry.shadowDecision.suggestedShares <= 0) continue
    const levels = shadowEntryLevels(entry.ask, entry.shadowDecision.riskPerShare, input.slippageFraction)
    const admission = admitShadowEntry(input.ledger, { symbol: entry.symbol, fill: levels.fill, shares: entry.shadowDecision.suggestedShares, now: input.now })
    if (!admission.admitted) {
      if (admission.blockedBy === 'symbol_already_open') result.skippedOpen += 1
      else result.blocked[admission.blockedBy] = (result.blocked[admission.blockedBy] ?? 0) + 1
      continue
    }
    await shadowRequest('ait_shadow_signals?on_conflict=signal_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        signal_key: `${input.sessionId}:${entry.symbol}:${SHADOW_STRATEGY_RULE}:${input.scanId}`,
        symbol: entry.symbol,
        scan_id: input.scanId,
        session_id: input.sessionId,
        rule: SHADOW_STRATEGY_RULE,
        regime: input.regime,
        wave_confidence: 0,
        trigger_price: levels.fill,
        stop: levels.stop,
        t1: levels.t1,
        would_be_shares: admission.shares,
        triggered_at: input.now.toISOString(),
        metadata: {
          strategy: input.strategy,
          observedAsk: entry.ask,
          riskPerShare: entry.shadowDecision.riskPerShare,
          confidence: entry.shadowDecision.confidence,
          decisionShares: entry.shadowDecision.suggestedShares,
          shadowEquity: input.ledger.equity,
          liveStrategy: entry.liveDecision.strategy,
          liveAction: entry.liveDecision.action,
          liveBlockedBy: entry.liveDecision.blockedBy ?? null,
        },
      }),
    })
    result.opened += 1
  }
  return result
}
