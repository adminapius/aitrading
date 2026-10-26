// Shared fill and halt models (moved out of the archived Strategy R runner on Oct 25, 2026; values and logic
// unchanged, spec: docs/strategy-r-spec.md sections 6-7 and 8b). BACKTEST ONLY.
//  - halts: inferred from regular-hours minute-bar gaps (haltResumes)
//  - entry fills: quote-based, half the spread + $0.01, spread and risk bounds, size and volume caps (planEntry)
//  - exits: stop before target, entry-bar rule, halt resumption, sell price with half spread + $0.01 (exitOnBar, sellPrice)
import { RULEBOOK } from './rulebook/config'

export const R = {
  windows: { tuning: ['2024-10-14', '2026-07-31'], holdout: ['2026-08-01', '2026-10-16'] } as Record<'tuning' | 'holdout', [string, string]>,
  /** Entry windows by the entry fill bar's start, minutes after ET midnight, [from, to). */
  lines: { H1: [7 * 60, 11 * 60], H2: [7 * 60, 9 * 60 + 30], H3: [9 * 60 + 45, 11 * 60] } as Record<'H1' | 'H2' | 'H3', [number, number]>,
  maxFloat: 5_000_000,
  minPrice: 2,
  maxPrice: 20,
  minGain: 0.2,
  minVolume: 500_000, // shares since 04:00 (R4)
  newsMinutes: 120, // R3
  pullbackMaxBars: 5, // R6
  maxRetrace: 0.5, // R6
  minRisk: 0.02, // R8
  maxRiskPct: 0.1, // R8
  quoteLookbackSec: 120, // R11
  maxSpreadPct: 0.03, // R11, of the mid
  slippage: 0.01, // R11, on top of half the spread
  tick: 0.01,
  haltGapMinutes: 5, // R10: no bar for >= 5 consecutive minutes in regular hours
  haltPriorMinutes: 5, // ... after trading in each of the previous 5 minutes
  rthOpen: 9 * 60 + 30,
  equity: 2000, // probe sizing only (no P&L in the probe)
  riskPct: 0.01, // E's sizing: 1% of equity at risk
  positionPct: RULEBOOK.account.normal.positionValueCapPct,
  maxOpen: RULEBOOK.account.normal.maxOpenPositions,
  maxShareOfBarVolume: 0.1,
  maxShareOfDayVolume: 0.01,
  coverageFloor: 0.75, // section 2 (LOCKED Oct 25)
  minHoldoutTrades: 30, // R12 / R14
}
export type LineName = keyof typeof R.lines

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; vw: number }

/** Minute of the ET day for a bar start. Pure. */
export const minuteOf = (t: number, midnight: number) => Math.round((t - midnight) / 60_000)

/**
 * R10: indices of bars that resume trading after an inferred halt: both bars in regular hours, no bar for at least
 * 5 consecutive minutes in between, and a bar in each of the 5 minutes before the gap. Pure.
 */
export function haltResumes(bars: Bar[], midnight: number): Set<number> {
  const out = new Set<number>()
  const minutes = bars.map((b) => minuteOf(b.t, midnight))
  for (let i = 1; i < bars.length; i += 1) {
    const prev = minutes[i - 1], cur = minutes[i]
    if (prev < R.rthOpen || cur - prev - 1 < R.haltGapMinutes) continue
    let traded = true
    for (let k = 1; k < R.haltPriorMinutes; k += 1) if (minutes[i - 1 - k] !== prev - k) { traded = false; break }
    if (traded && i - R.haltPriorMinutes >= 0) out.add(i)
  }
  return out
}

export type Break = { i: number; minute: number; high: number; low: number; bars: number; trigger: number }

export type Plan = { fill: number; stop: number; risk: number; shares: number; spreadPct: number } | { skip: string; spreadPct?: number }

/** R11 / R8 / sizing at a break: quote rules, fill price, stop, risk bounds, size and volume caps. Pure. */
export function planEntry(br: Break, bar: Bar, quote: { bp: number; ap: number } | null, cumVolumeBefore: number, equity = R.equity): Plan {
  if (!quote || !(quote.bp > 0) || !(quote.ap > 0) || quote.ap < quote.bp) return { skip: 'no quote within 120 s' }
  const mid = (quote.ap + quote.bp) / 2
  const spreadPct = (quote.ap - quote.bp) / mid
  if (spreadPct > R.maxSpreadPct) return { skip: 'spread over 3%', spreadPct }
  const fill = Math.max(br.trigger, bar.o) + (quote.ap - quote.bp) / 2 + R.slippage
  const stop = br.low - R.tick
  const risk = fill - stop
  if (risk < R.minRisk) return { skip: 'risk under $0.02', spreadPct }
  if (risk > R.maxRiskPct * fill) return { skip: 'risk over 10% of price', spreadPct }
  const shares = Math.floor(Math.min((equity * R.riskPct) / risk, (equity * R.positionPct) / fill, R.maxShareOfBarVolume * bar.v, R.maxShareOfDayVolume * cumVolumeBefore))
  if (shares < 1) return { skip: 'size under 1 share (volume caps)', spreadPct }
  return { fill, stop, risk, shares, spreadPct }
}

/**
 * Section 5-6 exit check on one bar (not the 15:30 flatten). Stop before target. On the entry bar only the stop, and
 * only if the bar closes at or below it. On a bar after a halt: an open at or below the stop fills there (the gap is
 * taken in full); an open at or above the target fills at the target. Returns the base price before the half spread
 * and slippage (stop) or the limit price (target). Pure.
 */
export function exitOnBar(p: { stop: number; target: number }, bar: Bar, o: { entryBar?: boolean; resume?: boolean } = {}): { reason: 'stop' | 'target'; base: number } | null {
  if (o.entryBar) return bar.c <= p.stop ? { reason: 'stop', base: p.stop } : null
  if (o.resume && bar.o >= p.target) return { reason: 'target', base: p.target }
  if (bar.l <= p.stop) return { reason: 'stop', base: Math.min(p.stop, bar.o) }
  if (bar.h >= p.target + R.tick - 1e-9) return { reason: 'target', base: p.target }
  return null
}

/** Sell price: a target is a limit (no slippage); a stop or a flatten pays half the spread and $0.01. Pure. */
export const sellPrice = (reason: string, base: number, halfSpread: number) => (reason === 'target' ? base : Math.max(0.01, base - halfSpread - R.slippage))

