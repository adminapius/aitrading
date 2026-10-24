// Strategy SW: swing trading by the course - BACKTEST ONLY. Spec (LOCKED Oct 24, 2026): docs/strategy-sw-spec.md
//
//   $env:ALPACA_API_KEY / $env:ALPACA_API_SECRET / $env:FMP_API_KEY / $env:SEC_USER_AGENT="Your Name you@example.com"
//   $env:NODE_OPTIONS="--max-old-space-size=8192"
//   npx tsx scripts/backtest/rulebook/strategy-sw.ts --window=tuning    --out=backtests/strategy-sw
//   npx tsx scripts/backtest/rulebook/strategy-sw.ts --window=validation --out=backtests/strategy-sw
//   npx tsx scripts/backtest/rulebook/strategy-sw.ts --window=holdout    --out=backtests/strategy-sw
//
// Each window runs once (lock file), in order: tuning, then validation, then holdout. Nothing changes after a run.
// Runs reported: SW-A only, SW-M only, combined (judged), plus the flat-$20 information line for the combined run.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getAssets, getDailyBars, getDailyBarsSplitAdjusted, type RawBar } from '../data'
import { toEasternDay } from '../universe'
import { RULEBOOK } from './config'
import { isCommonStock } from './data'
import { cikFor3, edgarStats, fmpProfile3, isForeignFiler, secCompany, type AnnualForm, type EarningsFiling } from './edgar-earnings'
import { atr, ema, isBullishEngulfing, isHammer, isMorningStar, macd, sma, type Bar } from './indicators'
import { parseArgs } from './runner'
import { universeMembers } from './strategy-sw-prefetch'

export const SW = {
  start: '2016-01-01',
  end: '2026-10-16',
  windows: { tuning: ['2016-01-01', '2022-12-31'], validation: ['2023-01-01', '2024-12-31'], holdout: ['2025-01-01', '2026-10-16'] } as Record<string, [string, string]>,
  minPrice: 10, minAvgVolume: 1_000_000, top: 500, rankPool: 700, avgDays: 50, gapSplitDays: 60,
  emaFast: 20, smaMid: 50, smaSlow: 100, smaLong: 200, atrDays: 20, testAtr: 0.25,
  macdFast: 12, macdSlow: 26, macdSignal: 9, swingDaysA: 3, swingDaysM: 10,
  stopSwingAtr: 0.5, stopEntryAtr: 2, minStopAtr: 1.5, maxStopAtr: 3,
  timeStopDays: 15, earningsBlockDays: 5, trendExitCloses: 2,
  risk: 0.01, riskInDrawdown: 0.005, drawdownTrigger: 0.1, maxOpen: 6, maxOpenRisk: 0.2, maxPerSector: 2,
  equity: 2000, flatRisk: 20, slippage: 0.0005, highDays: 252,
} as const

const C = RULEBOOK.costs
const NaN_ = Number.NaN
const fin = (x: number) => Number.isFinite(x)

// ---------------- pure helpers ----------------

/** Split a history at gaps of more than `maxGap` trading days (D2). Returns [start, end] row ranges. Pure. */
export function segmentRanges(dayIdx: number[], maxGap: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let s = 0
  for (let i = 1; i < dayIdx.length; i += 1) if (dayIdx[i] - dayIdx[i - 1] > maxGap) { out.push([s, i - 1]); s = i }
  if (dayIdx.length) out.push([s, dayIdx.length - 1])
  return out
}

/** Monday of the ISO week of a YYYY-MM-DD date. Pure. */
export function weekKey(day: string) {
  const t = Date.parse(`${day}T00:00:00Z`)
  const dow = (new Date(t).getUTCDay() + 6) % 7
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10)
}

/** Weekly MACD state per day from daily closes: bull[i] = 1/0/-1 (unknown) for the last COMPLETED week as of day i's
 *  close (a week completes at its last trading day); bearCross[i] = 1 when day i completes a week whose MACD line
 *  crossed below its signal. Pure. */
export function weeklyState(days: string[], closes: ArrayLike<number>) {
  const n = days.length
  const keys = days.map(weekKey)
  const weekEnds: number[] = []
  for (let i = 0; i < n; i += 1) if (i === n - 1 || keys[i + 1] !== keys[i]) weekEnds.push(i)
  const wClose = weekEnds.map((i) => closes[i])
  const m = macd(wClose, SW.macdFast, SW.macdSlow, SW.macdSignal)
  const bull = new Int8Array(n).fill(-1)
  const bearCross = new Uint8Array(n)
  let w = -1
  for (let i = 0; i < n; i += 1) {
    if (w + 1 < weekEnds.length && weekEnds[w + 1] === i) {
      w += 1
      const a = m.line[w], b = m.signal[w]
      const pa = w > 0 ? m.line[w - 1] : null, pb = w > 0 ? m.signal[w - 1] : null
      if (a != null && b != null && pa != null && pb != null && pa >= pb && a < b) bearCross[i] = 1
    }
    // w only advances on a week's last day, so mid-week days see the previous completed week (no look-ahead)
    const a = w >= 0 ? m.line[w] : null, b = w >= 0 ? m.signal[w] : null
    bull[i] = a == null || b == null ? -1 : a > b ? 1 : 0
  }
  return { bull, bearCross }
}

