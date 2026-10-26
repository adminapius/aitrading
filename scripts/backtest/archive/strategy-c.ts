// ARCHIVED Oct 25, 2026 (parked; FAIL or parked verdict in its spec). Kept for the record; not run by anything.
// Strategy C (rest-of-day momentum, SPY) - BACKTEST ONLY. Spec (LOCKED Oct 24, 2026): docs/strategy-c-spec.md
//
//   $env:ALPACA_API_KEY / $env:ALPACA_API_SECRET / $env:FMP_API_KEY
//   npx tsx scripts/backtest/strategy-c.ts --probe        (data coverage only; computes NO returns)
//   npx tsx scripts/backtest/strategy-c.ts --close-check  (D2 follow-up: which close is right on mismatch days; NO returns)
//
//   npx tsx scripts/backtest/strategy-c.ts --run          (LOCKED: both windows, every line, ONCE; writes backtests/strategy-c/run)
//
// The probe also downloads and caches everything the run needs, so the run itself is mostly a cache read.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ALPACA_DATA_URL, ALPACA_TRADING_URL, apiStats, fetchJson, getDailyBars, getDailyBarsAdjusted, HISTORICAL_FEED, readCache, writeCache, type RawBar } from '../data'
import { easternMidnight } from '../market'
import { toEasternDay } from '../universe'

export const C = {
  symbols: ['SPY', 'QQQ', 'IWM', 'DIA'] as const,
  /** Primary listing exchange (SIP exchange code): where the closing auction prints. */
  primary: { SPY: 'P', QQQ: 'Q', IWM: 'P', DIA: 'P' } as Record<string, string>,
  passFail: ['2020-06-01', '2026-10-16'] as [string, string],
  consistency: ['2016-01-04', '2020-05-29'] as [string, string],
  dataStart: '2015-11-01', // prior closes and the first month of the 10-month average are not needed before this
  signalMinute: 15 * 60 + 29, // r uses the close of the 15:29 bar
  entryMinute: 15 * 60 + 30, // fill at the 15:30 bar's open (D3)
  lateEntryMinute: 15 * 60 + 31, // D3 information line
}

export type CalendarDay = { date: string; open: string; close: string }
export type Trade = { t: string; x: string; p: number; s: number; c?: string[] }

/** Half day = the session closes before 16:00 (D7). Pure. */
export const isHalfDay = (day: Pick<CalendarDay, 'close'>) => day.close.slice(0, 5) !== '16:00'

/**
 * Official close from the trades printed just after 16:00 (D2): on the primary exchange, the market-center official
 * close message (condition M) if present, otherwise the largest closing print (condition 6). Pure.
 */
export function closingPrint(trades: Trade[], primary: string): { price: number; kind: 'M' | '6' } | null {
  const own = trades.filter((t) => t.x === primary && t.p > 0)
  const m = own.find((t) => (t.c ?? []).includes('M'))
  if (m) return { price: m.p, kind: 'M' }
  const six = own.filter((t) => (t.c ?? []).includes('6')).sort((a, b) => b.s - a.s)[0]
  return six ? { price: six.p, kind: '6' } : null
}

/**
 * One-day dividend factor for day D (D1): (adj/raw on D-1) / (adj/raw on D), from Alpaca dividend-adjusted vs raw
 * daily closes. On an ex-dividend day it is 1 - dividend / prior close; otherwise 1. Prior close x factor = prior
 * close minus that day's dividend. Pure.
 */
export function dividendFactor(rawPrev: number, adjPrev: number, rawDay: number, adjDay: number) {
  if (!(rawPrev > 0 && adjPrev > 0 && rawDay > 0 && adjDay > 0)) return 1
  const f = (adjPrev / rawPrev) / (adjDay / rawDay)
  // A real dividend is at least half a cent a share; smaller ratios are rounding in the adjusted closes (probe, Oct 25).
  return Math.abs(1 - f) * rawPrev < 0.005 ? 1 : f
}

/** Which of two closing prices is nearer a reference (the 15:59 bar close). Pure. */
export function closerTo(ref: number, print: number, daily: number): 'print' | 'daily' | 'tie' {
  const a = Math.abs(print - ref), b = Math.abs(daily - ref)
  return Math.abs(a - b) < 1e-9 ? 'tie' : a < b ? 'print' : 'daily'
}

// ---------------- run: pure simulation (spec sections 1-5) ----------------

/** D11: SEC $20.60 per $1M sold, FINRA TAF $0.000195 per share sold (max $9.79), commission $0. */
export const FEES = { secPerDollar: 20.6 / 1e6, tafPerShare: 0.000195, tafMax: 9.79 }
export const sellFees = (shares: number, price: number) => shares * price * FEES.secPerDollar + Math.min(shares * FEES.tafPerShare, FEES.tafMax)

/** Everything the rule needs for one ETF on one session. Prices raw (not adjusted); undefined = missing. */
export type DayInput = {
  date: string
  half: boolean
  c1529?: number // close of the 15:29 bar (the signal price, D1)
  o1530?: number // open of the 15:30 bar (entry, D3)
  o1531?: number // open of the 15:31 bar (D3 information line)
  prevClose?: number // prior session's official close (D2)
  close?: number // today's official close (D2)
  closeSrc?: 'print' | 'daily'
  prevSrc?: 'print' | 'daily'
  divFactor: number // D1: one-day dividend factor, 1 on a non-ex-dividend day
  vixPrev?: number // D8: prior session's VIX close
}
export type LineOpts = { slip: number; adjustDividend: boolean; late: boolean; fractional: boolean; longShort: boolean }
export const BASE: LineOpts = { slip: 0.01, adjustDividend: true, late: false, fractional: false, longShort: false }
export type CTrade = { date: string; side: 'long' | 'short'; r: number; shares: number; entry: number; exit: number; pnl: number; ret: number; acctRet: number; idleCash: number; equityBefore: number; vixPrev?: number; closeSrc?: string; prevSrc?: string }
export type DailyPoint = { date: string; ret: number; equity: number; inMarket: boolean }
export type LineResult = { trades: CTrade[]; daily: DailyPoint[]; skips: Record<string, number>; flatDays: number; start: number }

