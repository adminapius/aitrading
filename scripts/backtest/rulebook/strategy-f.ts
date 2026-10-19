// Strategy F: opening-range reversal + FVG - BACKTEST ONLY. Spec (LOCKED Oct 19, 2026): docs/strategy-f-spec.md
//
//   $env:NODE_OPTIONS="--max-old-space-size=8192"
//   npx tsx scripts/backtest/rulebook/strategy-f.ts --window=tuning  --out=backtests/strategy-f
//   npx tsx scripts/backtest/rulebook/strategy-f.ts --window=holdout --out=backtests/strategy-f
//
// Each window runs once (lock file). Nothing changes after a run.
// Lines per variant (F-A Touch & Turn, F-B Quick Flip):
//   judged  : top-100 stocks, flat $20 risk per trade, no cash cap   <- pass rule applies here
//   cash    : top-100 stocks, real $2,000 account, 1% risk compounding, no leverage (information)
//   hold    : judged trades held to target/stop or 15:55 (information)
//   touch   : F-A with touch fills for entry and target (information)
//   index   : SPY/QQQ, flat $20 (information)
//   sp      : SP penny-gapper universe, flat $20 (information; that universe is a daily superset that uses the day's
//             high, so it looks ahead - shown only because Jose asked for it)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { easternMidnight } from '../market'
import { getDailyBars, getDailyBarsSplitAdjusted, type RawBar } from '../data'
import { toEasternDay, type DailyRow } from '../universe'
import { RULEBOOK } from './config'
import { getDayBars, loadReference, strategySPCandidates, type Reference } from './data'
import { atr, isBearishEngulfing, isBullishEngulfing, isHammer, isShootingStar, type Bar } from './indicators'
import { addDays, parseArgs } from './runner'
import { topByDollarVolume } from './strategy-f-probe'

export const F = {
  holdoutEnd: '2026-10-16',
  top: 100,
  index: ['SPY', 'QQQ'] as string[],
  atrDays: 14,
  minOrToAtr: 0.25,
  orStart: 9 * 60 + 30, // 9:30 bar
  orEnd: 9 * 60 + 44, // 9:44 bar (last OR bar)
  entryStart: 9 * 60 + 45,
  entryEnd: 11 * 60, // orders cancel and positions close at the 11:00 bar's open
  holdEnd: 15 * 60 + 55, // information line: close at the 15:55 bar's open
  premarketStart: 4 * 60,
  targetFraction: 0.382,
  stopFraction: 0.191, // half the target distance
  tick: 0.01,
  maxOpen: 3,
  dailyStopR: -3,
  flatRisk: 20,
  equity: 2000,
  riskFraction: 0.01,
  slippage: 0.0005,
  minRewardB: 1.5,
  fvgAtr: 0.25,
  ssrDrop: 0.1,
  maxShareOfDayVolume: 0.01, // of the volume so far that day (rulebook)
  maxShareOfBarVolume: 0.1, // a fill above 10% of the bar's volume is rejected (rulebook)
} as const

const C = RULEBOOK.costs