/** Initial stop and whether the trade is allowed: lower of (swing low - 0.5 ATR) and (fill - 2 ATR), 1.5-3 ATR. Pure. */
export function initialStop(fill: number, swingLow: number, dailyAtr: number) {
  const stop = Math.min(swingLow - SW.stopSwingAtr * dailyAtr, fill - SW.stopEntryAtr * dailyAtr)
  const dist = fill - stop
  const ok = dist > 0 && dist >= SW.minStopAtr * dailyAtr - 1e-9 && dist <= SW.maxStopAtr * dailyAtr + 1e-9
  return { stop, dist, ok, reason: dist > SW.maxStopAtr * dailyAtr ? 'stop wider than 3 ATR' : dist < SW.minStopAtr * dailyAtr ? 'stop tighter than 1.5 ATR' : '' }
}

/** R-trail at a close: +1R -> breakeven, +2R -> +1R, ...; never lowers. Pure. */
export function trailStop(stop: number, stop0: number, entry: number, r0: number, close: number) {
  const levels = Math.floor((close - entry) / r0 + 1e-9)
  return levels >= 1 ? Math.max(stop, stop0 + levels * r0) : stop
}

export type Earn = { date: string; time: 'bmo' | 'amc' | 'intraday' }
/** Earnings within the 5 trading days starting on the fill day (spy days fi..fi+4). Pure. */
export function earningsBlocked(list: Earn[] | undefined, spyDays: string[], fi: number) {
  if (!list?.length || fi < 0 || fi >= spyDays.length) return false
  const a = spyDays[fi], b = spyDays[Math.min(spyDays.length - 1, fi + SW.earningsBlockDays - 1)]
  return list.some((e) => e.date >= a && e.date <= b)
}
/** Exit at today's close before a report: after-close report today, or before-open / intraday report next trading day. Pure. */
export function earningsExitToday(list: Earn[] | undefined, today: string, nextDay: string | undefined) {
  if (!list?.length) return false
  return list.some((e) => (e.time === 'amc' && e.date === today) || (e.time !== 'amc' && nextDay != null && e.date === nextDay))
}

export function sharpe(equity: number[]) {
  const r: number[] = []
  for (let i = 1; i < equity.length; i += 1) if (equity[i - 1] > 0) r.push(equity[i] / equity[i - 1] - 1)
  if (r.length < 2) return NaN_
  const mean = r.reduce((s, x) => s + x, 0) / r.length
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1))
  return sd > 0 ? (mean / sd) * Math.sqrt(252) : NaN_
}
export function maxDrawdownPct(equity: number[]) {
  let peak = -Infinity, dd = 0
  for (const e of equity) { peak = Math.max(peak, e); if (peak > 0) dd = Math.max(dd, 1 - e / peak) }
  return dd
}
export function cagr(first: number, last: number, fromDay: string, toDay: string) {
  const years = (Date.parse(toDay) - Date.parse(fromDay)) / (365.25 * 86_400_000)
  return first > 0 && years > 0 ? (last / first) ** (1 / years) - 1 : NaN_
}

// ---------------- series ----------------

export type Stock = {
  id: string; base: string; days: string[]; idx: Map<string, number>
  o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array
  ema20: Float64Array; sma50: Float64Array; sma100: Float64Array; sma200: Float64Array; atr: Float64Array
  macd: Float64Array; sig: Float64Array; hi: Float64Array; dv: Float64Array
  wkBull: Int8Array; wkBearCross: Uint8Array
}

const f64 = (s: Array<number | null>) => Float64Array.from(s, (x) => (x == null ? NaN_ : x))

export function buildStock(id: string, base: string, rows: Array<{ day: string; o: number; h: number; l: number; c: number; v: number }>): Stock {
  const n = rows.length
  const closes = rows.map((r) => r.c)
  const bars: Bar[] = rows.map((r, i) => ({ t: i, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }))
  const m = macd(closes, SW.macdFast, SW.macdSlow, SW.macdSignal)
  const hi = new Float64Array(n)
  const dv = new Float64Array(n)
  let dvSum = 0
  for (let i = 0; i < n; i += 1) {
    let mx = -Infinity
    for (let k = Math.max(0, i - SW.highDays + 1); k <= i; k += 1) mx = Math.max(mx, closes[k])
    hi[i] = mx
    dvSum += rows[i].c * rows[i].v
    if (i >= SW.avgDays) dvSum -= rows[i - SW.avgDays].c * rows[i - SW.avgDays].v
    dv[i] = i >= SW.avgDays - 1 ? dvSum / SW.avgDays : NaN_
  }
  const days = rows.map((r) => r.day)
  const wk = weeklyState(days, closes)
  return {
    id, base, days, idx: new Map(days.map((d, i) => [d, i])),
    o: Float64Array.from(rows, (r) => r.o), h: Float64Array.from(rows, (r) => r.h), l: Float64Array.from(rows, (r) => r.l),
    c: Float64Array.from(closes), v: Float64Array.from(rows, (r) => r.v),
    ema20: f64(ema(closes, SW.emaFast)), sma50: f64(sma(closes, SW.smaMid)), sma100: f64(sma(closes, SW.smaSlow)), sma200: f64(sma(closes, SW.smaLong)),
    atr: f64(atr(bars, SW.atrDays)), macd: f64(m.line), sig: f64(m.signal), hi, dv, wkBull: wk.bull, wkBearCross: wk.bearCross,
  }
}

