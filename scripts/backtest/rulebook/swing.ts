// Run H - "S-Swing" by the course: daily bars, long only, overnight holds.
// Decisions use the daily close of day d; entries and close-based exits fill at the open of day d+1.
// Signals and P&L use split-adjusted daily bars (positions are held across splits); the universe filter
// (price >= $5, 20-day average volume >= 1M) uses raw, unadjusted bars as of that day.
import { getDailyBarsSplitAdjusted, type RawBar } from '../data'
import { easternMidnight } from '../market'
import { toEasternDay } from '../universe'
import { RULEBOOK } from './config'
import { isCommonStock, type Reference } from './data'
import { atr, isBullishEngulfing, isHammer, isMorningStar, sma, type Bar } from './indicators'
import type { TradeRecord } from './engine'

const H = RULEBOOK.H
const MIN = 60_000

type Daily = { day: string; o: number; h: number; l: number; c: number; v: number }

type SymbolSeries = {
  symbol: string
  rows: Daily[]
  index: Map<string, number>
  s20: Array<number | null>
  s50: Array<number | null>
  s200: Array<number | null>
  n: Array<number | null>
  signal: Array<'A' | 'B' | null>
  note: string[]
}

export function buildSeries(symbol: string, rows: Daily[]): SymbolSeries {
  const closes = rows.map((row) => row.c)
  const bars: Bar[] = rows.map((row, index) => ({ t: index, o: row.o, h: row.h, l: row.l, c: row.c, v: row.v }))
  const s20 = sma(closes, H.smas[0])
  const s50 = sma(closes, H.smas[1])
  const s200 = sma(closes, H.smas[2])
  const n = atr(bars, H.atrDays)
  const signal: Array<'A' | 'B' | null> = new Array(rows.length).fill(null)
  const note: string[] = new Array(rows.length).fill('')
  let bounces = 0
  let inTouch = false
  let touchHigh = 0
  for (let d = 0; d < rows.length; d += 1) {
    const bar = rows[d]
    const a = s20[d]
    const b = s50[d]
    const c = s200[d]
    const trend = a != null && b != null && c != null && a > b && b > c
    if (!trend) {
      bounces = 0
      inTouch = false
      continue
    }
    // Entry B (L14 Turtle System 1): close above the prior 20-day high.
    if (d >= H.breakoutDays) {
      let high = -Infinity
      for (let k = d - H.breakoutDays; k < d; k += 1) high = Math.max(high, rows[k].h)
      if (bar.c > high) {
        signal[d] = 'B'
        note[d] = `close ${bar.c.toFixed(2)} above 20-day high ${high.toFixed(2)}`
      }
    }
    // Entry A (L8): 3rd touch of the 20 or 50 SMA with a bullish confirmation bar (hammer / engulfing / morning star) closing above the 20 SMA.
    const touches = (bar.l <= a! && bar.c >= a!) || (bar.l <= b! && bar.c >= b!)
    const episode = inTouch || touches
    const confirm = bar.c > a! && (isHammer(bars[d]) || (d > 0 && isBullishEngulfing(bars[d - 1], bars[d])) || (d > 1 && isMorningStar(bars[d - 2], bars[d - 1], bars[d])))
    if (bounces >= H.priorBouncesRequired && episode && confirm) {
      if (!signal[d]) {
        signal[d] = 'A'
        note[d] = `third touch after ${bounces} bounces`
      }
      bounces = 0
      inTouch = false
      continue
    }
    let bounced = false
    if (inTouch && bar.c > touchHigh) {
      bounces += 1
      inTouch = false
      bounced = true
    }
    if (touches && !inTouch && !bounced) {
      inTouch = true
      touchHigh = bar.h
    }
  }
  return { symbol, rows, index: new Map(rows.map((row, i) => [row.day, i])), s20, s50, s200, n, signal, note }
}

type Position = {
  symbol: string
  setup: 'A' | 'B'
  entryDay: string
  entryPrice: number
  shares: number
  stop: number
  riskPerShare: number
  below50: number
  pendingExit: string | null
  maxHigh: number
  minLow: number
  note: string
  roomR: number
}

type PendingEntry = { symbol: string; setup: 'A' | 'B'; n: number; riskDollars: number; note: string; roomR: number; rank: number }

