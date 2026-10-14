// Technical entry triggers for the offline backtest (research only; nothing here runs live).
//
// Strategy A only *filtered* stocks and bought the moment one qualified. These runs add real timing:
// an entry fires only when a price pattern completes on closed 1-minute bars, the stop comes from the
// pattern itself, and exits manage the trade (partial at 2R, trail under EMA 9, exit on a close below VWAP).
// Every position is closed by 15:30 ET, matching the live Alpaca flatten.
//
//   ORB5      5-minute opening-range breakout on "stocks in play" (Zarattini, Barbon & Aziz, 2024).
//   PMH       Pre-market-high breakout with a volume surge (gap-and-go).
//   MP        Micro pullback: trend (EMA 9 > EMA 20, above VWAP), light-volume pullback to EMA 9/VWAP,
//             first candle to make a new high, RSI 50-80.
//   FLAG      5-minute bull flag: strong high-volume pole, tight low-volume flag, break of the flag high,
//             measured-move target.
import type { MinuteBar, MinuteCandidate, SymbolDay } from './market'

const MINUTE = 60_000
export const SESSION_OPEN_MINUTE = 9 * 60 + 30
export const TECH_FLATTEN_MINUTE = 15 * 60 + 30

export type Indicators = { ema9: number[]; ema20: number[]; rsi14: number[]; vwap: number[]; sessionStart: number }

export type TechContext = {
  data: SymbolDay
  ind: Indicators
  /** Number of closed bars (bars[0..n-1] are visible; nothing later is). */
  n: number
  minute: number
  midnight: number
  candidate: MinuteCandidate
}

export type TechSignal = { stop: number; target?: number | null; reason: string; setupKey: string }

export type ExitPlan = {
  /** Sell this fraction at partialAtR and move the stop to breakeven. */
  partialAtR?: number
  /** After the partial (or from entry when there is no partial), exit on a 1-min close below EMA 9. */
  trailEma9?: boolean
  /** Exit everything on a 1-min close below VWAP. */
  vwapExit?: boolean
}

export type UniverseFilter = (candidate: MinuteCandidate) => string | null

export type TechnicalSpec = {
  name: string
  entryStart: number
  entryEnd: number
  maxEntriesPerSymbol: number
  /** Skip setups whose stop is wider than this fraction of price. */
  maxRiskFraction: number
  filter: UniverseFilter
  trigger: (context: TechContext) => TechSignal | null
  exit: ExitPlan
}

// ---------- indicators (computed once per symbol per day; index i only uses bars 0..i) ----------

const cache = new WeakMap<SymbolDay, Indicators>()

export function emaSeries(values: number[], period: number) {
  const out: number[] = []
  const k = 2 / (period + 1)
  values.forEach((value, index) => out.push(index === 0 ? value : value * k + out[index - 1] * (1 - k)))
  return out
}

/** Wilder RSI; NaN until `period` changes exist. */
export function rsiSeries(values: number[], period = 14) {
  const out: number[] = new Array(values.length).fill(Number.NaN)
  let gain = 0
  let loss = 0
  for (let index = 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1]
    const up = Math.max(change, 0)
    const down = Math.max(-change, 0)
    if (index <= period) {
      gain += up / period
      loss += down / period
      if (index === period) out[index] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
    } else {
      gain = (gain * (period - 1) + up) / period
      loss = (loss * (period - 1) + down) / period
      out[index] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
    }
  }
  return out
}

export function indicatorsFor(data: SymbolDay, midnight: number): Indicators {
  const hit = cache.get(data)
  if (hit) return hit
  const closes = data.bars.map((bar) => bar.c)
  const vwap = data.bars.map((bar, index) => (data.cumVolume[index] > 0 ? data.cumPriceVolume[index] / data.cumVolume[index] : bar.c))
  const open = midnight + SESSION_OPEN_MINUTE * MINUTE
  let sessionStart = data.bars.findIndex((bar) => bar.t >= open)
  if (sessionStart < 0) sessionStart = data.bars.length
  const result = { ema9: emaSeries(closes, 9), ema20: emaSeries(closes, 20), rsi14: rsiSeries(closes, 14), vwap, sessionStart }
  cache.set(data, result)
  return result
}

const avg = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)

// ---------- universe filters ----------

/** Jose's band: up 20-30% on the day, price >= $3, relative volume >= 2.5. */
export const band20to30: UniverseFilter = (candidate) => {
  const change = candidate.changePercent ?? 0
  if (change < 20 || change > 30) return 'gain_band'
  if (candidate.price < 3) return 'min_price'
  if (!candidate.relativeVolumeReliable || (candidate.relativeVolume ?? 0) < 2.5) return 'rvol'
  return null
}

/** Any top gainer up >= 10%, price >= $3, relative volume >= 2.5 (the research universe). */
export const gainers10: UniverseFilter = (candidate) => {
  if ((candidate.changePercent ?? 0) < 10) return 'gain_min'
  if (candidate.price < 3) return 'min_price'
  if (!candidate.relativeVolumeReliable || (candidate.relativeVolume ?? 0) < 2.5) return 'rvol'
  return null
}