export function trendOk(s: Stock, i: number) {
  return fin(s.sma200[i]) && s.ema20[i] > s.sma50[i] && s.sma50[i] > s.sma100[i] && s.sma100[i] > s.sma200[i] && s.c[i] > s.sma50[i]
}

const barAt = (s: Stock, i: number): Bar => ({ t: i, o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i], v: s.v[i] })
export function confirmationCandle(s: Stock, i: number) {
  const b = barAt(s, i)
  return isHammer(b) || (i > 0 && isBullishEngulfing(barAt(s, i - 1), b)) || (i > 1 && isMorningStar(barAt(s, i - 2), barAt(s, i - 1), b))
}

/** SW-A pattern days (3rd counted test of the 20 EMA or 50 SMA with a confirmation candle), per D6. Pure. */
export function swaPatterns(s: Stock) {
  const out: Array<{ i: number; ma: '20 EMA' | '50 SMA'; swingLow: number }> = []
  type St = { count: number; H: number; armed: boolean }
  let inRun = false
  let runMax = -Infinity
  let st: Record<'e' | 's', St> = { e: { count: 0, H: 0, armed: false }, s: { count: 0, H: 0, armed: false } }
  for (let i = 0; i < s.days.length; i += 1) {
    const ok = trendOk(s, i) && fin(s.atr[i])
    if (!ok) { inRun = false; continue }
    if (!inRun) { inRun = true; runMax = -Infinity; st = { e: { count: 0, H: 0, armed: false }, s: { count: 0, H: 0, armed: false } } }
    runMax = Math.max(runMax, s.h[i])
    let fired = false
    for (const key of ['e', 's'] as const) {
      const ma = key === 'e' ? s.ema20[i] : s.sma50[i]
      const x = st[key]
      const test = s.l[i] <= ma + SW.testAtr * s.atr[i] && s.c[i] > ma
      if (test && (x.count === 0 || x.armed)) {
        x.count += 1
        x.H = runMax
        x.armed = false
        if (x.count === 3 && !fired && confirmationCandle(s, i)) {
          out.push({ i, ma: key === 'e' ? '20 EMA' : '50 SMA', swingLow: Math.min(...Array.from({ length: SW.swingDaysA }, (_, k) => s.l[Math.max(0, i - k)])) })
          fired = true
        }
      } else if (x.count >= 1 && !x.armed && s.h[i] > x.H) x.armed = true
    }
  }
  return out
}

/** SW-M pattern days: daily MACD crosses above its signal at day i. Pure. */
export function swmPatterns(s: Stock) {
  const out: Array<{ i: number; swingLow: number; confirmed: boolean }> = []
  for (let i = 1; i < s.days.length; i += 1) {
    if (!(fin(s.macd[i]) && fin(s.sig[i]) && fin(s.macd[i - 1]) && fin(s.sig[i - 1]))) continue
    if (!(s.macd[i] > s.sig[i] && s.macd[i - 1] <= s.sig[i - 1])) continue
    const confirmed = i + 1 < s.days.length && s.macd[i + 1] > s.sig[i + 1]
    out.push({ i, confirmed, swingLow: Math.min(...Array.from({ length: SW.swingDaysM }, (_, k) => s.l[Math.max(0, i - k)])) })
  }
  return out
}

// ---------------- portfolio simulation ----------------

export type Signal = { id: string; base: string; setup: 'A' | 'M'; signalDay: string; fillDay: string; swingLow: number; atr: number; rank: number; dv: number; note: string }
export type Trade = {
  run: string; id: string; setup: 'A' | 'M'; signalDay: string; entryDay: string; entry: number; stop0: number; r0: number; shares: number
  exitDay: string; exit: number; reason: string; pnl: number; fees: number; r: number; holdDays: number; flatShares: number; flatPnl: number; flatR: number; note: string
}

type Pos = { sig: Signal; s: Stock; entry: number; stop: number; stop0: number; r0: number; shares: number; entryDay: string; held: number; reached1R: boolean; below: number; pending: string | null; sector: string }