/**
 * One line over one window (every session in the window, in order). Long when r > 0 (or short when r <= 0 on the
 * long/short line), buy at the fill bar's open + slippage, sell at the official close - slippage, fees on the sell
 * (on the short line: on the short sale). Whole shares unless fractional; the rest stays as cash earning 0. Pure.
 */
export function runLine(days: DayInput[], o: LineOpts, start = 2000): LineResult {
  let equity = start
  const trades: CTrade[] = [], daily: DailyPoint[] = [], skips: Record<string, number> = {}
  let flatDays = 0
  const idle = (date: string) => daily.push({ date, ret: 0, equity, inMarket: false })
  for (const d of days) {
    const skip = (why: string) => { skips[why] = (skips[why] ?? 0) + 1; idle(d.date) }
    if (d.half) { skip('half day'); continue }
    if (d.c1529 == null) { skip('no 15:29 bar'); continue }
    const bar = o.late ? d.o1531 : d.o1530
    if (bar == null) { skip(o.late ? 'no 15:31 bar' : 'no 15:30 bar'); continue }
    if (d.prevClose == null) { skip('no prior close'); continue }
    if (d.close == null) { skip('no closing price'); continue }
    const prev = d.prevClose * (o.adjustDividend ? d.divFactor : 1)
    const r = d.c1529 / prev - 1
    const side = r > 0 ? 'long' : o.longShort ? 'short' : null
    if (!side) { flatDays += 1; idle(d.date); continue }
    const entry = side === 'long' ? bar + o.slip : bar - o.slip
    const exit = side === 'long' ? d.close - o.slip : d.close + o.slip
    const shares = o.fractional ? equity / entry : Math.floor(equity / entry)
    if (!(shares > 0)) { skip('equity below one share'); continue }
    const gross = side === 'long' ? shares * (exit - entry) : shares * (entry - exit)
    const pnl = gross - sellFees(shares, side === 'long' ? exit : entry)
    const before = equity
    equity += pnl
    trades.push({ date: d.date, side, r, shares, entry, exit, pnl, ret: pnl / (shares * entry), acctRet: pnl / before, idleCash: (before - shares * entry) / before, equityBefore: before, vixPrev: d.vixPrev, closeSrc: d.closeSrc, prevSrc: d.prevSrc })
    daily.push({ date: d.date, ret: pnl / before, equity, inMarket: true })
  }
  return { trades, daily, skips, flatDays, start }
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)
const sd = (v: number[]) => { if (v.length < 2) return 0; const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) }
/** D5: daily returns on every session (0 on flat and skipped days), x sqrt(252), risk-free 0. Pure. */
export const sharpe = (daily: number[]) => { const s = sd(daily); return s > 0 ? (mean(daily) / s) * Math.sqrt(252) : 0 }
/** Largest peak-to-trough fall of an equity series, as a fraction (0.2 = -20%). Pure. */
export function maxDrawdown(equity: number[]) { let peak = -Infinity, dd = 0; for (const e of equity) { peak = Math.max(peak, e); dd = Math.max(dd, 1 - e / peak) } return dd }
/** D9: mean / (sd / sqrt(n)). Pure. */
export const tStat = (v: number[]) => { const s = sd(v); return s > 0 ? mean(v) / (s / Math.sqrt(v.length)) : 0 }
const compound = (rets: number[]) => rets.reduce((a, r) => a * (1 + r), 1) - 1
export function cagr(total: number, from: string, to: string) { const years = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (365.25 * 86_400_000); return years > 0 ? (1 + total) ** (1 / years) - 1 : 0 }

