import { decideEntry, easternSchedule, strategyRegime, type ScanCandidate, type TradeDecision } from '@/lib/strategy'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { cleanMomentumBlockReason, type CleanMomentumBlock } from './clean-momentum'

export type StrategyId = 'A' | 'E'

const STRATEGY_IDS: ReadonlySet<string> = new Set(['A', 'E'])

export type StrategyConfig = { live: StrategyId; shadow: StrategyId | null; warnings: string[] }

/** STRATEGY_LIVE picks the strategy that places paper trades (default E; set 'A' to roll back). STRATEGY_SHADOW defaults to A. */
export function resolveStrategyConfig(env: Record<string, string | undefined> = process.env): StrategyConfig {
  const warnings: string[] = []
  const parse = (name: string, fallback: StrategyId): StrategyId => {
    const raw = env[name]?.trim().toUpperCase()
    if (!raw) return fallback
    if (STRATEGY_IDS.has(raw)) return raw as StrategyId
    warnings.push(`${name}=${JSON.stringify(env[name])} is not A or E; using ${fallback}`)
    return fallback
  }
  const live = parse('STRATEGY_LIVE', 'E')
  const shadow = parse('STRATEGY_SHADOW', 'A')
  return { live, shadow: shadow === live ? null : shadow, warnings }
}

export type SymbolDayHistory = { entries: number; firstEntryHitTarget: boolean }

export type StrategyEntryInput = {
  /** Candidate as delivered by the scanner (scan price and day gain). */
  scanCandidate: ScanCandidate
  /** Candidate re-priced at the fresh executable quote. */
  executable: ScanCandidate
  equity: number
  now: Date
  availableAllocation: number
  /** Today's entries in this symbol; null when the ledger lookup failed. */
  history: SymbolDayHistory | null
}

export type StrategyDecision = TradeDecision & { strategy: StrategyId; blockedBy?: CleanMomentumBlock | 'history_unavailable' }

function hold(base: TradeDecision, strategy: StrategyId, blockedBy: StrategyDecision['blockedBy']): StrategyDecision {
  return { ...base, action: 'hold', suggestedShares: 0, strategy, blockedBy, reason: `Strategy ${strategy} filter blocked entry (${blockedBy}).` }
}

export function decideStrategyEntry(strategy: StrategyId, input: StrategyEntryInput): StrategyDecision {
  const base = decideEntry(input.executable, input.equity, input.now, input.availableAllocation)
  if (strategy === 'A' || base.action !== 'enter') return { ...base, strategy }
  if (!input.history) return hold(base, strategy, 'history_unavailable')
  const blockedBy = cleanMomentumBlockReason({
    changePercent: input.scanCandidate.changePercent,
    price: input.scanCandidate.price,
    spreadPct: input.executable.spreadPct ?? Infinity,
    regime: strategyRegime(input.now).name,
    entryIndex: input.history.entries + 1,
    firstEntryHitTarget: input.history.firstEntryHitTarget,
  })
  return blockedBy ? hold(base, strategy, blockedBy) : { ...base, strategy }
}

export function easternDayStart(now: Date) {
  const minuteStart = now.getTime() - (now.getTime() % 60_000)
  return new Date(minuteStart - easternSchedule(now).minuteOfDay * 60_000)
}

type DayPositionRow = { symbol: string; opened_at: string; metadata: Record<string, unknown> | null }

export function summarizeSymbolDayHistory(rows: DayPositionRow[]) {
  const history = new Map<string, SymbolDayHistory>()
  const ordered = [...rows].sort((left, right) => Date.parse(left.opened_at) - Date.parse(right.opened_at))
  for (const row of ordered) {
    const current = history.get(row.symbol)
    if (current) current.entries += 1
    else history.set(row.symbol, { entries: 1, firstEntryHitTarget: row.metadata?.exitReason === 'profit target reached' })
  }
  return history
}

/** Paper positions opened today (ET) for the given symbols. Throws on ledger failure so E fails closed. */
export async function loadSymbolDayHistory(symbols: string[], now: Date) {
  const unique = [...new Set(symbols.filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)))]
  if (!unique.length) return new Map<string, SymbolDayHistory>()
  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_positions`)
  url.search = new URLSearchParams({
    select: 'symbol,opened_at,metadata',
    symbol: `in.(${unique.join(',')})`,
    opened_at: `gte.${easternDayStart(now).toISOString()}`,
    order: 'opened_at.asc',
  }).toString()
  const response = await fetch(url, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5_000), cache: 'no-store' })
  if (!response.ok) throw new Error(`Symbol day-history read failed (${response.status})`)
  return summarizeSymbolDayHistory(await response.json() as DayPositionRow[])
}