export type MBar = Bar & { m: number }
export type Gap = { dir: 1 | -1; low: number; high: number; known: number; closedAt: number | null } // minutes
export type Setup = {
  symbol: string
  rank: number
  group: 'stock' | 'index' | 'sp'
  dir: 1 | -1 | 0
  orOpen: number
  orHigh: number
  orLow: number
  orClose: number
  range: number
  atr: number
  orToAtr: number
  liquid: boolean
  ssrCarry: boolean
  ssrMinute: number | null
  bars: MBar[]
  idx: Int32Array // minute of day -> index in bars, -1 if no bar
  cumVolBefore: number[] // volume of the day's bars before bars[i]
  gaps: Gap[]
}
export type Order = { from: number; to: number; kind: 'limit' | 'stop'; level: number; stop: number; target: number; setup: string }
export type Exit = { minute: number; price: number; reason: string }
export type FTrade = {
  line: string; variant: string; date: string; ticker: string; group: string; side: 'long' | 'short'; setup: string
  orHigh: number; orLow: number; range: number; atr: number; orToAtr: number
  entryMinute: number; entry: number; stop: number; target: number; shares: number; riskDollars: number
  exit: Exit; fees: number; pnl: number; r: number; stopSlipR: number
  hold: { exit: Exit; fees: number; pnl: number; r: number }
  fvg: boolean; fvgDistAtr: number | null; equityAfter: number
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

// ---------- per symbol-day setup ----------

// 5-minute candles on the clock grid from 1-minute bars with minute in [from, to). Empty slots produce no candle.
export function fiveMinute(bars: MBar[], from: number, to: number) {
  const out = new Map<number, Bar & { start: number }>()
  for (const b of bars) {
    if (b.m < from || b.m >= to) continue
    const s = Math.floor(b.m / 5) * 5
    const c = out.get(s)
    if (!c) out.set(s, { t: s, start: s, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })
    else { c.h = Math.max(c.h, b.h); c.l = Math.min(c.l, b.l); c.c = b.c; c.v += b.v }
  }
  return out
}

// Jose's FVG definition: 5-minute candles 4:00-9:45, three consecutive candles of the same color.
// Bullish (3 green): third low > first high, gap = [first high, third low]. Bearish (3 red): third high < first low.
// Closed = a later 1-minute bar fully closes it (bullish: low <= first high; bearish: high >= first low).
export function findGaps(bars: MBar[]): Gap[] {
  const five = fiveMinute(bars, F.premarketStart, F.entryStart)
  const gaps: Gap[] = []
  for (const [s, c3] of five) {
    const c2 = five.get(s - 5)
    const c1 = five.get(s - 10)
    if (!c1 || !c2) continue
    const green = [c1, c2, c3].every((c) => c.c > c.o)
    const red = [c1, c2, c3].every((c) => c.c < c.o)
    const known = s + 5 // the third candle has closed
    if (green && c3.l > c1.h) gaps.push({ dir: 1, low: c1.h, high: c3.l, known, closedAt: null })
    if (red && c3.h < c1.l) gaps.push({ dir: -1, low: c3.h, high: c1.l, known, closedAt: null })
  }
  for (const g of gaps) {
    const hit = bars.find((b) => b.m >= g.known && (g.dir > 0 ? b.l <= g.low : b.h >= g.high))
    g.closedAt = hit ? hit.m : null
  }
  return gaps
}

// FVG confluence at an entry: an unfilled gap in the trade's direction with its nearest edge within 0.25 x ATR.
export function fvgConfluence(gaps: Gap[], dir: 1 | -1, minute: number, price: number, dailyAtr: number) {
  let best: number | null = null
  for (const g of gaps) {
    if (g.dir !== dir || g.known > minute || (g.closedAt != null && g.closedAt < minute)) continue
    const dist = price >= g.low && price <= g.high ? 0 : Math.min(Math.abs(price - g.low), Math.abs(price - g.high))
    if (best == null || dist < best) best = dist
  }
  return { fvg: best != null && best <= F.fvgAtr * dailyAtr, distAtr: best == null ? null : best / dailyAtr }
}

export function buildSetup(symbol: string, rank: number, group: Setup['group'], raw: Bar[], midnight: number,
  dailyAtr: number | null, prevClose: number | null, ssrCarry: boolean): Setup | null {
  const bars: MBar[] = raw.map((b) => ({ ...b, m: Math.round((b.t - midnight) / 60_000) })).sort((a, b) => a.m - b.m)
  const or = bars.filter((b) => b.m >= F.orStart && b.m <= F.orEnd)
  if (!or.length || dailyAtr == null || !(dailyAtr > 0)) return null
  const orHigh = Math.max(...or.map((b) => b.h))
  const orLow = Math.min(...or.map((b) => b.l))
  const orOpen = or[0].o
  const orClose = or[or.length - 1].c
  const range = orHigh - orLow
  const dir = orClose < orOpen ? 1 : orClose > orOpen ? -1 : 0
  const cumVolBefore: number[] = []
  const idx = new Int32Array(1440).fill(-1)
  let total = 0
  for (const [i, b] of bars.entries()) { cumVolBefore.push(total); total += b.v; if (b.m >= 0 && b.m < 1440) idx[b.m] = i }
  const ssrHit = prevClose ? bars.find((b) => b.l <= prevClose * (1 - F.ssrDrop)) : undefined
  return {
    symbol, rank, group, dir, orOpen, orHigh, orLow, orClose, range, atr: dailyAtr, orToAtr: range / dailyAtr,
    liquid: range > 0 && range >= F.minOrToAtr * dailyAtr, ssrCarry, ssrMinute: ssrHit ? ssrHit.m : null,
    bars, idx, cumVolBefore, gaps: dir === 0 ? [] : findGaps(bars),
  }
}

// ---------- orders ----------

export function ordersFA(s: Setup): Order[] {
  if (!s.liquid || s.dir === 0) return []
  const long = s.dir > 0
  const level = long ? s.orLow : s.orHigh
  return [{
    from: F.entryStart, to: F.entryEnd - 1, kind: 'limit', level, setup: 'F-A',
    target: long ? s.orLow + F.targetFraction * s.range : s.orHigh - F.targetFraction * s.range,
    stop: long ? s.orLow - F.stopFraction * s.range : s.orHigh + F.stopFraction * s.range,
  }]
}

export function ordersFB(s: Setup): Order[] {
  if (!s.liquid || s.dir === 0) return []
  const five = fiveMinute(s.bars, F.orStart, F.entryEnd)
  const out: Order[] = []
  const long = s.dir > 0
  for (let start = F.entryStart; start + 5 < F.entryEnd; start += 5) {
    const c = five.get(start)
    const p1 = five.get(start - 5)
    const p2 = five.get(start - 10)
    if (!c || !p1) continue
    if (long ? !(c.l < s.orLow) : !(c.h > s.orHigh)) continue
    let level: number | null = null
    let setup = ''
    const twoAgainst = p2 != null && (long ? p1.c < p1.o && p2.c < p2.o : p1.c > p1.o && p2.c > p2.o)
    if (long && isHammer(c) && twoAgainst) { level = c.h + F.tick; setup = 'F-B hammer' }
    else if (!long && isShootingStar(c) && twoAgainst) { level = c.l - F.tick; setup = 'F-B shooting star' }
    else if (long && isBullishEngulfing(p1, c)) { level = p1.h; setup = 'F-B engulfing' }
    else if (!long && isBearishEngulfing(p1, c)) { level = p1.l; setup = 'F-B engulfing' }
    if (level == null) continue
    const stop = long ? c.l - F.tick : c.h + F.tick
    const target = long ? s.orHigh : s.orLow
    const risk = Math.abs(level - stop)
    const reward = long ? target - level : level - target
    out.push({ from: start + 5, to: start + 9, kind: 'stop', level, stop, target, setup: risk > 0 && reward >= F.minRewardB * risk ? setup : `${setup} (reward < 1.5R)` })
  }
  return out
}

// Fill price on a 1-minute bar, or null. Limits: trade-through by 1 tick ('trade') or touch ('touch'), at the level or a
// better open, no slippage. Stop orders: triggered when the bar reaches the level, at the level or a worse open, + slippage.
export function fillOn(order: Order, dir: 1 | -1, b: Bar, mode: 'trade' | 'touch') {
  if (order.kind === 'limit') {
    const through = mode === 'trade' ? F.tick : 0
    if (dir > 0 ? b.l <= order.level - through : b.h >= order.level + through) return dir > 0 ? Math.min(order.level, b.o) : Math.max(order.level, b.o)
    return null
  }
  if (dir > 0 ? b.h >= order.level : b.l <= order.level) return (dir > 0 ? Math.max(order.level, b.o) : Math.min(order.level, b.o)) * (1 + dir * F.slippage)
  return null
}

// Exit from the fill bar on: entry bar = stop only (worst case, no target); later bars: gap through stop -> open,
// stop touched -> stop, target (trade-through or touch) -> target or a better open; both in one bar -> stop.
// Time exit at the open of the first bar at or after endMinute, minus slippage.
export function simulateExit(bars: MBar[], i0: number, dir: 1 | -1, stop: number, target: number, endMinute: number, mode: 'trade' | 'touch'): Exit {
  const slip = (p: number) => p * (1 - dir * F.slippage)
  for (let i = i0; i < bars.length; i += 1) {
    const b = bars[i]
    if (b.m >= endMinute) return { minute: b.m, price: slip(b.o), reason: endMinute === F.entryEnd ? 'time 11:00' : 'time 15:55' }
    const stopHit = dir > 0 ? b.l <= stop : b.h >= stop
    if (i === i0) {
      if (stopHit) return { minute: b.m, price: slip(stop), reason: 'stop (entry bar)' }
      continue
    }
    if (dir > 0 ? b.o <= stop : b.o >= stop) return { minute: b.m, price: slip(b.o), reason: 'gap-stop' }
    if (stopHit) return { minute: b.m, price: slip(stop), reason: 'stop' }
    const through = mode === 'trade' ? F.tick : 0
    if (dir > 0 ? b.h >= target + through : b.l <= target - through) return { minute: b.m, price: dir > 0 ? Math.max(target, b.o) : Math.min(target, b.o), reason: 'target' }
  }
  const last = bars[bars.length - 1]
  return { minute: last.m, price: slip(last.c), reason: 'time (last bar)' }
}

export function sellFees(price: number, shares: number) {
  return price * shares * C.secFeePerDollar + Math.min(shares * C.finraTafPerShare, C.finraTafMaxPerTrade)
}

export function tradeResult(dir: 1 | -1, entry: number, exit: Exit, shares: number, riskDollars: number) {
  const fees = sellFees(dir > 0 ? exit.price : entry, shares) + 2 * C.commission
  const pnl = dir * shares * (exit.price - entry) - fees
  return { fees, pnl, r: pnl / riskDollars }
}

// ---------- one line, one day ----------

export type LineSpec = { id: string; variant: 'F-A' | 'F-B'; sizing: 'flat' | 'cash'; mode: 'trade' | 'touch' }
export type LineState = { equity: number; trades: FTrade[]; skips: Record<string, number>; equityByDay: Array<{ day: string; equity: number }> }

export function runLineDay(spec: LineSpec, state: LineState, day: string, setups: Setup[]) {
  const skip = (k: string) => { state.skips[k] = (state.skips[k] ?? 0) + 1 }
  const work = setups.map((s) => ({ s, orders: spec.variant === 'F-A' ? ordersFA(s) : ordersFB(s), done: false, busy: false })).filter((w) => w.orders.length)
  for (const w of work) for (const o of w.orders) if (o.setup.includes('reward <')) skip('F-B reward < 1.5R')
  work.sort((a, b) => a.s.rank - b.s.rank)
  type Open = { exitMinute: number; r: number; pnl: number; cost: number }
  const open: Open[] = []
  let dayR = 0
  let stopped = false
  let cashInUse = 0
  for (let m = F.entryStart; m < F.entryEnd; m += 1) {
    for (let k = open.length - 1; k >= 0; k -= 1) {
      if (open[k].exitMinute < m) {
        dayR += open[k].r
        state.equity += open[k].pnl
        cashInUse -= open[k].cost
        open.splice(k, 1)
      }
    }
    if (!stopped && dayR <= F.dailyStopR) { stopped = true; skip('daily stop -3R reached (days)') }
    if (stopped) break
    for (const w of work) {
      if (w.done) continue
      const order = w.orders.find((o) => m >= o.from && m <= o.to)
      if (!order || order.setup.includes('reward <')) continue
      const i = w.s.idx[m]
      if (i < 0) continue
      const dir = w.s.dir as 1 | -1
      const b = w.s.bars[i]
      const price = fillOn(order, dir, b, spec.mode)
      if (price == null) continue
      if (open.length >= F.maxOpen) { if (!w.busy) skip('symbols that hit a full-slot fill (order kept working)'); w.busy = true; continue }
      if (dir < 0 && (w.s.ssrCarry || (w.s.ssrMinute != null && w.s.ssrMinute <= m))) { skip('short skipped: SSR'); w.done = true; continue }
      if (dir > 0 ? price <= order.stop : price >= order.stop) { skip('filled beyond the stop (skipped)'); w.done = true; continue }
      const rps = Math.abs(price - order.stop)
      let shares = Math.floor((spec.sizing === 'flat' ? F.flatRisk : state.equity * F.riskFraction) / rps)
      if (spec.sizing === 'cash') shares = Math.min(shares, Math.floor((state.equity - cashInUse) / price))
      shares = Math.min(shares, Math.floor(F.maxShareOfDayVolume * w.s.cumVolBefore[i]))
      if (shares < 1) { skip(spec.sizing === 'cash' ? 'no cash / volume for 1 share' : 'volume cap leaves < 1 share'); continue }
      if (shares > F.maxShareOfBarVolume * b.v) { skip('fill > 10% of bar volume (rejected on that bar)'); continue }
      const riskDollars = shares * rps
      const exit = simulateExit(w.s.bars, i, dir, order.stop, order.target, F.entryEnd, spec.mode)
      const hold = simulateExit(w.s.bars, i, dir, order.stop, order.target, F.holdEnd, spec.mode)
      const res = tradeResult(dir, price, exit, shares, riskDollars)
      const holdRes = tradeResult(dir, price, hold, shares, riskDollars)
      const fvg = fvgConfluence(w.s.gaps, dir, m, price, w.s.atr)
      w.done = true
      open.push({ exitMinute: exit.minute, r: res.r, pnl: res.pnl, cost: shares * price })
      cashInUse += shares * price
      state.trades.push({
        line: spec.id, variant: spec.variant, date: day, ticker: w.s.symbol, group: w.s.group, side: dir > 0 ? 'long' : 'short', setup: order.setup,
        orHigh: w.s.orHigh, orLow: w.s.orLow, range: w.s.range, atr: w.s.atr, orToAtr: w.s.orToAtr,
        entryMinute: m, entry: price, stop: order.stop, target: order.target, shares, riskDollars,
        exit, fees: res.fees, pnl: res.pnl, r: res.r, stopSlipR: (order.stop * F.slippage * shares) / riskDollars,
        hold: { exit: hold, ...holdRes }, fvg: fvg.fvg, fvgDistAtr: fvg.distAtr, equityAfter: 0,
      })
    }
  }
  for (const o of open) { state.equity += o.pnl }
  // equity after each trade in exit order (for drawdown in $); flat lines track cumulative P&L from $2,000
  state.equityByDay.push({ day, equity: state.equity })
}

// ---------- diagnostic (the video's claim) ----------

export type Diag = { days: number; liquid: number; doji: number; back: number; target: number; stop: number; neither: number }
export const emptyDiag = (): Diag => ({ days: 0, liquid: 0, doji: 0, back: 0, target: 0, stop: 0, neither: 0 })

export function diagnose(s: Setup, d: Diag) {
  d.days += 1
  if (!s.liquid) return
  d.liquid += 1
  if (s.dir === 0) { d.doji += 1; return }
  const long = s.dir > 0
  const edge = long ? s.orLow : s.orHigh
  const target = long ? s.orLow + F.targetFraction * s.range : s.orHigh - F.targetFraction * s.range
  const stop = long ? s.orLow - F.stopFraction * s.range : s.orHigh + F.stopFraction * s.range
  const window = s.bars.filter((b) => b.m >= F.entryStart && b.m < F.entryEnd)
  const i0 = window.findIndex((b) => (long ? b.l <= edge : b.h >= edge))
  if (i0 < 0) return
  d.back += 1
  for (let i = i0; i < window.length; i += 1) {
    const b = window[i]
    if (long ? b.l <= stop : b.h >= stop) { d.stop += 1; return }
    if (i > i0 && (long ? b.h >= target : b.l <= target)) { d.target += 1; return }
  }
  d.neither += 1
}

// ---------- data ----------

async function loadData() {
  const P = RULEBOOK.period
  const ref = await loadReference(addDays(P.start, -420), P.start, P.end)
  const extra = await getDailyBars(ref.universe.symbols, addDays(P.end, 1), F.holdoutEnd)
  for (const [symbol, bars] of Object.entries(extra)) {
    const rows = ref.universe.daily.get(symbol) ?? []
    const last = rows.length ? rows[rows.length - 1].day : ''
    for (const bar of bars as RawBar[]) {
      const day = toEasternDay(bar.t)
      if (day > last) rows.push({ day, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v })
    }
    ref.universe.daily.set(symbol, rows)
  }
  const allDays = (ref.universe.daily.get('SPY') ?? []).map((row) => row.day)
  return { ref, allDays }
}

// Daily context in TODAY's price terms. ATR(14) and prior closes come from split-adjusted daily bars, scaled by
// today's raw / adjusted close (the split factor), so a split before, on or after the day keeps one consistent scale.
export function dayContext(adjRows: DailyRow[], adjAtr: Array<number | null>, rawRows: DailyRow[], day: string) {
  const ta = adjRows.findIndex((row) => row.day === day)
  if (ta < 1 || adjAtr[ta - 1] == null) return null
  const raw = rawRows.findLast((row) => row.day === day)
  const factor = raw && adjRows[ta].c > 0 ? raw.c / adjRows[ta].c : 1
  const prev = adjRows[ta - 1]
  const prev2 = ta > 1 ? adjRows[ta - 2] : null
  return {
    atr: adjAtr[ta - 1]! * factor,
    prevClose: prev.c * factor,
    ssrCarry: prev2 != null && prev.l <= prev2.c * (1 - F.ssrDrop),
  }
}

// ---------- report ----------

function stats(list: FTrade[], pick: (t: FTrade) => { r: number; pnl: number } = (t) => t) {
  const rs = list.map((t) => pick(t).r)
  const wins = rs.filter((r) => r > 0)
  const losses = rs.filter((r) => r <= 0)
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  let cum = 0, peak = 0, dd = 0
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum) }
  const lossSum = Math.abs(sum(rs.filter((r) => r < 0)))
  return {
    n: list.length, win: list.length ? wins.length / list.length : null,
    avgWin: wins.length ? sum(wins) / wins.length : null, avgLoss: losses.length ? sum(losses) / losses.length : null,
    exp: list.length ? sum(rs) / list.length : null, pf: lossSum > 0 ? sum(wins) / lossSum : wins.length ? Infinity : null,
    dd, largestLoss: rs.length ? Math.min(...rs) : null, totalR: sum(rs), totalPnl: sum(list.map((t) => pick(t).pnl)),
  }
}
const f2 = (x: number | null | undefined, d = 2) => (x == null || Number.isNaN(x) ? 'n/a' : x === Infinity ? 'inf' : x.toFixed(d))
const pctf = (x: number | null) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`)
function line(label: string, list: FTrade[], pick?: (t: FTrade) => { r: number; pnl: number }) {
  const s = stats(list, pick)
  return `${label.padEnd(34)} ${String(s.n).padStart(5)} trades, win ${pctf(s.win)}, avg win ${f2(s.avgWin)}R / loss ${f2(s.avgLoss)}R, exp ${f2(s.exp)}R, PF ${f2(s.pf)}, max DD ${f2(s.dd, 1)}R, largest loss ${f2(s.largestLoss)}R, total ${f2(s.totalR, 1)}R / $${f2(s.totalPnl)}`
}

export function passCheck(window: 'tuning' | 'holdout', list: FTrade[]) {
  const s = stats(list)
  if (window === 'tuning') {
    const ok = s.totalR > 0 && s.totalPnl > 0
    return { pass: ok, text: `tuning must be positive: total ${f2(s.totalR, 1)}R and $${f2(s.totalPnl)} -> ${ok ? 'MET' : 'NOT MET'}` }
  }
  const checks: Array<[string, boolean]> = [
    [`trades ${s.n} >= 30`, s.n >= 30],
    [`expectancy ${f2(s.exp)}R > +0.20R`, (s.exp ?? -Infinity) > 0.2],
    [`PF ${f2(s.pf)} > 1.5`, (s.pf ?? 0) > 1.5],
    [`largest loss ${f2(s.largestLoss)}R, under 3R`, s.largestLoss == null || s.largestLoss > -3],
    [`dollars $${f2(s.totalPnl)} > 0`, s.totalPnl > 0],
  ]
  const pass = checks.every(([, ok]) => ok)
  return { pass, text: `holdout: ${checks.map(([t, ok]) => `${t} ${ok ? 'ok' : 'FAIL'}`).join('; ')} -> ${pass ? 'PASS' : 'FAIL'}` }
}

function quartiles(values: number[]) {
  const s = [...values].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return s.length ? [q(0.25), q(0.5), q(0.75)] : []
}

function median(values: number[]) {
  if (!values.length) return Number.NaN
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function detail(id: string, list: FTrade[], log: (s: string) => void) {
  log(`[f] --- ${id}: splits ---`)
  for (const side of ['long', 'short']) log(`      ${line(side, list.filter((t) => t.side === side))}`)
  log(`      ${line('FVG confluence yes', list.filter((t) => t.fvg))}`)
  log(`      ${line('FVG confluence no', list.filter((t) => !t.fvg))}`)
  for (const [name, a, b] of [['entry 9:45-10:00', 585, 600], ['entry 10:00-10:30', 600, 630], ['entry 10:30-11:00', 630, 660]] as const) {
    log(`      ${line(name, list.filter((t) => t.entryMinute >= a && t.entryMinute < b))}`)
  }
  const setups = [...new Set(list.map((t) => t.setup))].sort()
  if (setups.length > 1) for (const s of setups) log(`      ${line(s, list.filter((t) => t.setup === s))}`)
  const qs = quartiles(list.map((t) => t.orToAtr))
  if (qs.length) {
    const bounds = [-Infinity, ...qs, Infinity]
    log(`      OR/ATR quartiles (cut points ${qs.map((x) => x.toFixed(2)).join(' / ')}):`)
    for (let k = 0; k < 4; k += 1) {
      log(`      ${line(`Q${k + 1} OR/ATR ${k === 0 ? '<' : f2(bounds[k])} .. ${k === 3 ? '' : f2(bounds[k + 1])}`, list.filter((t) => t.orToAtr >= bounds[k] && t.orToAtr < bounds[k + 1]))}`)
    }
  }
  const reasons = new Map<string, FTrade[]>()
  for (const t of list) reasons.set(t.exit.reason, [...(reasons.get(t.exit.reason) ?? []), t])
  log(`      exits: ${[...reasons].map(([k, v]) => `${k} ${v.length} (${f2(v.reduce((s, t) => s + t.r, 0), 1)}R)`).join(', ')}`)
  const s = stats(list)
  if (s.avgWin != null && s.avgLoss != null) {
    const be = Math.abs(s.avgLoss) / (s.avgWin + Math.abs(s.avgLoss))
    let planned = ''
    if (id.startsWith('F-A')) {
      const k = median(list.map((t) => t.stopSlipR))
      planned = `; planned 2:1 with median stop slippage ${f2(k)}R: breakeven ${pctf((1 + k) / (3 + k))}`
    }
    log(`      breakeven win rate from actual avg win/loss (slippage and fees included): ${pctf(be)} vs actual ${pctf(s.win)}${planned}`)
  }
  const months = new Map<string, FTrade[]>()
  for (const t of list) months.set(t.date.slice(0, 7), [...(months.get(t.date.slice(0, 7)) ?? []), t])
  const keys = [...months.keys()].sort()
  const positive = keys.filter((k) => months.get(k)!.reduce((x, t) => x + t.r, 0) > 0).length
  log(`      by month (${positive} of ${keys.length} positive): ${keys.map((k) => `${k} ${months.get(k)!.length}/${f2(months.get(k)!.reduce((x, t) => x + t.r, 0), 1)}R/$${f2(months.get(k)!.reduce((x, t) => x + t.pnl, 0), 0)}`).join(', ')}`)
}

function csv(trades: FTrade[]) {
  const head = 'line,variant,date,ticker,group,side,setup,or_high,or_low,or_range,daily_atr,or_to_atr,entry_time,entry,stop,target,shares,risk_dollars,exit_time,exit,exit_reason,r,pnl,fees,stop_slip_r,hold_exit_time,hold_exit,hold_reason,hold_r,hold_pnl,fvg,fvg_dist_atr'
  const rows = trades.map((t) => [t.line, t.variant, t.date, t.ticker, t.group, t.side, t.setup, t.orHigh.toFixed(4), t.orLow.toFixed(4), t.range.toFixed(4), t.atr.toFixed(4), t.orToAtr.toFixed(3),
    hhmm(t.entryMinute), t.entry.toFixed(4), t.stop.toFixed(4), t.target.toFixed(4), t.shares, t.riskDollars.toFixed(2), hhmm(t.exit.minute), t.exit.price.toFixed(4), t.exit.reason,
    t.r.toFixed(3), t.pnl.toFixed(2), t.fees.toFixed(4), t.stopSlipR.toFixed(3), hhmm(t.hold.exit.minute), t.hold.exit.price.toFixed(4), t.hold.exit.reason, t.hold.r.toFixed(3), t.hold.pnl.toFixed(2),
    t.fvg ? 'yes' : 'no', t.fvgDistAtr == null ? '' : t.fvgDistAtr.toFixed(3)].join(','))
  return [head, ...rows].join('\n') + '\n'
}

// ---------- main ----------

export const LINES: Array<LineSpec & { group: Setup['group']; label: string }> = [
  { id: 'F-A judged', label: 'F-A stocks, flat $20 (JUDGED)', variant: 'F-A', sizing: 'flat', mode: 'trade', group: 'stock' },
  { id: 'F-B judged', label: 'F-B stocks, flat $20 (JUDGED)', variant: 'F-B', sizing: 'flat', mode: 'trade', group: 'stock' },
  { id: 'F-A cash', label: 'F-A stocks, $2,000 cash-capped', variant: 'F-A', sizing: 'cash', mode: 'trade', group: 'stock' },
  { id: 'F-B cash', label: 'F-B stocks, $2,000 cash-capped', variant: 'F-B', sizing: 'cash', mode: 'trade', group: 'stock' },
  { id: 'F-A touch', label: 'F-A stocks, touch fills', variant: 'F-A', sizing: 'flat', mode: 'touch', group: 'stock' },
  { id: 'F-A index', label: 'F-A SPY/QQQ, flat $20', variant: 'F-A', sizing: 'flat', mode: 'trade', group: 'index' },
  { id: 'F-B index', label: 'F-B SPY/QQQ, flat $20', variant: 'F-B', sizing: 'flat', mode: 'trade', group: 'index' },
  { id: 'F-A index cash', label: 'F-A SPY/QQQ, $2,000 cash-capped', variant: 'F-A', sizing: 'cash', mode: 'trade', group: 'index' },
  { id: 'F-B index cash', label: 'F-B SPY/QQQ, $2,000 cash-capped', variant: 'F-B', sizing: 'cash', mode: 'trade', group: 'index' },
  { id: 'F-A sp', label: 'F-A SP penny universe, flat $20', variant: 'F-A', sizing: 'flat', mode: 'trade', group: 'sp' },
  { id: 'F-B sp', label: 'F-B SP penny universe, flat $20', variant: 'F-B', sizing: 'flat', mode: 'trade', group: 'sp' },
]

async function main() {
  const args = parseArgs()
  const window = args.get('window')
  if (window !== 'tuning' && window !== 'holdout') throw new Error('Pass --window=tuning or --window=holdout')
  const P = RULEBOOK.period
  const range = window === 'tuning' ? { start: P.start, end: P.tuningEnd } : { start: P.holdoutStart, end: F.holdoutEnd }
  const out = join(process.cwd(), args.get('out') ?? 'backtests/strategy-f', window)
  const lock = join(out, 'RUN-LOCK.json')
  if (existsSync(lock)) throw new Error(`Strategy F ${window} has already been run (${lock}). Each window runs once.`)
  const log = (s: string) => console.log(s)

  const { ref, allDays } = await loadData()
  const days = allDays.filter((day) => day >= range.start && day <= range.end)
  const members = topByDollarVolume(ref.universe.daily, ref.universe.names, allDays, F.top)
  const spByDay = new Map<string, string[]>()
  for (const day of days) if (day <= P.end) spByDay.set(day, strategySPCandidates(ref as Reference, day).map((c) => c.symbol))
  const allSymbols = new Set<string>(F.index)
  for (const day of days) { for (const s of members.get(day) ?? []) allSymbols.add(s); for (const s of spByDay.get(day) ?? []) allSymbols.add(s) }
  log(`[f] ${window} ${range.start} to ${range.end}: ${days.length} days, ${allSymbols.size} symbols (top-100, SPY/QQQ, SP penny line)`)

  // Split-adjusted daily bars for ATR, from 60 days before the window.
  const adjRaw = await getDailyBarsSplitAdjusted([...allSymbols].sort(), addDays(range.start, -60), range.end)
  const adj = new Map<string, { rows: DailyRow[]; atr: Array<number | null> }>()
  for (const [symbol, bars] of Object.entries(adjRaw)) {
    const rows = (bars as RawBar[]).map((b) => ({ day: toEasternDay(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
    adj.set(symbol, { rows, atr: atr(rows.map((r, i) => ({ t: i, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v })), F.atrDays) })
  }

  const states = new Map(LINES.map((l) => [l.id, { equity: F.equity, trades: [] as FTrade[], skips: {}, equityByDay: [] } as LineState]))
  const diag = { stock: emptyDiag(), index: emptyDiag() }
  for (const [n, day] of days.entries()) {
    const midnight = easternMidnight(day)
    const groups: Array<[Setup['group'], string[]]> = [['stock', members.get(day) ?? []], ['index', F.index], ['sp', spByDay.get(day) ?? []]]
    const symbols = [...new Set(groups.flatMap(([, list]) => list))]
    const bars = await getDayBars(day, symbols)
    const setups: Record<Setup['group'], Setup[]> = { stock: [], index: [], sp: [] }
    for (const [group, list] of groups) {
      for (const [rank, symbol] of list.entries()) {
        const a = adj.get(symbol)
        const ctx = a ? dayContext(a.rows, a.atr, ref.universe.daily.get(symbol) ?? [], day) : null
        const setup = buildSetup(symbol, rank, group, bars.get(symbol) ?? [], midnight, ctx?.atr ?? null, ctx?.prevClose ?? null, ctx?.ssrCarry ?? false)
        if (!setup) continue
        setups[group].push(setup)
        if (group !== 'sp') diagnose(setup, diag[group])
      }
    }
    for (const l of LINES) runLineDay(l, states.get(l.id)!, day, setups[l.group])
    if (n % 25 === 0) log(`[f] ${day} (${n + 1}/${days.length}) F-A judged ${states.get('F-A judged')!.trades.length} trades, F-B judged ${states.get('F-B judged')!.trades.length}`)
  }

  log(`\n[f] ===== STRATEGY F ${window.toUpperCase()} ${range.start} to ${range.end} (${days.length} trading days) =====`)
  log('[f] diagnostic (the video\'s claim):')
  for (const [name, d] of [['top-100 stocks', diag.stock], ['SPY/QQQ', diag.index]] as const) {
    const dir = d.liquid - d.doji
    log(`      ${name}: ${d.days} symbol-days; OR >= 25% of ATR ${d.liquid} (${pctf(d.days ? d.liquid / d.days : null)}); doji OR ${d.doji}; came back to the OR edge by 11:00 ${d.back} of ${dir} (${pctf(dir ? d.back / dir : null)}); of those, 38.2% target before the 2:1 stop ${d.target} (${pctf(d.back ? d.target / d.back : null)}), stop first ${d.stop}, neither by 11:00 ${d.neither}`)
  }
  log('[f] all lines:')
  for (const l of LINES) {
    const st = states.get(l.id)!
    log(`      ${line(l.label, st.trades)}`)
    if (l.id.endsWith('judged')) log(`      ${line(`  same trades held to 15:55`, st.trades, (t) => t.hold)}`)
  }
  for (const id of ['F-A judged', 'F-B judged']) {
    const list = states.get(id)!.trades
    detail(id, list, log)
    log(`[f] ${id} PASS RULE ${passCheck(window, list).text}`)
  }
  for (const l of LINES) log(`[f] ${l.id} skips: ${JSON.stringify(states.get(l.id)!.skips)}`)
  log('[f] notes: entry-bar stop and stop+target in one bar count as stops (worst case); target limits need a 1-tick trade-through (touch line excepted); SSR also counts premarket prices; SP penny line is look-ahead (daily superset) and uses the S 0.05% slippage, not SP\'s.')

  mkdirSync(out, { recursive: true })
  const all = LINES.flatMap((l) => states.get(l.id)!.trades)
  writeFileSync(join(out, 'trades.csv'), csv(all))
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ window, range, days: days.length, diag, lines: LINES.map((l) => ({ id: l.id, label: l.label, ...stats(states.get(l.id)!.trades), skips: states.get(l.id)!.skips, equityByDay: states.get(l.id)!.equityByDay })),
    pass: Object.fromEntries(['F-A judged', 'F-B judged'].map((id) => [id, passCheck(window, states.get(id)!.trades)])) }, (_k, v) => (v === Infinity ? 'inf' : v), 2))
  writeFileSync(lock, JSON.stringify({ ranAt: new Date().toISOString(), window, trades: Object.fromEntries(LINES.map((l) => [l.id, states.get(l.id)!.trades.length])) }, null, 2))
  log(`[f] wrote ${out}: trades.csv (all lines), summary.json, RUN-LOCK.json`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[f] failed', error)
    process.exitCode = 1
  })
}