/** Section 5 report numbers for one line. Pure. */
export function lineStats(res: LineResult) {
  const t = res.trades, wins = t.filter((x) => x.pnl > 0), losses = t.filter((x) => x.pnl <= 0)
  const rets = res.daily.map((d) => d.ret)
  const total = compound(rets)
  const from = res.daily[0]?.date ?? '', to = res.daily.at(-1)?.date ?? ''
  const posPnl = wins.reduce((a, x) => a + x.pnl, 0), negPnl = -losses.reduce((a, x) => a + x.pnl, 0)
  let streak = 0, longest = 0
  for (const x of t) { streak = x.pnl <= 0 ? streak + 1 : 0; longest = Math.max(longest, streak) }
  const worst = t.reduce<CTrade | null>((a, x) => (!a || x.pnl < a.pnl ? x : a), null)
  const byYear: Record<string, { trades: number; netReturn: number; pnl: number }> = {}
  for (const d of res.daily) { const y = d.date.slice(0, 4); byYear[y] ??= { trades: 0, netReturn: 0, pnl: 0 } }
  for (const y of Object.keys(byYear)) byYear[y].netReturn = compound(res.daily.filter((d) => d.date.startsWith(y)).map((d) => d.ret))
  for (const x of t) { const y = byYear[x.date.slice(0, 4)]; y.trades += 1; y.pnl += x.pnl }
  const bucket = (x: CTrade) => (x.vixPrev == null ? 'no VIX' : x.vixPrev < 20 ? 'VIX < 20' : 'VIX >= 20')
  const byVix: Record<string, { trades: number; winPct: number; avgBp: number; pnl: number }> = {}
  for (const k of ['VIX < 20', 'VIX >= 20', 'no VIX']) {
    const g = t.filter((x) => bucket(x) === k)
    if (g.length || k !== 'no VIX') byVix[k] = { trades: g.length, winPct: g.length ? (100 * g.filter((x) => x.pnl > 0).length) / g.length : 0, avgBp: mean(g.map((x) => x.ret * 1e4)), pnl: g.reduce((a, x) => a + x.pnl, 0) }
  }
  const idle = t.map((x) => x.idleCash)
  return {
    from, to, sessions: res.daily.length, trades: t.length, flatDays: res.flatDays, skips: res.skips,
    winPct: t.length ? (100 * wins.length) / t.length : 0,
    avgWinBp: mean(wins.map((x) => x.ret * 1e4)), avgLossBp: mean(losses.map((x) => x.ret * 1e4)),
    avgWin$: mean(wins.map((x) => x.pnl)), avgLoss$: mean(losses.map((x) => x.pnl)),
    idleCash: { avg: mean(idle), min: idle.length ? Math.min(...idle) : 0, max: idle.length ? Math.max(...idle) : 0 },
    pf: negPnl > 0 ? posPnl / negPnl : posPnl > 0 ? Infinity : 0,
    totalNet: total, pnl: res.start * total, endEquity: res.start * (1 + total), cagr: cagr(total, from, to), sharpe: sharpe(rets),
    maxDrawdown: maxDrawdown([res.start, ...res.daily.map((d) => d.equity)]),
    timeInMarket: res.daily.length ? res.daily.filter((d) => d.inMarket).length / res.daily.length : 0,
    avgTradeRetPct: mean(t.map((x) => x.ret * 100)), tStat: tStat(t.map((x) => x.ret * 100)),
    largestLoss: worst && worst.pnl < 0 ? { date: worst.date, pnl: worst.pnl, bp: worst.ret * 1e4 } : null,
    longestLosingStreak: longest, byYear, byVix,
    closeSources: { closeFromDaily: t.filter((x) => x.closeSrc === 'daily').length, prevFromDaily: t.filter((x) => x.prevSrc === 'daily').length },
  }
}
export type Stats = ReturnType<typeof lineStats>

/** Daily returns of holding from the window's first close (a close series in session order), 0 on the first day. Pure. */
export function holdLine(dates: string[], close: Map<string, number>, start = 2000, held: (date: string) => boolean = () => true): LineResult {
  let equity = start
  const daily: DailyPoint[] = []
  for (let i = 0; i < dates.length; i += 1) {
    const a = close.get(dates[i - 1]), b = close.get(dates[i])
    const ret = i > 0 && held(dates[i]) && a && b ? b / a - 1 : 0
    equity *= 1 + ret
    daily.push({ date: dates[i], ret, equity, inMarket: i > 0 && held(dates[i]) })
  }
  return { trades: [], daily, skips: {}, flatDays: 0, start }
}

/**
 * Section 6 fallback: hold SPY during month m+1 when month m's last close is above the average of the last 10
 * month-end closes (m included), else cash. monthEnds: 'YYYY-MM' -> last close of that month. Returns a predicate
 * "held on this date". Pure.
 */
