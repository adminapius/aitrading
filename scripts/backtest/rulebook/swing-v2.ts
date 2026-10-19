// H v2 - daily swing, course rules. BACKTEST ONLY. Locked spec: docs/h-v2-spec.md (approved Oct 19, 2026).
//
//   1) earnings probe:  npx tsx scripts/backtest/rulebook/swing-v2.ts --earnings-probe
//   2) tuning (once):   npx tsx scripts/backtest/rulebook/swing-v2.ts --window=tuning --out=backtests/h-v2
//   3) holdout (once):  npx tsx scripts/backtest/rulebook/swing-v2.ts --window=holdout --out=backtests/h-v2
//
// Same cached data as the H v1 run (universe and split-adjusted bars loaded over the full period); each window is
// simulated on its own from $2,000. H v1 runs beside it as the reference. Needs FMP_API_KEY (earnings calendar).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDailyBarsSplitAdjusted, readCache, writeCache, type RawBar } from '../data'
import { easternMidnight } from '../market'
import { toEasternDay } from '../universe'
import { RULEBOOK } from './config'
import { isCommonStock, loadReference, setFifteenWindow, type Reference } from './data'
import { atr, ema, isBullishEngulfing, isHammer, isMorningStar, sma, type Bar } from './indicators'
import { buildRunReport, metrics, passFail, writeOutputs } from './report'
import type { TradeRecord } from './engine'
import { runSwing } from './swing'
import { addDays, parseArgs } from './runner'

const H = RULEBOOK.H
const MIN = 60_000
export const H2 = {
  emaDays: 20,
  breakoutDays: 20,
  volumeMult: 1.5, // [adapted]
  volumeAvgDays: 50,
  tightDays: 15,
  tightN: 3, // [adapted]
  retestWithinN: 0.5,
  retestDays: 10,
  retestStopBelowLowN: 0.5,
  spySmas: [50, 200] as const,
  earningsBlockDays: 5,
} as const

export type Setup = 'A' | 'BO' | 'RT'
type Daily = { day: string; o: number; h: number; l: number; c: number; v: number }
export type Series2 = {
  symbol: string
  rows: Daily[]
  index: Map<string, number>
  s50: Array<number | null>
  n: Array<number | null>
  a: boolean[] // Entry A signal (v1 rule, own detection)
  bo: Array<{ level: number } | null> // qualified breakout signal
  rt: Array<{ level: number; low: number } | null> // retest signal
  funnel: { breakouts: number; trend: number; volume: number; tight: number; retests: number }
}

