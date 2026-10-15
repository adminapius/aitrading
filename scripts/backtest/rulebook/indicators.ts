// Indicator and candle definitions exactly as in the rulebook's "Indicator definitions (code-ready)" table.
// Every series is computed on bar closes in time order; value[i] uses bars 0..i only (no look-ahead).
import { RULEBOOK } from './config'

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number }
export type Series = Array<number | null>

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  let sum = 0
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]
    if (index >= period) sum -= values[index - period]
    if (index >= period - 1) out[index] = sum / period
  }
  return out
}

// α = 2/(n+1); seeded with the SMA of the first n values.
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  const alpha = 2 / (period + 1)
  let value: number | null = null
  let seed = 0
  for (let index = 0; index < values.length; index += 1) {
    if (value === null) {
      seed += values[index]
      if (index === period - 1) value = seed / period
    } else value = alpha * values[index] + (1 - alpha) * value
    out[index] = value
  }
  return out
}

// EMA over a series that starts with nulls (used for the MACD signal line).
function emaOfSeries(values: Series, period: number): Series {
  const start = values.findIndex((value) => value !== null)
  const out: Series = new Array(values.length).fill(null)
  if (start < 0) return out
  const tail = ema(values.slice(start) as number[], period)
  for (let index = 0; index < tail.length; index += 1) out[start + index] = tail[index]
  return out
}

// Wilder RSI: 100 − 100/(1 + avg gain / avg loss).
export function rsi(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  let gain = 0
  let loss = 0
  for (let index = 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1]
    const up = Math.max(change, 0)
    const down = Math.max(-change, 0)
    if (index <= period) {
      gain += up
      loss += down
      if (index === period) {
        gain /= period
        loss /= period
      } else continue
    } else {
      gain = (gain * (period - 1) + up) / period
      loss = (loss * (period - 1) + down) / period
    }
    out[index] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

// Wilder ATR of true range = max(H−L, |H−Cprev|, |L−Cprev|).
export function atr(bars: Bar[], period: number): Series {
  const out: Series = new Array(bars.length).fill(null)
  let value = 0
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]
    const prev = index > 0 ? bars[index - 1].c : bar.c
    const range = Math.max(bar.h - bar.l, Math.abs(bar.h - prev), Math.abs(bar.l - prev))
    if (index < period) {
      value += range
      if (index === period - 1) {
        value /= period
        out[index] = value
      }
    } else {
      value = (value * (period - 1) + range) / period
      out[index] = value
    }
  }
  return out
}

export function macd(values: number[], fast: number, slow: number, signal: number) {
  const fastLine = ema(values, fast)
  const slowLine = ema(values, slow)
  const line: Series = values.map((_, index) => (fastLine[index] === null || slowLine[index] === null ? null : fastLine[index]! - slowLine[index]!))
  return { line, signal: emaOfSeries(line, signal) }
}

// Keltner(20, 2): EMA20 ± 2 × ATR(20).
export function keltnerUpper(bars: Bar[], emaPeriod: number, atrPeriod: number, mult: number): Series {
  const mid = ema(bars.map((bar) => bar.c), emaPeriod)
  const range = atr(bars, atrPeriod)
  return bars.map((_, index) => (mid[index] === null || range[index] === null ? null : mid[index]! + mult * range[index]!))
}

// Session VWAP: Σ(typical × volume) / Σ volume from the anchor; typical = (H+L+C)/3. Resets each session.
export function sessionVwap(bars: Bar[], sessionKey: (bar: Bar) => string, include: (bar: Bar) => boolean): Series {
  const out: Series = new Array(bars.length).fill(null)
  let key = ''
  let pv = 0
  let volume = 0
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]
    const barKey = sessionKey(bar)
    if (barKey !== key) {
      key = barKey
      pv = 0
      volume = 0
    }
    if (include(bar)) {
      pv += ((bar.h + bar.l + bar.c) / 3) * bar.v
      volume += bar.v
    }
    out[index] = volume > 0 ? pv / volume : null
  }
  return out
}