export function tenMonthFilter(monthEnds: Map<string, number>) {
  const months = [...monthEnds.keys()].sort()
  const hold = new Set<string>()
  for (let i = 9; i < months.length; i += 1) {
    const avg = mean(months.slice(i - 9, i + 1).map((m) => monthEnds.get(m)!))
    if (monthEnds.get(months[i])! > avg) {
      const [y, mo] = months[i].split('-').map(Number)
      hold.add(mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`)
    }
  }
  const first = months[9]
  return { held: (date: string) => hold.has(date.slice(0, 7)), firstSignalMonth: first }
}

/** Section 4, every condition on SPY in the pass/fail window at base costs unless stated. Pure. */
export function passRule(x: { spy: Stats; buyHold: Stats; spyStress: Stats; robustness: Record<string, Stats>; spyConsistency: Stats }) {
  const years = ['2021', '2022', '2023', '2024', '2025', '2026']
  const positiveYears = years.filter((y) => (x.spy.byYear[y]?.netReturn ?? 0) > 0)
  const positiveRobust = Object.entries(x.robustness).filter(([, s]) => s.totalNet > 0).map(([k]) => k)
  const rules = [
    { rule: 1, text: 'Sharpe >= SPY buy-and-hold Sharpe', value: `${x.spy.sharpe.toFixed(3)} vs ${x.buyHold.sharpe.toFixed(3)}`, pass: x.spy.sharpe >= x.buyHold.sharpe },
    { rule: 2, text: 'average net return per trade > 0 with t-stat >= 2', value: `${x.spy.avgTradeRetPct.toFixed(4)}% per trade, t = ${x.spy.tStat.toFixed(2)}, n = ${x.spy.trades}`, pass: x.spy.trades > 0 && x.spy.avgTradeRetPct > 0 && x.spy.tStat >= 2 },
    { rule: 3, text: 'total net return > 0 at $0.03 a share each way', value: `${(100 * x.spyStress.totalNet).toFixed(2)}%`, pass: x.spyStress.totalNet > 0 },
    { rule: 4, text: 'positive in at least 4 of the 6 years 2021-2026', value: `${positiveYears.length} of 6 (${years.map((y) => `${y} ${(100 * (x.spy.byYear[y]?.netReturn ?? 0)).toFixed(2)}%`).join(', ')})`, pass: positiveYears.length >= 4 },
    { rule: 5, text: 'positive on at least 2 of QQQ, IWM, DIA, and SPY positive in 2016-2020', value: `${positiveRobust.length} of 3 (${Object.entries(x.robustness).map(([k, s]) => `${k} ${(100 * s.totalNet).toFixed(2)}%`).join(', ')}); SPY 2016-2020 ${(100 * x.spyConsistency.totalNet).toFixed(2)}%`, pass: positiveRobust.length >= 2 && x.spyConsistency.totalNet > 0 },
  ]
  return { rules, pass: rules.every((r) => r.pass) }
}

const etIso = (day: string, minute: number, second = 0) => new Date(easternMidnight(day) + minute * 60_000 + second * 1_000).toISOString()

async function calendar(start: string, end: string): Promise<CalendarDay[]> {
  const key = `c/calendar/${start}_${end}`
  const hit = readCache<CalendarDay[]>(key)
  if (hit) return hit
  const rows = await fetchJson<CalendarDay[]>(`${ALPACA_TRADING_URL}/v2/calendar?start=${start}&end=${end}`, 'calendar')
  writeCache(key, rows)
  return rows
}

/** 15:29-15:31 bars for the four ETFs on one day (one request). */
async function closingMinutes(day: string): Promise<Record<string, RawBar[]>> {
  const key = `c/minute-1529/${day}`
  const hit = readCache<Record<string, RawBar[]>>(key)
  if (hit) return hit
  const q = new URLSearchParams({ symbols: C.symbols.join(','), timeframe: '1Min', start: etIso(day, C.signalMinute), end: etIso(day, C.lateEntryMinute, 59), feed: HISTORICAL_FEED, adjustment: 'raw', limit: '10000', sort: 'asc' })
  const payload = await fetchJson<{ bars?: Record<string, RawBar[]> }>(`${ALPACA_DATA_URL}/v2/stocks/bars?${q}`, 'c-minute')
  const out = payload.bars ?? {}
  writeCache(key, out)
  return out
}

/** The closing-condition trades (M or 6, any exchange) printed 16:00:00-16:00:59 for one symbol and day. */
async function closingTrades(symbol: string, day: string): Promise<Trade[]> {
  const key = `c/close-trades/${symbol}/${day}`
  const hit = readCache<Trade[]>(key)
  if (hit) return hit
  const out: Trade[] = []
  let token: string | undefined
  do {
    const q = new URLSearchParams({ start: etIso(day, 16 * 60), end: etIso(day, 16 * 60, 59), feed: HISTORICAL_FEED, limit: '10000', sort: 'asc' })
    if (token) q.set('page_token', token)
    const payload = await fetchJson<{ trades?: Trade[] | null; next_page_token?: string | null }>(`${ALPACA_DATA_URL}/v2/stocks/${symbol}/trades?${q}`, 'c-close-trades')
    for (const t of payload.trades ?? []) if ((t.c ?? []).some((c) => c === 'M' || c === '6')) out.push({ t: t.t, x: t.x, p: t.p, s: t.s, c: t.c })
    token = payload.next_page_token ?? undefined
  } while (token)
  writeCache(key, out)
  return out
}

async function vixCloses(start: string, end: string): Promise<Map<string, number> | null> {
  const key = `c/fmp-vix/${start}_${end}`
  let rows = readCache<Array<{ date: string; price?: number; close?: number }>>(key)
  if (!rows) {
    try {
      rows = await fetchJson(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=%5EVIX&from=${start}&to=${end}&apikey=${process.env.FMP_API_KEY?.trim()}`, 'fmp-vix', 'fmp')
      writeCache(key, rows)
    } catch (error) {
      console.log(`[c] VIX from FMP unavailable: ${error instanceof Error ? error.message.slice(0, 120) : error}`)
      return null
    }
  }
  return new Map((rows ?? []).map((r) => [r.date.slice(0, 10), Number(r.price ?? r.close)]).filter(([, v]) => Number.isFinite(v)) as Array<[string, number]>)
}