/** All signals for one stock. Pure (used by the tests). */
export function buildSeries2(symbol: string, rows: Daily[]): Series2 {
  const closes = rows.map((row) => row.c)
  const bars: Bar[] = rows.map((row, i) => ({ t: i, o: row.o, h: row.h, l: row.l, c: row.c, v: row.v }))
  const s20 = sma(closes, H.smas[0])
  const s50 = sma(closes, H.smas[1])
  const s200 = sma(closes, H.smas[2])
  const e20 = ema(closes, H2.emaDays)
  const n = atr(bars, H.atrDays)
  const a: boolean[] = new Array(rows.length).fill(false)
  const bo: Array<{ level: number } | null> = new Array(rows.length).fill(null)
  const rt: Array<{ level: number; low: number } | null> = new Array(rows.length).fill(null)
  const funnel = { breakouts: 0, trend: 0, volume: 0, tight: 0, retests: 0 }
  // Entry A: v1 logic (3rd touch of the 20/50 SMA after 2 bounces, confirmation candle closing above the 20 SMA, SMA trend)
  let bounces = 0
  let inTouch = false
  let touchHigh = 0
  for (let d = 0; d < rows.length; d += 1) {
    const bar = rows[d]
    const x = s20[d], y = s50[d], z = s200[d]
    if (!(x != null && y != null && z != null && x > y && y > z)) { bounces = 0; inTouch = false; continue }
    const touches = (bar.l <= x && bar.c >= x) || (bar.l <= y && bar.c >= y)
    const confirm = bar.c > x && (isHammer(bars[d]) || (d > 0 && isBullishEngulfing(bars[d - 1], bars[d])) || (d > 1 && isMorningStar(bars[d - 2], bars[d - 1], bars[d])))
    if (bounces >= H.priorBouncesRequired && (inTouch || touches) && confirm) { a[d] = true; bounces = 0; inTouch = false; continue }
    let bounced = false
    if (inTouch && bar.c > touchHigh) { bounces += 1; inTouch = false; bounced = true }
    if (touches && !inTouch && !bounced) { inTouch = true; touchHigh = bar.h }
  }
  // Breakout + retest
  for (let d = Math.max(H2.breakoutDays, H2.volumeAvgDays, H2.tightDays); d < rows.length; d += 1) {
    let high = -Infinity
    for (let k = d - H2.breakoutDays; k < d; k += 1) high = Math.max(high, rows[k].h)
    if (!(rows[d].c > high)) continue
    funnel.breakouts += 1
    const ee = e20[d], y = s50[d], z = s200[d], nd = n[d]
    if (!(ee != null && y != null && z != null && ee > y && y > z) || nd == null || !(nd > 0)) continue
    funnel.trend += 1
    let vol = 0
    for (let k = d - H2.volumeAvgDays; k < d; k += 1) vol += rows[k].v
    if (!(rows[d].v >= H2.volumeMult * (vol / H2.volumeAvgDays))) continue
    funnel.volume += 1
    let hi = -Infinity, lo = Infinity
    for (let k = d - H2.tightDays; k < d; k += 1) { hi = Math.max(hi, rows[k].h); lo = Math.min(lo, rows[k].l) }
    if (!(hi - lo <= H2.tightN * nd)) continue
    funnel.tight += 1
    bo[d] = { level: high }
    for (let k = d + 1; k <= Math.min(rows.length - 1, d + H2.retestDays); k += 1) {
      const nk = n[k]
      if (nk == null) continue
      if (rows[k].l <= high + H2.retestWithinN * nk && rows[k].c > high) {
        if (!rt[k]) { rt[k] = { level: high, low: rows[k].l }; funnel.retests += 1 }
        break
      }
    }
  }
  return { symbol, rows, index: new Map(rows.map((row, i) => [row.day, i])), s50, n, a, bo, rt, funnel }
}

// ---------------- earnings (FMP calendar, weekly windows, cached) ----------------
export type Earning = { date: string; time: 'bmo' | 'amc' | null }
async function earningsWeek(from: string, to: string): Promise<Array<{ symbol: string; date: string; time?: string | null }>> {
  const key = `earnings/v1/${from}_${to}`
  const hit = readCache<Array<{ symbol: string; date: string; time?: string | null }>>(key)
  if (hit) return hit
  const apiKey = process.env.FMP_API_KEY?.trim()
  if (!apiKey) throw new Error('FMP_API_KEY is required for the earnings calendar')
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`https://financialmodelingprep.com/stable/earnings-calendar?from=${from}&to=${to}&includeReportTimes=true&apikey=${apiKey}`, { signal: AbortSignal.timeout(60_000) })
    if (response.status === 429 || response.status >= 500) { await new Promise((r) => setTimeout(r, 5_000 * 2 ** attempt)); continue }
    if (!response.ok) throw new Error(`FMP earnings-calendar HTTP ${response.status}`)
    const rows = (await response.json()) as Array<{ symbol: string; date: string; time?: string | null }>
    if (rows.length >= 4000) console.warn(`[h2] earnings ${from}..${to}: ${rows.length} rows (possible cap)`)
    const slim = rows.map((row) => ({ symbol: row.symbol, date: row.date, time: row.time ?? null }))
    writeCache(key, slim)
    return slim
  }
  throw new Error(`FMP earnings-calendar kept failing for ${from}..${to}`)
}