// ---- Candles (L3) ----
const C = RULEBOOK.candles

function parts(bar: Bar) {
  const range = Math.max(bar.h - bar.l, 1e-9)
  const body = Math.max(Math.abs(bar.c - bar.o), C.minBodyFractionOfRange * range)
  return { range, body, upper: bar.h - Math.max(bar.o, bar.c), lower: Math.min(bar.o, bar.c) - bar.l }
}

export function isHammer(bar: Bar) {
  const { body, upper, lower } = parts(bar)
  return lower >= C.hammerLowerToBody * body && upper <= C.hammerUpperToBody * body
}

export function isShootingStar(bar: Bar) {
  const { body, upper, lower } = parts(bar)
  return upper >= C.starUpperToBody * body && lower <= C.starLowerToBody * body
}

// Red bar then green bar whose body covers the red body.
export function isBullishEngulfing(prev: Bar, bar: Bar) {
  return prev.c < prev.o && bar.c > bar.o && bar.o <= prev.c && bar.c >= prev.o
}

export function isBearishEngulfing(prev: Bar, bar: Bar) {
  return prev.c > prev.o && bar.c < bar.o && bar.o >= prev.c && bar.c <= prev.o
}

// (1) long red, (2) small body, (3) long green closing above the midpoint of bar 1's body.
export function isMorningStar(first: Bar, second: Bar, third: Bar) {
  const firstBody = first.o - first.c
  const thirdBody = third.c - third.o
  if (firstBody <= 0 || thirdBody <= 0) return false
  if (firstBody < C.morningStarLongBodyFraction * Math.max(first.h - first.l, 1e-9)) return false
  if (thirdBody < C.morningStarLongBodyFraction * Math.max(third.h - third.l, 1e-9)) return false
  if (Math.abs(second.c - second.o) > C.morningStarSmallBodyRatio * firstBody) return false
  return third.c >= first.c + firstBody / 2
}

// Pivot (swing) low/high: bar's low below the lows of the bar before and after (L4). Confirmed one bar later.
export function isPivotLow(bars: Bar[], index: number) {
  return index > 0 && index < bars.length - 1 && bars[index].l < bars[index - 1].l && bars[index].l < bars[index + 1].l
}

export function isPivotHigh(bars: Bar[], index: number) {
  return index > 0 && index < bars.length - 1 && bars[index].h > bars[index - 1].h && bars[index].h > bars[index + 1].h
}

// Clock-aligned aggregation (5m / 15m). Each output bar records its END time (when it becomes known).
export type AggBar = Bar & { end: number; session: string }

export function aggregate(bars: Bar[], minutes: number, minuteOfDay: (t: number) => number, session: (t: number) => string): AggBar[] {
  const out: AggBar[] = []
  let current: AggBar | null = null
  let currentKey = ''
  for (const bar of bars) {
    const minute = minuteOfDay(bar.t)
    const bucket = Math.floor(minute / minutes) * minutes
    const day = session(bar.t)
    const key = `${day}:${bucket}`
    if (key !== currentKey) {
      if (current) out.push(current)
      const start = bar.t - (minute - bucket) * 60_000
      current = { t: start, end: start + minutes * 60_000, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, session: day }
      currentKey = key
    } else {
      current!.h = Math.max(current!.h, bar.h)
      current!.l = Math.min(current!.l, bar.l)
      current!.c = bar.c
      current!.v += bar.v
    }
  }
  if (current) out.push(current)
  return out
}

// Index of the last aggregated bar whose end ≤ time (−1 if none). Bars are sorted by end.
export function lastCompleted(bars: AggBar[], time: number) {
  let low = 0
  let high = bars.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (bars[mid].end <= time) low = mid + 1
    else high = mid
  }
  return low - 1
}