async function probe(out: string) {
  const t0 = Date.now()
  const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`
  const end = C.passFail[1]
  const cal = await calendar(C.dataStart, end)
  const windows = { consistency: C.consistency, passFail: C.passFail }
  const inWindow = (d: string) => (d >= C.consistency[0] && d <= C.consistency[1]) || (d >= C.passFail[0] && d <= C.passFail[1])
  const sessions = cal.filter((d) => inWindow(d.date))
  console.log(`[c] PROBE (coverage only, no returns): ${sessions.length} sessions in the two windows; calendar ${cal.length} sessions from ${C.dataStart} (${mins()})`)

  const symbols = [...C.symbols]
  const [raw, divAdj] = [await getDailyBars(symbols, C.dataStart, end), await getDailyBarsAdjusted(symbols, C.dataStart, end, 'dividend')]
  const closes = (rows: RawBar[] | undefined) => new Map((rows ?? []).map((b) => [toEasternDay(b.t), b.c]))
  const rawBy = Object.fromEntries(symbols.map((s) => [s, closes(raw[s])])), adjBy = Object.fromEntries(symbols.map((s) => [s, closes(divAdj[s])]))
  console.log(`[c] daily bars loaded (${mins()}, Alpaca ${apiStats.alpaca})`)

  type Row = { sessions: number; halfDays: number; noPriorClose: number; miss1529: number; miss1530: number; miss1531: number; printM: number; print6: number; printNone: number; diffs: number[]; exDiv: number; noDailyClose: number }
  const row = (): Row => ({ sessions: 0, halfDays: 0, noPriorClose: 0, miss1529: 0, miss1530: 0, miss1531: 0, printM: 0, print6: 0, printNone: 0, diffs: [], exDiv: 0, noDailyClose: 0 })
  const table: Record<string, Record<string, Row>> = {}
  for (const w of Object.keys(windows)) table[w] = Object.fromEntries(symbols.map((s) => [s, row()]))
  const dates = cal.map((d) => d.date)
  let done = 0
  for (const day of sessions) {
    const w = day.date <= C.consistency[1] ? 'consistency' : 'passFail'
    const half = isHalfDay(day)
    const minutes = half ? {} : await closingMinutes(day.date)
    const tradesBy = half ? {} : Object.fromEntries(await Promise.all(symbols.map(async (s) => [s, await closingTrades(s, day.date)] as const)))
    const prevDate = dates[dates.indexOf(day.date) - 1]
    for (const s of symbols) {
      const r = table[w][s]
      r.sessions += 1
      if (half) { r.halfDays += 1; continue }
      const bars = minutes[s] ?? []
      const at = (m: number) => bars.some((b) => Math.round((Date.parse(b.t) - easternMidnight(day.date)) / 60_000) === m)
      if (!at(C.signalMinute)) r.miss1529 += 1
      if (!at(C.entryMinute)) r.miss1530 += 1
      if (!at(C.lateEntryMinute)) r.miss1531 += 1
      if (!prevDate || rawBy[s].get(prevDate) == null) r.noPriorClose += 1
      const daily = rawBy[s].get(day.date)
      if (daily == null) r.noDailyClose += 1
      const print = closingPrint(tradesBy[s] ?? [], C.primary[s])
      if (!print) r.printNone += 1
      else { if (print.kind === 'M') r.printM += 1; else r.print6 += 1; if (daily != null) r.diffs.push(Math.abs(print.price - daily)) }
      if (prevDate) {
        const f = dividendFactor(rawBy[s].get(prevDate) ?? NaN, adjBy[s].get(prevDate) ?? NaN, daily ?? NaN, adjBy[s].get(day.date) ?? NaN)
        if (f < 1) r.exDiv += 1
      }
    }
    done += 1
    if (done % 250 === 0) console.log(`[c]   ${done}/${sessions.length} sessions (${mins()}, Alpaca ${apiStats.alpaca})`)
  }
  const vix = await vixCloses(C.dataStart, end)

  console.log('\n[c] ===== STRATEGY C DATA COVERAGE (no returns computed) =====')
  console.log('[c] window       ETF   sessions  half-days  no 15:29  no 15:30  no 15:31  no prior close  auction print M / 6 / none   |auction - daily close| <=$0.005 / <=$0.01 / >$0.01 (max)  ex-div days')
  const summary: Record<string, unknown> = {}
  for (const w of Object.keys(windows)) for (const s of symbols) {
    const r = table[w][s]
    const d = r.diffs
    const a = d.filter((x) => x <= 0.005).length, b = d.filter((x) => x <= 0.01).length
    console.log(`[c] ${w.padEnd(12)} ${s.padEnd(4)} ${String(r.sessions).padStart(9)} ${String(r.halfDays).padStart(10)} ${String(r.miss1529).padStart(9)} ${String(r.miss1530).padStart(9)} ${String(r.miss1531).padStart(9)} ${String(r.noPriorClose).padStart(15)}   ${`${r.printM} / ${r.print6} / ${r.printNone}`.padStart(22)}   ${`${a} / ${b} / ${d.length - b} (${d.length ? Math.max(...d).toFixed(3) : 'n/a'})`.padStart(40)}  ${String(r.exDiv).padStart(11)}`)
    summary[`${w}|${s}`] = { ...r, diffs: undefined, diffLe0005: a, diffLe001: b, diffGt001: d.length - b, diffMax: d.length ? Math.max(...d) : null }
  }
  const tradingDays = sessions.filter((d) => !isHalfDay(d)).map((d) => d.date)
  const vixMissing = vix ? tradingDays.filter((d) => { const i = dates.indexOf(d); return i < 1 || !vix.has(dates[i - 1]) }).length : null
  console.log(`[c] VIX (prior-day close, FMP): ${vix ? `${vix.size} daily closes; ${vixMissing} of ${tradingDays.length} full sessions have no prior-day VIX` : 'unavailable'}`)
  console.log(`[c] Alpaca requests ${apiStats.alpaca} (cached ${apiStats.alpacaCached}); everything is now cached for the run.`)
  mkdirSync(join(out, 'probe'), { recursive: true })
  writeFileSync(join(out, 'probe', 'coverage.json'), JSON.stringify({ ranAt: new Date().toISOString(), windows, summary, vix: vix ? { closes: vix.size, sessionsWithoutPriorDayVix: vixMissing } : null }, null, 1))
  console.log(`[c] wrote ${join(out, 'probe', 'coverage.json')} (not a locked run). Send this output to Claude. Done in ${mins()}.`)
}

/** The 15:59 bar for the four ETFs on one day (one request), cached. */
async function lastMinute(day: string): Promise<Record<string, RawBar[]>> {
  const key = `c/minute-1559/${day}`
  const hit = readCache<Record<string, RawBar[]>>(key)
  if (hit) return hit
  const q = new URLSearchParams({ symbols: C.symbols.join(','), timeframe: '1Min', start: etIso(day, 15 * 60 + 59), end: etIso(day, 15 * 60 + 59, 59), feed: HISTORICAL_FEED, adjustment: 'raw', limit: '10000', sort: 'asc' })
  const payload = await fetchJson<{ bars?: Record<string, RawBar[]> }>(`${ALPACA_DATA_URL}/v2/stocks/bars?${q}`, 'c-minute-1559')
  const out = payload.bars ?? {}
  writeCache(key, out)
  return out
}

// D2 follow-up (Oct 25, 2026): on days where the auction print and the daily bar close differ by more than $0.01,
// which one is right? Reference: the 15:59 bar's close (the official close is normally within cents of it).
// Also: which exchanges carry the closing-condition trades for each ETF (QQQ found no primary print before 2020).
async function closeCheck(out: string) {
  const t0 = Date.now()
  const end = C.passFail[1]
  const cal = await calendar(C.dataStart, end)
  const inWindow = (d: string) => (d >= C.consistency[0] && d <= C.consistency[1]) || (d >= C.passFail[0] && d <= C.passFail[1])
  const sessions = cal.filter((d) => inWindow(d.date) && !isHalfDay(d))
  const symbols = [...C.symbols]
  const raw = await getDailyBars(symbols, C.dataStart, end)
  const rawBy = Object.fromEntries(symbols.map((s) => [s, new Map((raw[s] ?? []).map((b) => [toEasternDay(b.t), b.c]))]))
  type R = { mismatch: number; nearer: Record<string, number>; dailyVs1559: number[]; printVs1559: number[]; worst: Array<Record<string, unknown>>; exchanges: Record<string, number>; conds: Record<string, number> }
  const res: Record<string, R> = {}
  for (const w of ['consistency', 'passFail']) for (const s of symbols) res[`${w}|${s}`] = { mismatch: 0, nearer: { print: 0, daily: 0, tie: 0, 'no 15:59 bar': 0 }, dailyVs1559: [], printVs1559: [], worst: [], exchanges: {}, conds: {} }
  let n = 0
  for (const day of sessions) {
    const w = day.date <= C.consistency[1] ? 'consistency' : 'passFail'
    let last: Record<string, RawBar[]> | null = null
    for (const s of symbols) {
      const r = res[`${w}|${s}`]
      const trades = await closingTrades(s, day.date)
      for (const t of trades) { r.exchanges[t.x] = (r.exchanges[t.x] ?? 0) + 1; for (const c of t.c ?? []) if (c === 'M' || c === '6') r.conds[`${t.x}:${c}`] = (r.conds[`${t.x}:${c}`] ?? 0) + 1 }
      const print = closingPrint(trades, C.primary[s])
      const daily = rawBy[s].get(day.date)
      if (!print || daily == null || Math.abs(print.price - daily) <= 0.01) continue
      r.mismatch += 1
      last ??= await lastMinute(day.date)
      const ref = last[s]?.[0]?.c
      if (ref == null) { r.nearer['no 15:59 bar'] += 1; continue }
      r.nearer[closerTo(ref, print.price, daily)] += 1
      r.dailyVs1559.push(Math.abs(daily - ref)); r.printVs1559.push(Math.abs(print.price - ref))
      const own = trades.filter((t) => t.x === C.primary[s])
      r.worst.push({ day: day.date, kind: print.kind, print: print.price, daily, close1559: ref, primaryClosingTrades: own.length, primaryPriceRange: own.length ? [Math.min(...own.map((t) => t.p)), Math.max(...own.map((t) => t.p))] : null, largestSize: own.length ? Math.max(...own.map((t) => t.s)) : null })
    }
    n += 1
    if (n % 500 === 0) console.log(`[c]   ${n}/${sessions.length} sessions (${((Date.now() - t0) / 60_000).toFixed(1)} min, Alpaca ${apiStats.alpaca})`)
  }
  const med = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null }
  console.log('\n[c] ===== D2 CLOSE CHECK (no returns computed) =====')
  console.log('[c] window       ETF   mismatch days (>$0.01)   nearer the 15:59 close: print / daily / tie / no bar   median |x - 15:59 close|: print / daily')
  const summary: Record<string, unknown> = {}
  for (const [k, r] of Object.entries(res)) {
    const [w, s] = k.split('|')
    console.log(`[c] ${w.padEnd(12)} ${s.padEnd(4)} ${String(r.mismatch).padStart(22)}   ${`${r.nearer.print} / ${r.nearer.daily} / ${r.nearer.tie} / ${r.nearer['no 15:59 bar']}`.padStart(46)}   ${`${med(r.printVs1559)?.toFixed(3) ?? 'n/a'} / ${med(r.dailyVs1559)?.toFixed(3) ?? 'n/a'}`.padStart(30)}`)
    console.log(`[c]      closing-condition trades by exchange:condition: ${Object.entries(r.conds).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, v]) => `${c} ${v}`).join(', ') || 'none'}`)
    r.worst.sort((a, b) => Math.abs((b.print as number) - (b.daily as number)) - Math.abs((a.print as number) - (a.daily as number)))
    for (const x of r.worst.slice(0, 3)) console.log(`[c]      e.g. ${x.day}: print ${x.kind} ${x.print}, daily ${x.daily}, 15:59 close ${x.close1559}, ${x.primaryClosingTrades} primary closing trades ${JSON.stringify(x.primaryPriceRange)}`)
    summary[k] = { mismatch: r.mismatch, nearer: r.nearer, medianPrintVs1559: med(r.printVs1559), medianDailyVs1559: med(r.dailyVs1559), conds: r.conds, worst: r.worst.slice(0, 25) }
  }
  console.log(`[c] Alpaca requests ${apiStats.alpaca} (cached ${apiStats.alpacaCached})`)
  mkdirSync(join(out, 'probe'), { recursive: true })
  writeFileSync(join(out, 'probe', 'close-check.json'), JSON.stringify({ ranAt: new Date().toISOString(), summary }, null, 1))
  console.log(`[c] wrote ${join(out, 'probe', 'close-check.json')} (not a locked run). Send this output to Claude. Done in ${((Date.now() - t0) / 60_000).toFixed(1)} min.`)
}

// ---------------- run (LOCKED, runs once: both windows and every line, D14) ----------------
async function run(out: string) {
  const dir = join(out, 'run')
  if (existsSync(join(dir, 'RUN-LOCK.json'))) throw new Error('Strategy C has already been run. It runs once (D14).')
  const t0 = Date.now()
  const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`
  const end = C.passFail[1]
  const cal = await calendar(C.dataStart, end)
  const dates = cal.map((d) => d.date)
  const byDate = new Map(cal.map((d) => [d.date, d]))
  const symbols = [...C.symbols]
  const raw = await getDailyBars(symbols, C.dataStart, end)
  const adj = await getDailyBarsAdjusted(symbols, C.dataStart, end, 'dividend')
  const closes = (rows: RawBar[] | undefined) => new Map((rows ?? []).map((b) => [toEasternDay(b.t), b.c]))
  const rawBy = Object.fromEntries(symbols.map((s) => [s, closes(raw[s])])), adjBy = Object.fromEntries(symbols.map((s) => [s, closes(adj[s])]))
  // Section 6 needs 10 month-ends before the first window: SPY dividend-adjusted closes from Jan 2015 (one request).
  const spyLong = closes((await getDailyBarsAdjusted(['SPY'], '2015-01-01', end, 'dividend')).SPY)
  const vix = await vixCloses(C.dataStart, end)
  console.log(`[c] RUN: calendar ${cal.length} sessions, daily bars loaded (${mins()}, Alpaca ${apiStats.alpaca})`)

  // D2: official close = primary-exchange closing print; the daily bar's close when none (and on half days, whose
  // close is not at 16:00), counted per trade.
  const official = new Map<string, { price?: number; src?: 'print' | 'daily' }>()
  async function officialClose(s: string, date: string) {
    const k = `${s}|${date}`
    if (official.has(k)) return official.get(k)!
    const day = byDate.get(date)
    const print = day && !isHalfDay(day) ? closingPrint(await closingTrades(s, date), C.primary[s]) : null
    const daily = rawBy[s].get(date)
    const v = print ? { price: print.price, src: 'print' as const } : daily != null ? { price: daily, src: 'daily' as const } : {}
    official.set(k, v)
    return v
  }
  const windows = { consistency: C.consistency, passFail: C.passFail } as const
  const inputs: Record<string, Record<string, DayInput[]>> = { consistency: {}, passFail: {} }
  for (const [w, [from, to]] of Object.entries(windows)) {
    const sessions = cal.filter((d) => d.date >= from && d.date <= to)
    for (const s of symbols) inputs[w][s] = []
    for (const day of sessions) {
      const half = isHalfDay(day)
      const minutes = half ? {} : await closingMinutes(day.date)
      const prevDate = dates[dates.indexOf(day.date) - 1]
      for (const s of symbols) {
        const bars = minutes[s] ?? []
        const at = (m: number) => bars.find((b) => Math.round((Date.parse(b.t) - easternMidnight(day.date)) / 60_000) === m)
        const today = half ? {} : await officialClose(s, day.date)
        const prev = prevDate ? await officialClose(s, prevDate) : {}
        inputs[w][s].push({
          date: day.date, half,
          c1529: at(C.signalMinute)?.c, o1530: at(C.entryMinute)?.o, o1531: at(C.lateEntryMinute)?.o,
          prevClose: prev.price, prevSrc: prev.src, close: today.price, closeSrc: today.src,
          divFactor: prevDate ? dividendFactor(rawBy[s].get(prevDate) ?? NaN, adjBy[s].get(prevDate) ?? NaN, rawBy[s].get(day.date) ?? NaN, adjBy[s].get(day.date) ?? NaN) : 1,
          vixPrev: prevDate ? vix?.get(prevDate) : undefined,
        })
      }
    }
    console.log(`[c] ${w}: inputs built for ${sessions.length} sessions (${mins()}, Alpaca ${apiStats.alpaca})`)
  }
  // Data complete: lock before any return is computed, so a crash after this point cannot lead to a second run.
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'RUN-LOCK.json'), JSON.stringify({ ranAt: new Date().toISOString(), spec: 'docs/strategy-c-spec.md (LOCKED Oct 24, 2026)', windows }, null, 2))

  const monthEnds = new Map<string, number>()
  for (const [d, c] of [...spyLong.entries()].sort()) monthEnds.set(d.slice(0, 7), c)
  const ma = tenMonthFilter(monthEnds)
  type Line = { window: string; etf: string; line: string; role: string; res: LineResult }
  const lines: Line[] = []
  for (const w of Object.keys(windows)) {
    const sessionDates = inputs[w].SPY.map((d) => d.date)
    for (const s of symbols) lines.push({ window: w, etf: s, line: 'C base', role: s === 'SPY' ? (w === 'passFail' ? 'JUDGED' : 'rule 5') : 'robustness (rule 5)', res: runLine(inputs[w][s], BASE) })
    const spy = inputs[w].SPY
    lines.push({ window: w, etf: 'SPY', line: 'C stress $0.03', role: w === 'passFail' ? 'rule 3' : 'information', res: runLine(spy, { ...BASE, slip: 0.03 }) })
    lines.push({ window: w, etf: 'SPY', line: 'buy-and-hold', role: w === 'passFail' ? 'rule 1 benchmark' : 'information', res: holdLine(sessionDates, adjBy.SPY) })
    lines.push({ window: w, etf: 'SPY', line: 'long/short', role: 'information', res: runLine(spy, { ...BASE, longShort: true }) })
    lines.push({ window: w, etf: 'SPY', line: 'raw prior close (D1)', role: 'information', res: runLine(spy, { ...BASE, adjustDividend: false }) })
    lines.push({ window: w, etf: 'SPY', line: '15:31 fill (D3)', role: 'information', res: runLine(spy, { ...BASE, late: true }) })
    lines.push({ window: w, etf: 'SPY', line: 'fractional (D4)', role: 'information', res: runLine(spy, { ...BASE, fractional: true }) })
    lines.push({ window: w, etf: 'SPY', line: '10-month average (section 6)', role: 'information', res: holdLine(sessionDates, spyLong, 2000, ma.held) })
  }
  const stats = lines.map((l) => ({ ...l, stats: lineStats(l.res) }))
  const find = (w: string, etf: string, line: string) => stats.find((l) => l.window === w && l.etf === etf && l.line === line)!.stats
  const verdict = passRule({
    spy: find('passFail', 'SPY', 'C base'), buyHold: find('passFail', 'SPY', 'buy-and-hold'), spyStress: find('passFail', 'SPY', 'C stress $0.03'),
    robustness: Object.fromEntries(['QQQ', 'IWM', 'DIA'].map((s) => [s, find('passFail', s, 'C base')])), spyConsistency: find('consistency', 'SPY', 'C base'),
  })

  const L: string[] = []
  const p = (s = '') => { L.push(s); console.log(s) }
  const pct = (x: number) => `${(100 * x).toFixed(2)}%`
  p('\n===== STRATEGY C RUN (LOCKED, runs once) =====')
  p('Spec: docs/strategy-c-spec.md. $2,000 start, compounding; whole shares on the judged line (D4); daily Sharpe on every session, 0 when flat (D5).')
  for (const l of stats) {
    const s = l.stats
    p(`\n--- ${l.window} ${s.from} to ${s.to} | ${l.etf} | ${l.line} | ${l.role} ---`)
    p(`trades ${s.trades} (flat ${s.flatDays}, sessions ${s.sessions}) | win ${s.winPct.toFixed(1)}% | avg win ${s.avgWinBp.toFixed(1)}bp $${s.avgWin$.toFixed(2)} | avg loss ${s.avgLossBp.toFixed(1)}bp $${s.avgLoss$.toFixed(2)} | PF ${Number.isFinite(s.pf) ? s.pf.toFixed(2) : 'inf'}`)
    p(`net ${pct(s.totalNet)} ($${s.pnl.toFixed(2)}, end $${s.endEquity.toFixed(2)}) | CAGR ${pct(s.cagr)} | Sharpe ${s.sharpe.toFixed(3)} | max DD ${pct(s.maxDrawdown)} | in market ${pct(s.timeInMarket)} of sessions`)
    if (s.trades) {
      p(`per trade ${s.avgTradeRetPct.toFixed(4)}% (t ${s.tStat.toFixed(2)}) | idle cash on trade days avg ${pct(s.idleCash.avg)} (${pct(s.idleCash.min)}-${pct(s.idleCash.max)}) | largest loss ${s.largestLoss ? `${s.largestLoss.date} $${s.largestLoss.pnl.toFixed(2)} (${s.largestLoss.bp.toFixed(0)}bp)` : 'none'} | longest losing streak ${s.longestLosingStreak}`)
      p(`by VIX (prior-day close): ${Object.entries(s.byVix).map(([k, v]) => `${k}: ${v.trades} trades, win ${v.winPct.toFixed(0)}%, ${v.avgBp.toFixed(1)}bp, $${v.pnl.toFixed(2)}`).join(' | ')}`)
      const flag = s.closeSources.closeFromDaily > s.trades / 2 ? '  ** FLAG: most closes are daily-bar closes, not the auction print (D2 fallback) **' : ''
      p(`closes from the daily bar (D2 fallback): ${s.closeSources.closeFromDaily} of ${s.trades} exits, ${s.closeSources.prevFromDaily} of ${s.trades} prior closes${flag}`)
    }
    p(`by year: ${Object.entries(s.byYear).map(([y, v]) => `${y} ${pct(v.netReturn)} (${v.trades})`).join(', ')}`)
    if (Object.keys(s.skips).length) p(`skipped: ${Object.entries(s.skips).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  }
  p(`\n10-month average line: first signal month-end ${ma.firstSignalMonth}; no costs; SPY dividend-adjusted closes.`)
  p('\n===== PASS RULE (SPY, pass/fail window, base costs) =====')
  for (const r of verdict.rules) p(`rule ${r.rule} ${r.pass ? 'PASS' : 'FAIL'}: ${r.text}: ${r.value}`)
  p(`VERDICT: ${verdict.pass ? 'PASS -> a locked paper test on its own Alpaca paper account (rules set before it starts)' : 'FAIL -> fallback: SPY buy-and-hold with the 10-month average as drawdown control (section 6)'}`)
  p('\nFallback note (section 6, written whatever the result): every short-term strategy tested so far failed its locked test, and published evidence on retail day trading is poor. If C fails, the evidence points to owning the index at near-zero cost: SPY buy-and-hold, with a 10-month moving-average filter as drawdown control, accepting that it mainly helps in long bear markets and lags in fast recoveries. It is not a strategy under test.')

  writeFileSync(join(dir, 'report.txt'), L.join('\n'))
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ranAt: new Date().toISOString(), verdict, lines: stats.map(({ res, ...l }) => l) }, null, 1))
  const csv = ['window,etf,line,date,side,r,shares,entry,exit,pnl,ret,acct_ret,idle_cash,vix_prev,close_src,prev_src']
  for (const l of lines) for (const t of l.res.trades) csv.push([l.window, l.etf, l.line, t.date, t.side, t.r.toFixed(6), t.shares.toFixed(6), t.entry.toFixed(4), t.exit.toFixed(4), t.pnl.toFixed(4), t.ret.toFixed(6), t.acctRet.toFixed(6), t.idleCash.toFixed(4), t.vixPrev ?? '', t.closeSrc ?? '', t.prevSrc ?? ''].join(','))
  writeFileSync(join(dir, 'trades.csv'), csv.join('\n'))
  console.log(`\n[c] wrote ${dir}\\{report.txt,summary.json,trades.csv,RUN-LOCK.json}. Alpaca requests ${apiStats.alpaca} (cached ${apiStats.alpacaCached}). Done in ${mins()}. Send report.txt to Claude.`)
}

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true'] as const }))
  for (const k of ['ALPACA_API_KEY', 'FMP_API_KEY']) if (!process.env[k]?.trim()) throw new Error(`Set ${k} in this window first.`)
  const out = join(process.cwd(), args.get('out') ?? 'backtests/strategy-c')
  if (args.get('probe') === 'true') return probe(out)
  if (args.get('close-check') === 'true') return closeCheck(out)
  if (args.get('run') === 'true') return run(out)
  throw new Error('Pass --probe, --close-check or --run (the locked run; it runs once).')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error('[c] failed', error); process.exitCode = 1 })
}