export async function loadEarnings(from: string, to: string, onWeek?: (rows: number, timed: number) => void) {
  const map = new Map<string, Earning[]>()
  for (let start = from; start <= to; start = addDays(start, 7)) {
    const end = addDays(start, 6)
    const rows = await earningsWeek(start, end)
    onWeek?.(rows.length, rows.filter((row) => row.time === 'bmo' || row.time === 'amc').length)
    for (const row of rows) {
      const list = map.get(row.symbol) ?? []
      if (!list.some((e) => e.date === row.date)) list.push({ date: row.date, time: row.time === 'bmo' || row.time === 'amc' ? row.time : null })
      map.set(row.symbol, list)
    }
  }
  for (const list of map.values()) list.sort((x, y) => x.date.localeCompare(y.date))
  return map
}

/** No entry if an earnings date falls within the 5 trading days starting on the fill day. Pure. */
export function earningsBlocks(list: Earning[] | undefined, tradingDays: string[], fillIndex: number) {
  if (!list?.length || fillIndex < 0) return false
  const from = tradingDays[fillIndex]
  const to = tradingDays[Math.min(tradingDays.length - 1, fillIndex + H2.earningsBlockDays - 1)]
  return list.some((e) => e.date >= from && e.date <= to)
}

/** Exit at today's close if the next report is before tomorrow's open. Pure. */
export function earningsExitToday(list: Earning[] | undefined, today: string, nextTradingDay: string | undefined) {
  if (!list?.length) return false
  return list.some((e) => (e.time === 'amc' && e.date === today) || (e.time !== 'amc' && nextTradingDay != null && e.date > today && e.date <= nextTradingDay))
}

// ---------------- simulation ----------------
type Position = { symbol: string; setup: Setup; entryDay: string; entryPrice: number; shares: number; stop: number; riskPerShare: number; below50: number; pendingExit: string | null; maxHigh: number; minLow: number; note: string; roomR: number }
type Pending = { symbol: string; setup: Setup; n: number; riskDollars: number; note: string; roomR: number; rank: number; retestLow?: number }
export type VariantOptions = { id: string; label: string; entries: Setup[]; marketFilter: boolean }