export function simulate(run: string, signals: Signal[], stocks: Map<string, Stock>, sectorOf: (base: string) => string | null,
  earn: (base: string) => Earn[] | undefined, spyDays: string[], from: string, to: string) {
  const days = spyDays.filter((d) => d >= from && d <= to)
  const spyIdx = new Map(spyDays.map((d, i) => [d, i]))
  const byFill = new Map<string, Signal[]>()
  for (const s of signals) if (s.fillDay >= from && s.fillDay <= to) { const l = byFill.get(s.fillDay) ?? []; l.push(s); byFill.set(s.fillDay, l) }
  let cash: number = SW.equity
  let peak: number = SW.equity
  const open: Pos[] = []
  const trades: Trade[] = []
  const equity: number[] = []
  const eqDays: string[] = []
  const blocks: Record<string, number> = {}
  const block = (k: string) => { blocks[k] = (blocks[k] ?? 0) + 1 }
  const lastClose = new Map<string, number>()
  const mark = () => cash + open.reduce((sum, p) => sum + p.shares * (lastClose.get(p.s.id) ?? p.entry), 0)
  const sell = (p: Pos, day: string, price: number, reason: string) => {
    const fees = price * p.shares * C.secFeePerDollar + Math.min(p.shares * C.finraTafPerShare, C.finraTafMaxPerTrade)
    const pnl = p.shares * (price - p.entry) - fees
    cash += p.shares * price - fees
    const flatShares = Math.floor(SW.flatRisk / p.r0)
    const flatFees = flatShares > 0 ? price * flatShares * C.secFeePerDollar + Math.min(flatShares * C.finraTafPerShare, C.finraTafMaxPerTrade) : 0
    const flatPnl = flatShares * (price - p.entry) - flatFees
    trades.push({ run, id: p.s.id, setup: p.sig.setup, signalDay: p.sig.signalDay, entryDay: p.entryDay, entry: p.entry, stop0: p.stop0, r0: p.r0, shares: p.shares,
      exitDay: day, exit: price, reason, pnl, fees, r: pnl / (p.shares * p.r0), holdDays: p.held, flatShares, flatPnl, flatR: flatShares > 0 ? flatPnl / (flatShares * p.r0) : 0, note: p.sig.note })
    open.splice(open.indexOf(p), 1)
  }
  const slip = (x: number, dir: 1 | -1) => x * (1 + dir * SW.slippage)
  for (const [k, day] of days.entries()) {
    const nextDay = spyDays[(spyIdx.get(day) ?? 0) + 1]
    // 1. at the open: pending exits, then gap-stops
    for (const p of [...open]) {
      const i = p.s.idx.get(day)
      if (i == null) continue
      if (p.pending) { sell(p, day, slip(p.s.o[i], -1), p.pending); continue }
      if (p.s.o[i] <= p.stop) sell(p, day, slip(p.s.o[i], -1), 'gap-stop')
    }
    // 2. entries at the open
    const todays = (byFill.get(day) ?? []).sort((a, b) => b.rank - a.rank || b.dv - a.dv || a.id.localeCompare(b.id))
    for (const sg of todays) {
      const s = stocks.get(sg.id)!
      const i = s.idx.get(day)
      if (i == null) { block('no bar on the fill day'); continue }
      if (open.some((p) => p.s.base === sg.base)) { block('already holding the stock'); continue }
      const fill = slip(s.o[i], 1)
      const st = initialStop(fill, sg.swingLow, sg.atr)
      if (!st.ok) { block(st.reason || 'stop outside 1.5-3 ATR'); continue }
      if (open.length >= SW.maxOpen) { block('6 positions open'); continue }
      const sector = sectorOf(sg.base) ?? `(none) ${sg.base}`
      if (open.filter((p) => p.sector === sector).length >= SW.maxPerSector) { block('2 positions in the sector'); continue }
      const eq = mark()
      const riskFrac = eq < (1 - SW.drawdownTrigger) * peak ? SW.riskInDrawdown : SW.risk
      let shares = Math.floor((eq * riskFrac) / st.dist)
      const openRisk = open.reduce((sum, p) => sum + p.shares * Math.max(0, p.entry - p.stop), 0)
      if (shares >= 1 && openRisk + shares * st.dist > SW.maxOpenRisk * eq) { block('20% open-risk cap'); continue }
      shares = Math.min(shares, Math.floor(cash / fill))
      if (shares < 1) { block('cash (no margin) or risk under 1 share'); continue }
      cash -= shares * fill
      const p: Pos = { sig: sg, s, entry: fill, stop: st.stop, stop0: st.stop, r0: st.dist, shares, entryDay: day, held: 0, reached1R: false, below: 0, pending: null, sector }
      open.push(p)
      lastClose.set(s.id, s.c[i])
    }
    // 3. during the day: stops
    for (const p of [...open]) {
      const i = p.s.idx.get(day)
      if (i == null) continue
      if (p.s.l[i] <= p.stop) sell(p, day, slip(p.stop, -1), 'stop')
    }
    // 4. at the close
    for (const p of [...open]) {
      const i = p.s.idx.get(day)
      if (i == null) continue
      const s = p.s
      lastClose.set(s.id, s.c[i])
      p.held += 1
      if (earningsExitToday(earn(s.base), day, nextDay)) { sell(p, day, slip(s.c[i], -1), 'earnings'); continue }
      if (i === s.days.length - 1 && day < SW.end) { sell(p, day, slip(s.c[i], -1), 'last bar (delisted / data ends)'); continue }
      if (k === days.length - 1) { sell(p, day, slip(s.c[i], -1), 'end of window'); continue }
      if (s.c[i] >= p.entry + p.r0) p.reached1R = true
      p.stop = trailStop(p.stop, p.stop0, p.entry, p.r0, s.c[i])
      p.below = s.c[i] < s.sma50[i] ? p.below + 1 : 0
      if (p.below >= SW.trendExitCloses) p.pending = 'trend (2 closes below 50 SMA)'
      else if (p.sig.setup === 'M' && s.wkBearCross[i]) p.pending = 'weekly MACD bearish cross'
      else if (!p.reached1R && p.held >= SW.timeStopDays) p.pending = 'time stop (no +1R in 15 days)'
    }
    // positions whose stock has no bar on the window's last day
    if (k === days.length - 1) for (const p of [...open]) sell(p, day, slip(lastClose.get(p.s.id) ?? p.entry, -1), 'end of window')
    const eqNow = mark()
    peak = Math.max(peak, eqNow)
    equity.push(eqNow)
    eqDays.push(day)
  }
  return { trades, equity, eqDays, blocks }
}