// ---------- triggers ----------

/** First close above `level` on the last closed bar (the bar before closed at or below it). */
function freshCloseAbove(bars: MinuteBar[], n: number, level: number) {
  return n >= 2 && bars[n - 1].c > level && bars[n - 2].c <= level
}

/** 5-minute opening-range breakout. Long only, first 5-min candle must be green. */
export function orb5(stopMode: 'atr10' | 'range_low') {
  return ({ data, ind, n, midnight }: TechContext): TechSignal | null => {
    const bars = data.bars
    const start = ind.sessionStart
    const open = midnight + SESSION_OPEN_MINUTE * MINUTE
    if (start >= bars.length || bars[start].t >= open + 5 * MINUTE) return null
    const range = []
    for (let index = start; index < n && bars[index].t < open + 5 * MINUTE; index += 1) range.push(bars[index])
    const last = bars[n - 1]
    if (!range.length || last.t < open + 5 * MINUTE) return null
    const rangeHigh = Math.max(...range.map((bar) => bar.h))
    const rangeLow = Math.min(...range.map((bar) => bar.l))
    if (!(range[range.length - 1].c > range[0].o)) return null
    if (!freshCloseAbove(bars, n, rangeHigh)) return null
    let stop: number
    if (stopMode === 'atr10') {
      if (!(data.atr && data.atr > 0)) return null
      stop = last.c - 0.1 * data.atr
    } else stop = rangeLow - 0.01
    return { stop, reason: `ORB5 break of ${rangeHigh.toFixed(4)} (range low ${rangeLow.toFixed(4)}, stop ${stopMode})`, setupKey: 'orb5' }
  }
}

/** Pre-market-high breakout on a volume surge, above VWAP. */
export function pmhBreakout({ data, ind, n }: TechContext): TechSignal | null {
  const bars = data.bars
  const premarket = bars.slice(0, Math.min(ind.sessionStart, n))
  if (premarket.length < 5 || n - 1 < ind.sessionStart) return null
  const pmh = Math.max(...premarket.map((bar) => bar.h))
  if (!freshCloseAbove(bars, n, pmh)) return null
  const last = bars[n - 1]
  const prior = bars.slice(Math.max(0, n - 11), n - 1).map((bar) => bar.v)
  if (prior.length < 5 || last.v < 1.5 * avg(prior)) return null
  if (!(last.c > ind.vwap[n - 1])) return null
  const stop = Math.min(...bars.slice(Math.max(0, n - 5), n).map((bar) => bar.l)) - 0.01
  return { stop, reason: `PMH break of ${pmh.toFixed(4)} on ${(last.v / avg(prior)).toFixed(1)}x volume`, setupKey: 'pmh' }
}

/** Micro pullback in an uptrend: light-volume dip to EMA 9 / VWAP, then the first candle to make a new high. */
export function microPullback({ data, ind, n }: TechContext): TechSignal | null {
  const bars = data.bars
  const last = n - 1
  if (last - ind.sessionStart < 5 || n < 30) return null
  for (let index = last - 4; index <= last; index += 1) if (!(ind.ema9[index] > ind.ema20[index])) return null
  if (!(bars[last].c > ind.vwap[last])) return null
  // High of day so far (session + pre-market) must be 2-8 bars before the trigger bar.
  let hod = 0
  for (let index = 1; index < last; index += 1) if (bars[index].h >= bars[hod].h) hod = index
  if (hod < last - 8 || hod > last - 2) return null
  const pullback = bars.slice(hod + 1, last)
  if (!pullback.length) return null
  const pullbackLow = Math.min(...pullback.map((bar) => bar.l), bars[last].l)
  if (pullbackLow < ind.vwap[last] || pullbackLow < ind.ema20[last] * 0.995) return null
  if (bars[hod].h - pullbackLow > 0.5 * (bars[hod].h - ind.vwap[last])) return null
  const impulseVolume = avg(bars.slice(Math.max(0, hod - 4), hod + 1).map((bar) => bar.v))
  const pullbackVolume = avg(pullback.map((bar) => bar.v))
  if (!(pullbackVolume < impulseVolume)) return null
  if (!(bars[last].c > bars[last - 1].h) || !(bars[last].v > pullbackVolume)) return null
  const rsi = ind.rsi14[last]
  if (!(rsi >= 50 && rsi <= 80)) return null
  return { stop: pullbackLow - 0.01, reason: `Micro pullback: HOD ${bars[hod].h.toFixed(4)}, low ${pullbackLow.toFixed(4)}, RSI ${rsi.toFixed(0)}`, setupKey: `mp@${hod}` }
}

type FiveBar = { o: number; h: number; l: number; c: number; v: number; start: number }