function simulate(opts: VariantOptions, series: Map<string, Series2>, rawOk: Map<string, Set<string>>, spyOk: Map<string, boolean>, earnings: Map<string, Earning[]>, allDays: string[], days: string[]) {
  const C = RULEBOOK.costs
  let cash: number = RULEBOOK.account.startingEquity
  const positions: Position[] = []
  let pending: Pending[] = []
  const trades: TradeRecord[] = []
  const equityByDay: Array<{ day: string; equity: number }> = []
  const stats = { signals: 0, notInUniverse: 0, marketBlocked: 0, earningsBlocked: 0, roomBlocked: 0, slotsFull: 0, riskCap: 0, cashCap: 0, stopNotBelowFill: 0, filled: 0, earningsExits: 0 }
  const time = (day: string, minute: number) => easternMidnight(day) + minute * MIN
  const lastIndex = (s: Series2, day: string) => { let i = s.index.get(day); if (i == null) for (let k = s.rows.length - 1; k >= 0; k -= 1) if (s.rows[k].day <= day) { i = k; break } return i }
  const markEquity = (day: string) => cash + positions.reduce((sum, p) => { const s = series.get(p.symbol)!; const i = lastIndex(s, day); return sum + p.shares * (i != null ? s.rows[i].c : p.entryPrice) }, 0)
  const sell = (p: Position, price: number, reason: string, day: string, minute: number) => {
    const proceeds = p.shares * price
    const fees = proceeds * C.secFeePerDollar + Math.min(p.shares * C.finraTafPerShare, C.finraTafMaxPerTrade)
    cash += proceeds - fees
    const pnl = p.shares * (price - p.entryPrice) - fees
    positions.splice(positions.indexOf(p), 1)
    const riskDollars = p.shares * p.riskPerShare
    trades.push({ run: opts.id, date: p.entryDay, ticker: p.symbol, version: 'S', setup: p.setup, entryIndex: 1, entryTime: time(p.entryDay, 570), entryPrice: p.entryPrice, avgCost: p.entryPrice, stop: p.stop,
      shares: p.shares, maxShares: p.shares, units: 1, exitTime: time(day, minute), exitPrice: price, exitReason: reason, partials: `exit ${day}`, rResult: pnl / riskDollars, pnl, fees, equityAfter: 0, riskDollars,
      mfeR: (p.maxHigh - p.entryPrice) / p.riskPerShare, maeR: (p.minLow - p.entryPrice) / p.riskPerShare, holdMinutes: Math.round((time(day, minute) - time(p.entryDay, 570)) / MIN), roomR: p.roomR, gapPct: null, rvol: null, note: p.note })
  }
  const dayPos = new Map(allDays.map((d, i) => [d, i]))
  for (const [dayIndex, day] of days.entries()) {
    const nextDay = allDays[(dayPos.get(day) ?? -2) + 1]
    for (const p of [...positions]) { // a) close-based exits flagged yesterday: next open
      const s = series.get(p.symbol)!; const i = s.index.get(day)
      if (i != null && p.pendingExit) sell(p, s.rows[i].o * (1 - H.slippage), p.pendingExit, day, 570)
    }
    const equityAtOpen = markEquity(days[dayIndex - 1] ?? day)
    for (const e of pending) { // b) entries at today's open
      const s = series.get(e.symbol)!; const i = s.index.get(day)
      if (i == null) continue
      if (positions.length >= H.maxOpen) { stats.slotsFull += 1; continue }
      if (positions.some((p) => p.symbol === e.symbol)) continue
      const fill = s.rows[i].o * (1 + H.slippage)
      const stop = e.setup === 'RT' ? Math.max(fill - H.stopAtr * e.n, e.retestLow! - H2.retestStopBelowLowN * e.n) : fill - H.stopAtr * e.n
      const riskPerShare = fill - stop
      if (!(riskPerShare > 0)) { stats.stopNotBelowFill += 1; continue }
      let shares = Math.min(Math.floor(e.riskDollars / riskPerShare + 1e-9), Math.floor(cash / fill))
      if (shares < 1) { stats.cashCap += 1; continue }
      const openRisk = positions.reduce((sum, p) => sum + p.shares * Math.max(0, p.entryPrice - p.stop), 0)
      if (openRisk + shares * riskPerShare > H.maxOpenRiskFraction * equityAtOpen) {
        shares = Math.floor((H.maxOpenRiskFraction * equityAtOpen - openRisk) / riskPerShare)
        if (shares < 1) { stats.riskCap += 1; continue }
      }
      cash -= shares * fill
      stats.filled += 1
      positions.push({ symbol: e.symbol, setup: e.setup, entryDay: day, entryPrice: fill, shares, stop, riskPerShare, below50: 0, pendingExit: null, maxHigh: fill, minLow: fill, note: e.note, roomR: e.roomR })
    }
    pending = []
    for (const p of [...positions]) { // c) intraday protective level, d) earnings exit at the close, e) 50 SMA closes
      const s = series.get(p.symbol)!; const i = s.index.get(day)
      if (i == null) continue
      const bar = s.rows[i]
      let tenLow = Infinity
      for (let k = Math.max(0, i - H.exitLowDays); k < i; k += 1) tenLow = Math.min(tenLow, s.rows[k].l)
      const level = Math.max(p.stop, Number.isFinite(tenLow) ? tenLow : -Infinity)
      const reason = level === p.stop ? 'stop' : '10-day-low'
      if (p.entryDay !== day && bar.o <= level) { sell(p, bar.o * (1 - H.slippage), `gap-${reason}`, day, 570); continue }
      if (bar.l <= level && (p.entryDay !== day || bar.c <= level)) { sell(p, level * (1 - H.slippage), reason, day, 720); continue }
      p.maxHigh = Math.max(p.maxHigh, bar.h)
      p.minLow = Math.min(p.minLow, bar.l)
      if (earningsExitToday(earnings.get(p.symbol), day, nextDay)) { stats.earningsExits += 1; sell(p, bar.c * (1 - H.slippage), 'earnings-exit', day, 960); continue }
      const s50 = s.s50[i]
      p.below50 = s50 != null && bar.c < s50 ? p.below50 + 1 : 0
      if (p.below50 >= H.exitClosesBelow50) p.pendingExit = 'below-50sma-2-closes'
    }
    const equity = markEquity(day) // f) new signals at today's close
    if (dayIndex < days.length - 1) {
      const fillIndex = (dayPos.get(day) ?? -2) + 1
      const candidates: Pending[] = []
      for (const [symbol, s] of series) {
        const i = s.index.get(day)
        if (i == null) continue
        const found: Array<{ setup: Setup; note: string; retestLow?: number }> = []
        if (opts.entries.includes('BO') && s.bo[i]) found.push({ setup: 'BO', note: `breakout above ${s.bo[i]!.level.toFixed(2)}` })
        if (opts.entries.includes('RT') && s.rt[i]) found.push({ setup: 'RT', note: `retest of ${s.rt[i]!.level.toFixed(2)}`, retestLow: s.rt[i]!.low })
        if (opts.entries.includes('A') && s.a[i]) found.push({ setup: 'A', note: 'third touch' })
        if (!found.length) continue
        const pick = found[0] // one candidate per stock per day: breakout, then retest, then A
        stats.signals += 1
        if (!rawOk.get(symbol)?.has(day)) { stats.notInUniverse += 1; continue }
        const n = s.n[i]
        if (n == null || !(n > 0)) continue
        if (opts.marketFilter && !spyOk.get(day)) { stats.marketBlocked += 1; continue }
        if (earningsBlocks(earnings.get(symbol), allDays, fillIndex)) { stats.earningsBlocked += 1; continue }
        const close = s.rows[i].c
        let roomR = Infinity
        if (pick.setup === 'A') {
          let nearest = Infinity
          for (let k = Math.max(1, i - H.roomPivotDays); k < i; k += 1) { const row = s.rows[k]; if (row.h > s.rows[k - 1].h && row.h > s.rows[k + 1].h && row.h > close + 0.01 && row.h < nearest) nearest = row.h }
          roomR = nearest === Infinity ? Infinity : (nearest - close) / (H.stopAtr * n)
          if (roomR < H.minRoomR) { stats.roomBlocked += 1; continue }
        }
        let high52 = 0
        for (let k = Math.max(0, i - H.rankLookbackDays); k <= i; k += 1) high52 = Math.max(high52, s.rows[k].h)
        candidates.push({ symbol, setup: pick.setup, n, riskDollars: equity * H.riskPerTrade, note: pick.note, roomR, rank: close / high52, retestLow: pick.retestLow })
      }
      candidates.sort((x, y) => y.rank - x.rank || x.symbol.localeCompare(y.symbol))
      pending = candidates.filter((c) => !positions.some((p) => p.symbol === c.symbol)).slice(0, Math.max(0, H.maxOpen - positions.length))
    }
    const marked = markEquity(day)
    for (const t of trades) if (t.equityAfter === 0) t.equityAfter = marked
    equityByDay.push({ day, equity: marked })
  }
  const lastDay = days.at(-1)!
  for (const p of [...positions]) { const s = series.get(p.symbol)!; const last = [...s.rows].reverse().find((row) => row.day <= lastDay)!; sell(p, last.c * (1 - H.slippage), 'end-of-test', lastDay, 960) }
  for (const t of trades) if (t.equityAfter === 0) t.equityAfter = cash
  trades.sort((x, y) => x.exitTime - y.exitTime)
  return { trades, equityByDay, stats }
}