// ---------------- report ----------------

function tstats(list: Trade[], pick: (t: Trade) => { r: number; pnl: number } = (t) => t) {
  const rs = list.map((t) => pick(t).r)
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0)
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  let cum = 0, pk = 0, dd = 0
  for (const t of [...list].sort((a, b) => a.exitDay.localeCompare(b.exitDay))) { cum += pick(t).r; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum) }
  const lossSum = Math.abs(sum(rs.filter((r) => r < 0)))
  return { n: list.length, win: list.length ? wins.length / list.length : null, avgWin: wins.length ? sum(wins) / wins.length : null, avgLoss: losses.length ? sum(losses) / losses.length : null,
    exp: list.length ? sum(rs) / list.length : null, pf: lossSum > 0 ? sum(wins) / lossSum : wins.length ? Infinity : null, ddR: dd, largest: rs.length ? Math.min(...rs) : null,
    totalR: sum(rs), totalPnl: sum(list.map((t) => pick(t).pnl)), hold: list.length ? sum(list.map((t) => t.holdDays)) / list.length : null }
}
const f2 = (x: number | null | undefined, d = 2) => (x == null || Number.isNaN(x) ? 'n/a' : x === Infinity ? 'inf' : x.toFixed(d))
const pc = (x: number | null | undefined, d = 0) => (x == null || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`)

function periodShare(eqDays: string[], equity: number[], len: 7 | 4) {
  const last = new Map<string, number>()
  let prev: number = SW.equity
  const order: string[] = []
  for (let i = 0; i < eqDays.length; i += 1) { const k = eqDays[i].slice(0, len); if (!last.has(k)) order.push(k); last.set(k, equity[i]) }
  let up = 0
  for (const k of order) { if (last.get(k)! > prev) up += 1; prev = last.get(k)! }
  return { up, total: order.length }
}

// ---------------- main ----------------

async function main() {
  const args = parseArgs()
  const window = args.get('window') ?? ''
  if (!SW.windows[window]) throw new Error('Pass --window=tuning, --window=validation or --window=holdout')
  const order = ['tuning', 'validation', 'holdout']
  const out = join(process.cwd(), args.get('out') ?? 'backtests/strategy-sw')
  const lock = join(out, window, 'RUN-LOCK.json')
  if (existsSync(lock)) throw new Error(`Strategy SW ${window} has already been run (${lock}). Each window runs once.`)
  const prevWindow = order[order.indexOf(window) - 1]
  if (prevWindow && !existsSync(join(out, prevWindow, 'RUN-LOCK.json'))) throw new Error(`Run --window=${prevWindow} first (windows run in order: tuning, validation, holdout).`)
  for (const name of ['ALPACA_API_KEY', 'FMP_API_KEY', 'SEC_USER_AGENT']) if (!process.env[name]?.trim()) throw new Error(`Set ${name} in this window first.`)
  const [from, to] = SW.windows[window]
  const t0 = Date.now()
  const log = (s: string) => console.log(s)
  const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`

  // 1. raw daily for every common stock -> segments (D2) -> point-in-time ranking pool
  const assets = await getAssets()
  const status = new Map<string, boolean>()
  for (const a of assets) {
    if (a.class && a.class !== 'us_equity') continue
    if (!isCommonStock(a.symbol, a.name ?? '')) continue
    if (!status.has(a.symbol)) status.set(a.symbol, a.status === 'active')
  }
  const commons = [...status.keys()].sort()
  const raw = await getDailyBars(['SPY', ...commons], SW.start, SW.end)
  const spyDays = ((raw.SPY ?? []) as RawBar[]).map((b) => toEasternDay(b.t))
  const spyIdx = new Map(spyDays.map((d, i) => [d, i]))
  const segOf = new Map<string, Array<{ id: string; from: string; to: string }>>()
  const rawSeg = new Map<string, Array<{ day: string; c: number; v: number }>>()
  for (const sym of commons) {
    const list = (raw[sym] ?? []) as RawBar[]
    delete raw[sym]
    if (!list.length) continue
    const rows = list.map((b) => ({ day: toEasternDay(b.t), c: b.c, v: b.v })).filter((r) => spyIdx.has(r.day))
    const ranges = segmentRanges(rows.map((r) => spyIdx.get(r.day)!), SW.gapSplitDays)
    const segs: Array<{ id: string; from: string; to: string }> = []
    for (const [n, [a, b]] of ranges.entries()) {
      const id = n === 0 ? sym : `${sym}~${n + 1}`
      rawSeg.set(id, rows.slice(a, b + 1))
      segs.push({ id, from: rows[a].day, to: rows[b].day })
    }
    segOf.set(sym, segs)
  }
  const pool = universeMembers(rawSeg, spyDays, { minPrice: SW.minPrice, minAvgVolume: SW.minAvgVolume, top: SW.rankPool, avgDays: SW.avgDays })
  rawSeg.clear()
  const poolIds = new Set<string>()
  for (const list of pool.values()) for (const id of list) poolIds.add(id)
  const baseOf = (id: string) => id.split('~')[0]
  const bases = [...new Set([...poolIds].map(baseOf))].sort()
  log(`[sw] ${window} ${from} to ${to}; ranking pool: ${poolIds.size} stock histories (${bases.length} tickers) ever in the top ${SW.rankPool} (${mins()})`)

  // 2. company data: FMP profile (ADR flag, sector), SEC filings (annual forms, earnings 8-Ks)
  const profile = new Map<string, Awaited<ReturnType<typeof fmpProfile3>>>()
  const company = new Map<string, { earnings: EarningsFiling[]; annual: AnnualForm[] }>()
  for (const [n, b] of bases.entries()) {
    const p = await fmpProfile3(b)
    profile.set(b, p)
    const cik = await cikFor3(b, p)
    company.set(b, cik ? await secCompany(cik) : { earnings: [], annual: [] })
    if ((n + 1) % 250 === 0) log(`      company data ${n + 1} / ${bases.length} (${mins()}; SEC ${edgarStats.secRequests}, FMP ${edgarStats.fmpRequests})`)
  }
  const foreignOn = (b: string, day: string) => (profile.get(b)?.isAdr ?? false) || isForeignFiler(company.get(b)?.annual ?? [], day)
  const members = new Map<string, Set<string>>()
  let removedForeign = 0
  const foreignTickers = new Set<string>()
  for (const [day, list] of pool) {
    const kept: string[] = []
    for (const id of list) {
      if (kept.length >= SW.top) break
      if (foreignOn(baseOf(id), day)) { removedForeign += 1; foreignTickers.add(baseOf(id)); continue }
      kept.push(id)
    }
    members.set(day, new Set(kept))
  }
  const memberIds = new Set<string>()
  for (const set of members.values()) for (const id of set) memberIds.add(id)
  const delisted = [...memberIds].filter((id) => !status.get(baseOf(id))).length
  log(`[sw] universe after D11: ${memberIds.size} stock histories ever in the top ${SW.top} (${delisted} now delisted); foreign filers / ADRs removed: ${foreignTickers.size} tickers [${[...foreignTickers].slice(0, 20).join(', ')}${foreignTickers.size > 20 ? ', ...' : ''}]`)

  // 3. split-adjusted daily bars -> indicator series for every member history + SPY
  const memberBases = [...new Set([...memberIds].map(baseOf))].sort()
  const stocks = new Map<string, Stock>()
  let spy: Stock | null = null
  for (let i = 0; i < memberBases.length; i += 1000) {
    const batch = memberBases.slice(i, i + 1000)
    const adj = await getDailyBarsSplitAdjusted(i === 0 ? ['SPY', ...batch] : batch, SW.start, SW.end)
    if (i === 0) spy = buildStock('SPY', 'SPY', ((adj.SPY ?? []) as RawBar[]).map((b) => ({ day: toEasternDay(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })))
    for (const b of batch) {
      const rows = ((adj[b] ?? []) as RawBar[]).map((x) => ({ day: toEasternDay(x.t), o: x.o, h: x.h, l: x.l, c: x.c, v: x.v })).filter((r) => spyIdx.has(r.day))
      for (const seg of segOf.get(b) ?? []) {
        if (!memberIds.has(seg.id)) continue
        const part = rows.filter((r) => r.day >= seg.from && r.day <= seg.to)
        if (part.length) stocks.set(seg.id, buildStock(seg.id, b, part))
      }
      delete adj[b]
    }
    log(`      series ${Math.min(i + 1000, memberBases.length)} / ${memberBases.length} (${mins()})`)
  }
  if (!spy) throw new Error('No SPY data')
  const spyMarket = (day: string) => { const i = spy!.idx.get(day); return i != null && fin(spy!.sma200[i]) && spy!.sma50[i] > spy!.sma200[i] }
  const earnMap = new Map<string, Earn[]>()
  for (const b of memberBases) earnMap.set(b, (company.get(b)?.earnings ?? []).map((e) => ({ date: e.date, time: e.time })))
  const earn = (b: string) => earnMap.get(b)

  // earnings coverage after D11 (universe stock-years)
  const cov: string[] = []
  let cg = 0, ct = 0
  for (let y = 2016; y <= 2026; y += 1) {
    const ys = String(y)
    const ids = new Set<string>()
    for (const [d, set] of members) if (d.startsWith(ys)) for (const id of set) ids.add(id)
    let n = 0, ok = 0
    for (const id of ids) {
      const s = stocks.get(id)
      if (!s) continue
      if (s.days.filter((d) => d.startsWith(ys)).length < (y === 2026 ? 150 : 200)) continue
      n += 1
      if ((earn(s.base) ?? []).filter((e) => e.date.startsWith(ys)).length >= (y === 2026 ? 2 : 3)) ok += 1
    }
    cg += ok; ct += n
    cov.push(`${y} ${n ? pc(ok / n) : '-'} of ${n}`)
  }
  log(`[sw] earnings coverage after D11 (universe stock-years with >= 3 earnings 8-Ks; >= 2 for 2026): ${cov.join(', ')} -> ${ct ? pc(cg / ct) : 'n/a'} overall`)

  // 4. signals (setup + filters), counted per window by the signal day
  const signals: Signal[] = []
  const filt: Record<'A' | 'M', Record<string, number>> = { A: {}, M: {} }
  const fb = (setup: 'A' | 'M', k: string) => { filt[setup][k] = (filt[setup][k] ?? 0) + 1 }
  const inWin = (d: string) => d >= from && d <= to
  for (const s of stocks.values()) {
    const fillAt = (i: number, ahead: number) => { const k = spyIdx.get(s.days[i]); return k == null ? undefined : spyDays[k + ahead] }
    for (const p of swaPatterns(s)) {
      const day = s.days[p.i]
      const fill = fillAt(p.i, 1)
      if (!fill || !inWin(fill)) continue
      fb('A', 'patterns (3rd test + candle, in an uptrend)')
      if (!members.get(day)?.has(s.id)) { fb('A', 'blocked: not in the universe'); continue }
      if (!spyMarket(day)) { fb('A', 'blocked: market (SPY 50 SMA <= 200 SMA)'); continue }
      if (s.wkBull[p.i] !== 1) { fb('A', 'blocked: weekly MACD not bullish'); continue }
      if (earningsBlocked(earn(s.base), spyDays, spyIdx.get(fill)!)) { fb('A', 'blocked: earnings within 5 days'); continue }
      fb('A', 'passed all filters')
      signals.push({ id: s.id, base: s.base, setup: 'A', signalDay: day, fillDay: fill, swingLow: p.swingLow, atr: s.atr[p.i], rank: s.c[p.i] / s.hi[p.i], dv: s.dv[p.i] || 0, note: `3rd test of the ${p.ma}` })
    }
    for (const p of swmPatterns(s)) {
      const day = s.days[p.i]
      const fill = fillAt(p.i, 2)
      if (!fill || !inWin(fill)) continue
      fb('M', 'patterns (daily MACD cross up)')
      if (!members.get(day)?.has(s.id)) { fb('M', 'blocked: not in the universe'); continue }
      if (!spyMarket(day)) { fb('M', 'blocked: market (SPY 50 SMA <= 200 SMA)'); continue }
      if (!trendOk(s, p.i)) { fb('M', 'blocked: stock trend (20>50>100>200, close > 50)'); continue }
      if (s.wkBull[p.i] !== 1) { fb('M', 'blocked: weekly MACD not bullish'); continue }
      if (!p.confirmed) { fb('M', 'blocked: cross failed the next day'); continue }
      if (earningsBlocked(earn(s.base), spyDays, spyIdx.get(fill)!)) { fb('M', 'blocked: earnings within 5 days'); continue }
      fb('M', 'passed all filters')
      signals.push({ id: s.id, base: s.base, setup: 'M', signalDay: day, fillDay: fill, swingLow: p.swingLow, atr: s.atr[p.i], rank: s.c[p.i] / s.hi[p.i], dv: s.dv[p.i] || 0, note: 'daily MACD cross up' })
    }
  }
  const sectorOf = (b: string) => profile.get(b)?.sector ?? null

  // 5. runs
  const runs: Array<[string, Signal[]]> = [['SW-A', signals.filter((s) => s.setup === 'A')], ['SW-M', signals.filter((s) => s.setup === 'M')], ['SW combined', signals]]
  const results = runs.map(([name, list]) => ({ name, ...simulate(name, list, stocks, sectorOf, earn, spyDays, from, to) }))
  const spyDaysWin = spyDays.filter((d) => d >= from && d <= to)
  const spyEq = spyDaysWin.map((d) => spy!.c[spy!.idx.get(d)!])
  const spyStats = { cagr: cagr(spyEq[0], spyEq[spyEq.length - 1], spyDaysWin[0], spyDaysWin[spyDaysWin.length - 1]), dd: maxDrawdownPct(spyEq), sharpe: sharpe(spyEq) }

  log(`\n[sw] ===== STRATEGY SW ${window.toUpperCase()} ${from} to ${to} (${spyDaysWin.length} trading days) =====`)
  for (const setup of ['A', 'M'] as const) log(`[sw] SW-${setup} signal funnel: ${JSON.stringify(filt[setup])}`)
  for (const r of results) {
    const s = tstats(r.trades)
    const final = r.equity[r.equity.length - 1] ?? SW.equity
    const mo = periodShare(r.eqDays, r.equity, 7)
    const yr = periodShare(r.eqDays, r.equity, 4)
    log(`\n[sw] ${r.name}: ${s.n} trades, win ${pc(s.win)}, avg win ${f2(s.avgWin)}R / loss ${f2(s.avgLoss)}R, exp ${f2(s.exp)}R, PF ${f2(s.pf)}, max DD ${f2(s.ddR, 1)}R / ${pc(maxDrawdownPct(r.equity), 1)}, largest loss ${f2(s.largest)}R, total ${f2(s.totalR, 1)}R / $${f2(s.totalPnl)}`)
    log(`      $2,000 -> $${f2(final)}, CAGR ${pc(cagr(SW.equity, final, spyDaysWin[0], spyDaysWin[spyDaysWin.length - 1]), 1)}, Sharpe ${f2(sharpe([SW.equity, ...r.equity]))}, profitable months ${mo.up} of ${mo.total} (${pc(mo.up / Math.max(1, mo.total))}), years ${yr.up} of ${yr.total}, avg hold ${f2(s.hold, 1)} trading days`)
    const reasons = new Map<string, Trade[]>()
    for (const t of r.trades) reasons.set(t.reason, [...(reasons.get(t.reason) ?? []), t])
    log(`      exits: ${[...reasons].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `${k} ${v.length} (${f2(v.reduce((x, t) => x + t.r, 0), 1)}R)`).join(', ')}; gap-stops ${reasons.get('gap-stop')?.length ?? 0}`)
    log(`      portfolio / fill blocks: ${JSON.stringify(r.blocks)}`)
    if (r.name === 'SW combined') {
      const fl = tstats(r.trades, (t) => ({ r: t.flatR, pnl: t.flatPnl }))
      log(`      flat $20 line (same trades, no cash cap): exp ${f2(fl.exp)}R, PF ${f2(fl.pf)}, max DD ${f2(fl.ddR, 1)}R, total ${f2(fl.totalR, 1)}R / $${f2(fl.totalPnl)}`)
      for (const setup of ['A', 'M'] as const) { const ss = tstats(r.trades.filter((t) => t.setup === setup)); log(`      inside combined, SW-${setup}: ${ss.n} trades, exp ${f2(ss.exp)}R, PF ${f2(ss.pf)}, total ${f2(ss.totalR, 1)}R / $${f2(ss.totalPnl)}`) }
    }
  }
  log(`\n[sw] SPY buy-and-hold (split-adjusted, no dividends): CAGR ${pc(spyStats.cagr, 1)}, max DD ${pc(spyStats.dd, 1)}, Sharpe ${f2(spyStats.sharpe)}`)

  const comb = results.find((r) => r.name === 'SW combined')!
  const cs = tstats(comb.trades)
  const swSharpe = sharpe([SW.equity, ...comb.equity])
  if (window === 'holdout') {
    const checks: Array<[string, boolean]> = [
      [`trades ${cs.n} >= 60`, cs.n >= 60], [`expectancy ${f2(cs.exp)}R > +0.20R`, (cs.exp ?? -Infinity) > 0.2], [`PF ${f2(cs.pf)} > 1.4`, (cs.pf ?? 0) > 1.4],
      [`max DD ${f2(cs.ddR, 1)}R < 15R`, cs.ddR < 15], [`largest loss ${f2(cs.largest)}R, under 3R`, cs.largest == null || cs.largest > -3], [`dollars $${f2(cs.totalPnl)} > 0`, cs.totalPnl > 0],
      [`Sharpe ${f2(swSharpe)} > SPY ${f2(spyStats.sharpe)}`, swSharpe > spyStats.sharpe],
    ]
    log(`[sw] PASS RULE (holdout, combined): ${checks.map(([t, ok]) => `${t} ${ok ? 'ok' : 'FAIL'}`).join('; ')} -> ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'} (validation must also have been positive)`)
  } else if (window === 'validation') {
    const ok = cs.totalR > 0 && cs.totalPnl > 0
    log(`[sw] VALIDATION CONDITION (combined positive in R and $): total ${f2(cs.totalR, 1)}R / $${f2(cs.totalPnl)} -> ${ok ? 'MET' : 'NOT MET'}`)
  } else log('[sw] tuning: report only (the pass rule is judged in the holdout; validation must be positive)')
  log(`[sw] data: SEC requests ${edgarStats.secRequests}, FMP profiles ${edgarStats.fmpRequests}; done in ${mins()}`)

  mkdirSync(join(out, window), { recursive: true })
  const head = 'run,ticker,setup,signal_day,entry_day,entry,initial_stop,r_per_share,shares,exit_day,exit,exit_reason,r,pnl,fees,hold_days,flat_shares,flat_r,flat_pnl,note'
  const rows = results.flatMap((r) => r.trades).map((t) => [t.run, t.id, t.setup, t.signalDay, t.entryDay, t.entry.toFixed(4), t.stop0.toFixed(4), t.r0.toFixed(4), t.shares, t.exitDay, t.exit.toFixed(4), `"${t.reason}"`, t.r.toFixed(3), t.pnl.toFixed(2), t.fees.toFixed(4), t.holdDays, t.flatShares, t.flatR.toFixed(3), t.flatPnl.toFixed(2), `"${t.note}"`].join(','))
  writeFileSync(join(out, window, 'trades.csv'), [head, ...rows].join('\n') + '\n')
  writeFileSync(join(out, window, 'summary.json'), JSON.stringify({ window, from, to, funnel: filt, spy: spyStats, runs: results.map((r) => ({ name: r.name, ...tstats(r.trades), blocks: r.blocks, sharpe: sharpe([SW.equity, ...r.equity]), final: r.equity[r.equity.length - 1], equity: r.eqDays.map((d, i) => [d, Number(r.equity[i].toFixed(2))]) })) }, (_k, v) => (v === Infinity ? 'inf' : v), 1))
  writeFileSync(lock, JSON.stringify({ ranAt: new Date().toISOString(), window, trades: Object.fromEntries(results.map((r) => [r.name, r.trades.length])) }, null, 2))
  log(`[sw] wrote ${join(out, window)}: trades.csv (all runs), summary.json, RUN-LOCK.json`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[sw] failed', error)
    process.exitCode = 1
  })
}