// `simulate` (optional): simulate only these days while loading/universe use `period` (so H v2 can run its
// tuning/holdout windows from the same cached bars). Default: simulate the whole period (H v1 unchanged).
export async function runSwing(ref: Reference, period: { start: string; end: string }, runId = 'H', simulate?: { start: string; end: string }) {
  // 1) Universe candidates from RAW daily bars (no look-ahead: each day uses that day's raw close and volume).
  const rawOk = new Map<string, Set<string>>()
  for (const [symbol, stats] of ref.dailyStats) {
    if (!H.exchanges.includes(ref.exchanges.get(symbol) ?? '')) continue
    if (!isCommonStock(symbol, ref.universe.names.get(symbol) ?? '')) continue
    const ok = new Set<string>()
    for (let d = H.avgVolumeDays; d < stats.rows.length; d += 1) {
      const row = stats.rows[d]
      if (row.day < period.start || row.day > period.end) continue
      let volume = 0
      for (let k = d - H.avgVolumeDays + 1; k <= d; k += 1) volume += stats.rows[k].v
      if (row.c >= H.minPrice && volume / H.avgVolumeDays >= H.minAvgVolume) ok.add(row.day)
    }
    if (ok.size) rawOk.set(symbol, ok)
  }
  const symbols = [...rawOk.keys()].sort()
  const historyStart = ref.allDays[0]
  console.log(`[swing] ${symbols.length} symbols pass the raw universe on at least one day; loading split-adjusted daily bars`)
  const adjusted = await getDailyBarsSplitAdjusted(symbols, historyStart, period.end)
  const series = new Map<string, SymbolSeries>()
  for (const symbol of symbols) {
    const rows = ((adjusted[symbol] ?? []) as RawBar[]).map((bar) => ({ day: toEasternDay(bar.t), o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }))
    if (rows.length > H.smas[2]) series.set(symbol, buildSeries(symbol, rows))
  }

  // 2) Day-by-day simulation over the period.
  const sim = simulate ?? period
  const days = ref.allDays.filter((day) => day >= sim.start && day <= sim.end)
  const C = RULEBOOK.costs
  let cash: number = RULEBOOK.account.startingEquity
  const positions: Position[] = []
  let pending: PendingEntry[] = []
  const trades: TradeRecord[] = []
  const equityByDay: Array<{ day: string; equity: number }> = []
  const stats = { signals: 0, roomBlocked: 0, notInUniverse: 0, slotsFull: 0, riskCap: 0, cashCap: 0, filled: 0, skipped: {} as Record<string, number> }
  const time = (day: string, minute: number) => easternMidnight(day) + minute * MIN
  const markEquity = (day: string) => cash + positions.reduce((sum, position) => {
    const s = series.get(position.symbol)!
    let i = s.index.get(day)
    if (i == null) { // no bar today: last known close
      for (let k = s.rows.length - 1; k >= 0; k -= 1) if (s.rows[k].day <= day) { i = k; break }
    }
    return sum + position.shares * (i != null ? s.rows[i].c : position.entryPrice)
  }, 0)
  const sell = (position: Position, price: number, reason: string, day: string) => {
    const proceeds = position.shares * price
    const fees = proceeds * C.secFeePerDollar + Math.min(position.shares * C.finraTafPerShare, C.finraTafMaxPerTrade)
    cash += proceeds - fees
    const pnl = position.shares * (price - position.entryPrice) - fees
    positions.splice(positions.indexOf(position), 1)
    const riskDollars = position.shares * position.riskPerShare
    trades.push({
      run: runId, date: position.entryDay, ticker: position.symbol, version: 'S', setup: position.setup, entryIndex: 1,
      entryTime: time(position.entryDay, 570), entryPrice: position.entryPrice, avgCost: position.entryPrice, stop: position.stop,
      shares: position.shares, maxShares: position.shares, units: 1, exitTime: time(day, reason === 'stop' || reason === '10-day-low' ? 720 : 570),
      exitPrice: price, exitReason: reason, partials: `exit ${day}`, rResult: pnl / riskDollars, pnl, fees, equityAfter: 0, riskDollars,
      mfeR: (position.maxHigh - position.entryPrice) / position.riskPerShare, maeR: (position.minLow - position.entryPrice) / position.riskPerShare,
      holdMinutes: Math.round((time(day, 960) - time(position.entryDay, 570)) / MIN), roomR: position.roomR, gapPct: null, rvol: null, note: position.note,
    })
  }

  for (const [dayIndex, day] of days.entries()) {
    // a) Close-based exits flagged yesterday: next open.
    for (const position of [...positions]) {
      const s = series.get(position.symbol)!
      const i = s.index.get(day)
      if (i == null || !position.pendingExit) continue
      sell(position, s.rows[i].o * (1 - H.slippage), position.pendingExit, day)
    }
    // b) Entries signalled at yesterday's close: fill at today's open.
    const equityAtOpen = markEquity(days[dayIndex - 1] ?? day)
    for (const entry of pending) {
      const s = series.get(entry.symbol)!
      const i = s.index.get(day)
      if (i == null) continue
      if (positions.length >= H.maxOpen) { stats.slotsFull += 1; continue }
      if (positions.some((position) => position.symbol === entry.symbol)) continue
      const fill = s.rows[i].o * (1 + H.slippage)
      const riskPerShare = H.stopAtr * entry.n
      let shares = Math.floor(entry.riskDollars / riskPerShare + 1e-9)
      shares = Math.min(shares, Math.floor(cash / fill)) // no leverage: pay with cash on hand
      if (shares < 1) { stats.cashCap += 1; continue }
      const openRisk = positions.reduce((sum, position) => sum + position.shares * Math.max(0, position.entryPrice - position.stop), 0)
      if (openRisk + shares * riskPerShare > H.maxOpenRiskFraction * equityAtOpen) {
        shares = Math.floor((H.maxOpenRiskFraction * equityAtOpen - openRisk) / riskPerShare)
        if (shares < 1) { stats.riskCap += 1; continue }
      }
      cash -= shares * fill
      stats.filled += 1
      positions.push({ symbol: entry.symbol, setup: entry.setup, entryDay: day, entryPrice: fill, shares, stop: fill - riskPerShare, riskPerShare, below50: 0, pendingExit: null, maxHigh: fill, minLow: fill, note: entry.note, roomR: entry.roomR })
    }
    pending = []
    // c) Intraday protective level: max(2N stop, prior 10-day low). Gap below → open; touch → level.
    for (const position of [...positions]) {
      const s = series.get(position.symbol)!
      const i = s.index.get(day)
      if (i == null) continue
      const bar = s.rows[i]
      let tenLow = Infinity
      for (let k = Math.max(0, i - H.exitLowDays); k < i; k += 1) tenLow = Math.min(tenLow, s.rows[k].l)
      const level = Math.max(position.stop, Number.isFinite(tenLow) ? tenLow : -Infinity)
      const reason = level === position.stop ? 'stop' : '10-day-low'
      if (position.entryDay !== day && bar.o <= level) { sell(position, bar.o * (1 - H.slippage), `gap-${reason}`, day); continue }
      if (bar.l <= level && (position.entryDay !== day || bar.c <= level)) { sell(position, level * (1 - H.slippage), reason, day); continue }
      position.maxHigh = Math.max(position.maxHigh, bar.h)
      position.minLow = Math.min(position.minLow, bar.l)
      // d) Close: 2 consecutive closes below the 50 SMA → exit next open.
      const s50 = s.s50[i]
      position.below50 = s50 != null && bar.c < s50 ? position.below50 + 1 : 0
      if (position.below50 >= H.exitClosesBelow50) position.pendingExit = 'below-50sma-2-closes'
    }
    // e) New signals at today's close (fills tomorrow at the open).
    const equity = markEquity(day)
    if (dayIndex < days.length - 1) {
      const candidates: PendingEntry[] = []
      for (const [symbol, s] of series) {
        const i = s.index.get(day)
        if (i == null || !s.signal[i]) continue
        stats.signals += 1
        if (!rawOk.get(symbol)?.has(day)) { stats.notInUniverse += 1; continue }
        const n = s.n[i]
        if (n == null || !(n > 0)) continue
        const close = s.rows[i].c
        // Room: nearest daily swing high (last 60 days, confirmed by today) above the close, in R (R = 2N).
        let nearest = Infinity
        for (let k = Math.max(1, i - H.roomPivotDays); k < i; k += 1) {
          const row = s.rows[k]
          if (row.h > s.rows[k - 1].h && row.h > s.rows[k + 1].h && row.h > close + 0.01 && row.h < nearest) nearest = row.h
        }
        const roomR = nearest === Infinity ? Infinity : (nearest - close) / (H.stopAtr * n)
        if (roomR < H.minRoomR) { stats.roomBlocked += 1; continue }
        let high52 = 0
        for (let k = Math.max(0, i - H.rankLookbackDays); k <= i; k += 1) high52 = Math.max(high52, s.rows[k].h)
        candidates.push({ symbol, setup: s.signal[i]!, n, riskDollars: equity * H.riskPerTrade, note: s.note[i], roomR, rank: close / high52 })
      }
      candidates.sort((left, right) => right.rank - left.rank || left.symbol.localeCompare(right.symbol))
      pending = candidates.filter((candidate) => !positions.some((position) => position.symbol === candidate.symbol)).slice(0, Math.max(0, H.maxOpen - positions.length))
    }
    const marked = markEquity(day)
    for (const trade of trades) if (trade.equityAfter === 0) trade.equityAfter = marked
    equityByDay.push({ day, equity: marked })
  }
  // End of test: close what is still open at the last close.
  const lastDay = days.at(-1)!
  for (const position of [...positions]) {
    const s = series.get(position.symbol)!
    const last = [...s.rows].reverse().find((row) => row.day <= lastDay)!
    sell(position, last.c * (1 - H.slippage), 'end-of-test', lastDay)
  }
  for (const trade of trades) if (trade.equityAfter === 0) trade.equityAfter = cash
  trades.sort((left, right) => left.exitTime - right.exitTime)
  return { trades, equityByDay, stats }
}