const VARIANTS: VariantOptions[] = [
  { id: 'H2BO', label: 'H v2 breakout only', entries: ['BO'], marketFilter: true },
  { id: 'H2RT', label: 'H v2 Entry B (retest) only', entries: ['RT'], marketFilter: true },
  { id: 'H2A', label: 'H v2 Entry A only', entries: ['A'], marketFilter: true },
  { id: 'H2ALL', label: 'H v2 combined', entries: ['BO', 'RT', 'A'], marketFilter: true },
  { id: 'H2NOMKT', label: 'H v2 combined, no market filter (report only)', entries: ['BO', 'RT', 'A'], marketFilter: false },
]

async function main() {
  const args = parseArgs()
  const P = RULEBOOK.period
  if (args.get('earnings-probe') === 'true') {
    let weeks = 0, rows = 0, timed = 0
    const started = Date.now()
    await loadEarnings(P.start, addDays(P.start, 27), (r, t) => { weeks += 1; rows += r; timed += t })
    const total = Math.ceil((Date.parse(`${addDays(P.end, 10)}T00:00:00Z`) - Date.parse(`${P.start}T00:00:00Z`)) / (7 * 86_400_000))
    console.log(`[h2] EARNINGS PROBE: ${weeks} weeks, ${rows} rows (${Math.round(rows / weeks)} per week), report time known for ${rows ? Math.round((100 * timed) / rows) : 0}%, ${((Date.now() - started) / 1000).toFixed(0)}s.`)
    console.log(`[h2] Full range: about ${total} requests (one per week, ${P.start} to ${addDays(P.end, 10)}), about ${Math.round((rows / weeks) * total / 1000)}k rows; cached, a few MB.`)
    return
  }
  const window = args.get('window')
  if (window !== 'tuning' && window !== 'holdout') throw new Error('Pass --earnings-probe, or --window=tuning / --window=holdout (each runs once).')
  const sim = window === 'tuning' ? { start: P.start, end: P.tuningEnd } : { start: P.holdoutStart, end: P.end }
  const out = join(process.cwd(), args.get('out') ?? 'backtests/h-v2', window)
  const lock = join(out, 'RUN-LOCK.json')
  if (existsSync(lock)) throw new Error(`The ${window} window has already been run (${lock}). The spec allows one run per window.`)
  const full = { start: P.start, end: P.end }
  setFifteenWindow(addDays(P.start, -45), P.end)
  const ref: Reference = await loadReference(addDays(P.start, -420), P.start, P.end)
  // Universe + split-adjusted bars exactly as H v1 over the full period (cache hit), then simulate only this window.
  const rawOk = new Map<string, Set<string>>()
  for (const [symbol, st] of ref.dailyStats) {
    if (!H.exchanges.includes(ref.exchanges.get(symbol) ?? '')) continue
    if (!isCommonStock(symbol, ref.universe.names.get(symbol) ?? '')) continue
    const ok = new Set<string>()
    for (let d = H.avgVolumeDays; d < st.rows.length; d += 1) {
      const row = st.rows[d]
      if (row.day < full.start || row.day > full.end) continue
      let volume = 0
      for (let k = d - H.avgVolumeDays + 1; k <= d; k += 1) volume += st.rows[k].v
      if (row.c >= H.minPrice && volume / H.avgVolumeDays >= H.minAvgVolume) ok.add(row.day)
    }
    if (ok.size) rawOk.set(symbol, ok)
  }
  const symbols = [...rawOk.keys()].sort()
  const days = ref.allDays.filter((day) => day >= sim.start && day <= sim.end)
  // H v1 reference first: it loads its own copy of the bars and only its trades survive, so only one copy is ever in memory.
  const v1 = await runSwing(ref, full, 'H1', sim)
  let adjusted: Record<string, RawBar[]> | null = await getDailyBarsSplitAdjusted(symbols, ref.allDays[0], full.end) as Record<string, RawBar[]>
  // SPY from the already-loaded reference data (no new download). SPY has never split, so raw = split-adjusted.
  const spyRows = ref.universe.daily.get('SPY') ?? []
  if (spyRows.length < H2.spySmas[1]) throw new Error('SPY daily bars missing from the reference data')
  const spyCloses = spyRows.map((row) => row.c)
  const spy50 = sma(spyCloses, H2.spySmas[0]), spy200 = sma(spyCloses, H2.spySmas[1])
  const spyOk = new Map(spyRows.map((row, i) => [row.day, spy50[i] != null && spy200[i] != null && spy50[i]! > spy200[i]!]))
  const series = new Map<string, Series2>()
  for (const symbol of symbols) {
    const rows = (adjusted![symbol] ?? []).map((bar) => ({ day: toEasternDay(bar.t), o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }))
    delete adjusted![symbol]
    if (rows.length <= H.smas[2]) continue
    const s = buildSeries2(symbol, rows)
    series.set(symbol, s)
  }
  adjusted = null
  // 2) earnings, kept only for stocks in this universe
  const allEarnings = await loadEarnings(addDays(P.start, -7), addDays(P.end, 14))
  const earnings = new Map([...allEarnings].filter(([symbol]) => series.has(symbol)))
  allEarnings.clear()
  console.log(`[h2] ${window} ${sim.start} to ${sim.end}: ${days.length} days, ${series.size} stocks, earnings for ${earnings.size} symbols`)

  const results = new Map<string, { trades: TradeRecord[]; equityByDay: Array<{ day: string; equity: number }>; stats: Record<string, number> }>()
  results.set('H1', { trades: v1.trades, equityByDay: v1.equityByDay, stats: v1.stats as unknown as Record<string, number> })
  for (const v of VARIANTS) results.set(v.id, simulate(v, series, rawOk, spyOk, earnings, ref.allDays, days))

  const labels = new Map<string, string>([['H1', 'H v1 (reference)'], ...VARIANTS.map((v) => [v.id, v.label] as [string, string])])
  const reports = [...results.entries()].map(([id, r]) => buildRunReport({ id, label: labels.get(id)!, versions: ['S'], spSlippageMultiplier: 1 }, r.trades, r.equityByDay, r.stats, P))
  writeOutputs(out, reports, new Map([...results.entries()].map(([id, r]) => [id, r.trades])), {
    generatedAt: new Date().toISOString(), sourceCommit: 'h-v2', tradingDays: days.length,
    notes: [`H v2 ${window} window ${sim.start} to ${sim.end}, run once. Locked spec: docs/h-v2-spec.md. Each window starts at $2,000.`],
  })

  // ---------------- console report ----------------
  const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d))
  const minTrades = Math.ceil((RULEBOOK.passCriteria.minTrades * days.length) / ref.periodDays.length)
  console.log(`\n[h2] ===== H v2 ${window.toUpperCase()} ${sim.start} to ${sim.end} (${days.length} trading days; pass needs >= ${minTrades} trades) =====`)
  for (const [id, r] of results) {
    const m = metrics(r.trades, RULEBOOK.account.startingEquity)
    const pf = passFail(r.trades, RULEBOOK.account.startingEquity, window, minTrades, P)
    const failed = pf.checks.filter((c) => !c.pass).map((c) => c.metric).join(', ')
    console.log(`[h2] ${labels.get(id)!.padEnd(46)} ${String(m.trades).padStart(4)} trades, win ${m.winRate == null ? 'n/a' : (m.winRate * 100).toFixed(0)}%, avg win ${fmt(m.avgWinR)}R / loss ${fmt(m.avgLossR)}R, exp ${fmt(m.expectancyR)}R, PF ${fmt(m.profitFactor)}, max DD ${m.maxDrawdownR.toFixed(1)}R, total ${r.trades.reduce((s, t) => s + t.rResult, 0).toFixed(1)}R · ${pf.pass ? 'PASS' : `FAIL (${failed})`}`)
  }
  const all = results.get('H2ALL')!
  console.log('\n[h2] combined run by entry type:')
  for (const setup of ['BO', 'RT', 'A'] as const) {
    const list = all.trades.filter((t) => t.setup === setup)
    const m = metrics(list, RULEBOOK.account.startingEquity)
    console.log(`      ${setup.padEnd(3)} ${String(list.length).padStart(4)} trades, win ${m.winRate == null ? 'n/a' : (m.winRate * 100).toFixed(0)}%, exp ${fmt(m.expectancyR)}R, PF ${fmt(m.profitFactor)}, total ${list.reduce((s, t) => s + t.rResult, 0).toFixed(1)}R`)
  }
  for (const [id, r] of results) {
    const exits = r.trades.reduce((acc, t) => { acc[t.exitReason] = acc[t.exitReason] ?? [0, 0]; acc[t.exitReason][0] += 1; acc[t.exitReason][1] += t.rResult; return acc }, {} as Record<string, [number, number]>)
    const gaps = r.trades.filter((t) => t.exitReason.startsWith('gap-')).length
    console.log(`[h2] ${id} exits: ${Object.entries(exits).map(([k, [c, s]]) => `${k} ${c} (${s.toFixed(1)}R)`).join(', ')} · gap-stops ${gaps}`)
  }
  for (const [id, r] of results) console.log(`[h2] ${id} filters/skips: ${JSON.stringify(r.stats)}`)
  const fw = { breakouts: 0, trend: 0, volume: 0, tight: 0, retests: 0 }
  for (const s of series.values()) {
    const sub = buildFunnelInWindow(s, sim)
    for (const k of Object.keys(fw) as Array<keyof typeof fw>) fw[k] += sub[k]
  }
  console.log(`[h2] breakout funnel in the window (all stocks): 20-day close breakouts ${fw.breakouts} -> trend ${fw.trend} -> volume ${fw.volume} -> tight range ${fw.tight}; retests ${fw.retests}`)
  const ex = all.trades.filter((t) => t.exitReason === 'earnings-exit')
  console.log(`[h2] earnings effect (combined): ${all.stats.earningsBlocked} signals blocked, ${ex.length} trades exited before a report, those exits ${ex.reduce((s, t) => s + t.rResult, 0).toFixed(1)}R total (avg ${ex.length ? (ex.reduce((s, t) => s + t.rResult, 0) / ex.length).toFixed(2) : 'n/a'}R)`)
  console.log('[h2] combined by month: trades, total R')
  const months = [...new Set(all.trades.map((t) => t.date.slice(0, 7)))].sort()
  for (const month of months) { const list = all.trades.filter((t) => t.date.startsWith(month)); console.log(`      ${month}  ${String(list.length).padStart(3)}  ${list.reduce((s, t) => s + t.rResult, 0).toFixed(2).padStart(7)}R`) }
  mkdirSync(out, { recursive: true })
  writeFileSync(lock, JSON.stringify({ window, sim, ranAt: new Date().toISOString(), combinedTrades: all.trades.length }, null, 2))
  console.log(`[h2] wrote ${out}: trades.csv (all runs), run-H2ALL/trades.csv (combined), report.html, summary.json, RUN-LOCK.json`)
}