function fiveMinuteBars(bars: MinuteBar[], from: number, n: number, midnight: number) {
  const open = midnight + SESSION_OPEN_MINUTE * MINUTE
  const buckets = new Map<number, FiveBar>()
  for (let index = from; index < n; index += 1) {
    const bar = bars[index]
    const bucket = Math.floor((bar.t - open) / (5 * MINUTE))
    const existing = buckets.get(bucket)
    if (!existing) buckets.set(bucket, { o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, start: bucket })
    else {
      existing.h = Math.max(existing.h, bar.h)
      existing.l = Math.min(existing.l, bar.l)
      existing.c = bar.c
      existing.v += bar.v
    }
  }
  // Only completed 5-minute candles: the bucket's last minute must have closed.
  const lastClosed = n ? bars[n - 1].t : 0
  return [...buckets.values()].filter((bucket) => open + (bucket.start * 5 + 4) * MINUTE <= lastClosed).sort((a, b) => a.start - b.start)
}

/** 5-minute bull flag: 1-3 green high-volume pole candles (+4% or more), 2-5 tight low-volume flag candles. */
export function bullFlag({ data, ind, n, midnight }: TechContext): TechSignal | null {
  const bars = data.bars
  const five = fiveMinuteBars(bars, ind.sessionStart, n, midnight)
  if (five.length < 4) return null
  const lastComplete = five.length - 1
  for (let poleEnd = lastComplete - 2; poleEnd >= Math.max(0, lastComplete - 5); poleEnd -= 1) {
    const flag = five.slice(poleEnd + 1, lastComplete + 1)
    if (flag.length < 2 || flag.length > 5) continue
    for (let poleStart = poleEnd; poleStart >= Math.max(0, poleEnd - 2); poleStart -= 1) {
      const pole = five.slice(poleStart, poleEnd + 1)
      if (!pole.every((bar) => bar.c > bar.o)) break
      const poleLow = Math.min(...pole.map((bar) => bar.l))
      const poleHigh = Math.max(...pole.map((bar) => bar.h))
      if (pole[pole.length - 1].c / pole[0].o - 1 < 0.04) continue
      const before = five.slice(Math.max(0, poleStart - 5), poleStart)
      if (!before.length || avg(pole.map((bar) => bar.v)) < 2 * avg(before.map((bar) => bar.v))) continue
      const flagHigh = Math.max(...flag.map((bar) => bar.h))
      const flagLow = Math.min(...flag.map((bar) => bar.l))
      if (flagHigh > poleHigh) continue
      if (flagLow < poleHigh - 0.5 * (poleHigh - poleLow)) continue
      if (avg(flag.map((bar) => bar.v)) > 0.6 * avg(pole.map((bar) => bar.v))) continue
      if (!freshCloseAbove(bars, n, flagHigh)) return null
      return {
        stop: flagLow - 0.01,
        target: flagHigh + (poleHigh - poleLow),
        reason: `Bull flag: pole ${poleLow.toFixed(4)}-${poleHigh.toFixed(4)}, flag ${flagLow.toFixed(4)}-${flagHigh.toFixed(4)}`,
        setupKey: `flag@${pole[0].start}`,
      }
    }
  }
  return null
}

// ---------- run specs ----------

const MANAGED: ExitPlan = { partialAtR: 2, trailEma9: true, vwapExit: true }
const HOLD: ExitPlan = {}

export const technicalSpecs: Array<{ id: string; label: string; technical: TechnicalSpec }> = []
for (const [suffix, filter, label] of [['B', band20to30, 'up 20-30%'], ['G', gainers10, 'gainers 10%+']] as const) {
  technicalSpecs.push(
    { id: `ORB-ATR-${suffix}`, label: `5-min ORB, stop 10% ATR, hold to 15:30 (${label})`, technical: { name: 'orb5_atr', entryStart: 9 * 60 + 35, entryEnd: 11 * 60, maxEntriesPerSymbol: 1, maxRiskFraction: 0.08, filter, trigger: orb5('atr10'), exit: HOLD } },
    { id: `ORB-LOW-${suffix}`, label: `5-min ORB, stop under range low, managed exit (${label})`, technical: { name: 'orb5_low', entryStart: 9 * 60 + 35, entryEnd: 11 * 60, maxEntriesPerSymbol: 1, maxRiskFraction: 0.08, filter, trigger: orb5('range_low'), exit: MANAGED } },
    { id: `PMH-${suffix}`, label: `Pre-market-high breakout, managed exit (${label})`, technical: { name: 'pmh', entryStart: 9 * 60 + 30, entryEnd: 10 * 60 + 30, maxEntriesPerSymbol: 1, maxRiskFraction: 0.08, filter, trigger: pmhBreakout, exit: MANAGED } },
    { id: `MP-${suffix}`, label: `Micro pullback (EMA 9/20, VWAP, RSI 50-80), managed exit (${label})`, technical: { name: 'micro_pullback', entryStart: 9 * 60 + 35, entryEnd: 11 * 60, maxEntriesPerSymbol: 3, maxRiskFraction: 0.08, filter, trigger: microPullback, exit: MANAGED } },
    { id: `FLAG-${suffix}`, label: `5-min bull flag, measured-move target, managed exit (${label})`, technical: { name: 'bull_flag', entryStart: 9 * 60 + 45, entryEnd: 11 * 60, maxEntriesPerSymbol: 2, maxRiskFraction: 0.08, filter, trigger: bullFlag, exit: MANAGED } },
  )
}