/** Breakout funnel counted only for signal days inside the window. */
function buildFunnelInWindow(s: Series2, sim: { start: string; end: string }) {
  const out = { breakouts: 0, trend: 0, volume: 0, tight: 0, retests: 0 }
  const rows = s.rows
  const closes = rows.map((r) => r.c)
  const e20 = ema(closes, H2.emaDays), s50 = sma(closes, H.smas[1]), s200 = sma(closes, H.smas[2])
  const n = s.n
  for (let d = Math.max(H2.breakoutDays, H2.volumeAvgDays, H2.tightDays); d < rows.length; d += 1) {
    if (rows[d].day < sim.start || rows[d].day > sim.end) continue
    let high = -Infinity
    for (let k = d - H2.breakoutDays; k < d; k += 1) high = Math.max(high, rows[k].h)
    if (!(rows[d].c > high)) continue
    out.breakouts += 1
    const ee = e20[d], y = s50[d], z = s200[d], nd = n[d]
    if (!(ee != null && y != null && z != null && ee > y && y > z) || nd == null || !(nd > 0)) continue
    out.trend += 1
    let vol = 0
    for (let k = d - H2.volumeAvgDays; k < d; k += 1) vol += rows[k].v
    if (!(rows[d].v >= H2.volumeMult * (vol / H2.volumeAvgDays))) continue
    out.volume += 1
    if (s.bo[d]) out.tight += 1
  }
  for (let d = 0; d < rows.length; d += 1) if (rows[d].day >= sim.start && rows[d].day <= sim.end && s.rt[d]) out.retests += 1
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[h2] failed', error)
    process.exitCode = 1
  })
}
