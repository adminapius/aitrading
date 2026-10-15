// Strategy SP (penny gappers, long only): minute scanner (top 3), 5m trend gate, Setup 1 (premarket-high /
// HOD / round-number breakout), Setup 2 (low-volume pullback re-entry), smart stop, and the 5m exit facts.
import { RULEBOOK } from './config'
import { aggPivots, lastConfirmed, minuteIn, minuteMaps, nearestAboveTyped, roomInR, roomLog, type TypedLevel } from './common'
import { aggregate, atr, ema, isBearishEngulfing, isBullishEngulfing, isHammer, isShootingStar, keltnerUpper, lastCompleted, macd, rsi, sessionVwap, sma, type Bar } from './indicators'
import type { FiveEvent, Signal, SymbolDay } from './types'

const SP = RULEBOOK.SP

export type ScannerState = { eligible: Uint8Array; gap: Float64Array; rvol: Float64Array; why: Uint8Array }
export const SCAN_WHY = ['ok', 'no trade yet', 'price outside $1-$10', 'gap < 20%', 'gap > 50%', 'volume too low', 'RVOL < 5x', 'no news yet', 'halt in last 5 min', 'not top 3'] as const
export const spFunnel: Record<string, number> = {}
let funnelOn = true
const bump = (key: string) => { if (funnelOn) spFunnel[key] = (spFunnel[key] ?? 0) + 1 }

export type SPInput = {
  symbol: string
  day: string
  midnight: number
  prevClose: number
  float: number
  todayBars: Bar[]
  prior: { day: string; midnight: number; bars: Bar[] } | null
  dailyPivotHighs: number[]
  scanner: ScannerState
  stopMinWidthAtr?: number // variant override (base: RULEBOOK.SP.stop.minWidthAtr)
  widenTightStop?: boolean // variant: widen a too-tight stop to the minimum instead of skipping
  countFunnel?: boolean
  breakoutVolumeMult?: number // variant override (base: RULEBOOK.SP.setup1.volumeMult)
}

export type ScanSymbol = {
  symbol: string
  prevClose: number
  midnight: number
  todayBars: Bar[]
  newsTimes: number[] // since the prior 4:00 PM close
  baselineAt: (minute: number) => number // average cumulative volume at this time over the prior 20 sessions
}

// Runs every minute from 7:00 ET. At boundary minute M the scanner sees bars that closed by M (t < M).
export function runScanner(symbols: ScanSymbol[]): Map<string, ScannerState> {
  const S = SP.scanner
  const out = new Map<string, ScannerState>()
  const data = symbols.map((item) => {
    const { byMinute, cumVolume } = minuteMaps(item.todayBars, item.midnight)
    out.set(item.symbol, { eligible: new Uint8Array(1440), gap: new Float64Array(1440).fill(Number.NaN), rvol: new Float64Array(1440).fill(Number.NaN), why: new Uint8Array(1440).fill(1) })
    return { item, byMinute, cumVolume }
  })
  const lastPrice = data.map(() => Number.NaN)
  const lastBarMinute = data.map(() => -1)
  const holeEnds = data.map(() => [] as number[]) // RTH: minute a 5+ minute bar hole ended
  for (let m = 4 * 60; m < SP.entryEndMinute + 1; m += 1) {
    // Bar at minute m-1 has closed at boundary m.
    data.forEach((entry, index) => {
      const bar = entry.byMinute[m - 1]
      if (!bar) return
      if (m - 1 >= SP.regularOpenMinute && lastBarMinute[index] >= 0) {
        const holeStart = Math.max(lastBarMinute[index] + 1, SP.regularOpenMinute)
        if (m - 1 - holeStart >= S.haltHoleMinutes) holeEnds[index].push(m - 1)
      }
      lastPrice[index] = bar.c
      lastBarMinute[index] = m - 1
    })
    if (m < SP.entryStartMinute) continue
    const passing: Array<{ index: number; score: number }> = []
    data.forEach((entry, index) => {
      const price = lastPrice[index]
      if (!Number.isFinite(price)) return
      const state = out.get(entry.item.symbol)!
      const gap = price / entry.item.prevClose - 1
      const volume = entry.cumVolume[m - 1]
      const baseline = entry.item.baselineAt(m)
      const rvol = baseline > 0 ? volume / baseline : Infinity
      state.gap[m] = gap
      state.rvol[m] = rvol
      const fail = (code: number) => { state.why[m] = code }
      if (price < S.minPrice || price > S.maxPrice) return fail(2)
      if (gap < S.minGap) return fail(3)
      if (gap > S.maxGap) return fail(4)
      if (volume < (m < S.lateVolumeMinute ? S.minVolumeEarly : S.minVolumeLate)) return fail(5)
      if (rvol < S.minRvol) return fail(6)
      if (!entry.item.newsTimes.some((at) => at <= entry.item.midnight + m * 60_000)) return fail(7)
      if (m > SP.regularOpenMinute) {
        const ongoing = lastBarMinute[index] < SP.regularOpenMinute ? false : m - 1 - lastBarMinute[index] >= S.haltHoleMinutes
        const recent = holeEnds[index].some((end) => m - end <= S.haltLookbackMinutes)
        if (ongoing || recent) return fail(8)
      }
      fail(9)
      passing.push({ index, score: gap * Math.min(rvol, 1e6) })
    })
    passing.sort((left, right) => right.score - left.score)
    for (const { index } of passing.slice(0, S.topN)) {
      const state = out.get(data[index].item.symbol)!
      state.eligible[m] = 1
      state.why[m] = 0
    }
  }
  // Per symbol-day: the furthest scanner filter reached (0 = made the top 3 at least once).
  for (const state of out.values()) {
    let best = 1
    for (let m = SP.entryStartMinute; m <= SP.entryEndMinute; m += 1) {
      const code = state.why[m]
      if (code === 0) { best = 0; break }
      if (code > best) best = code
    }
    bump(`scanner day: ${best === 0 ? 'made top 3' : `stopped at "${SCAN_WHY[best]}"`}`)
  }
  return out
}

export function buildSP(input: SPInput): SymbolDay {
  funnelOn = input.countFunnel !== false
  const minWidthAtr = input.stopMinWidthAtr ?? SP.stop.minWidthAtr
  const volumeMult = input.breakoutVolumeMult ?? SP.setup1.volumeMult
  const { symbol, day, midnight, todayBars, prior } = input
  const all = [...(prior?.bars ?? []), ...todayBars]
  const todayStart = prior?.bars.length ?? 0
  const sessionKey = (bar: Bar) => (bar.t >= midnight ? day : prior?.day ?? '')
  const minuteOf = (t: number) => (t >= midnight ? minuteIn(midnight, t) : minuteIn(prior!.midnight, t))
  const vwap1 = sessionVwap(all, sessionKey, () => true) // anchored 4:00 AM (bars start 4:00)
  const ema1 = ema(all.map((bar) => bar.c), SP.setup2.ema1mPeriod)
  const five = aggregate(all, 5, minuteOf, (t) => (t >= midnight ? day : prior?.day ?? ''))
  const closes5 = five.map((bar) => bar.c)
  const [p1, p2, p3] = SP.gate5m.smas
  const s1 = sma(closes5, p1)
  const s2 = sma(closes5, p2)
  const s3 = sma(closes5, p3)
  const macd5 = macd(closes5, ...SP.gate5m.macd)
  const rsi5 = rsi(closes5, SP.gate5m.rsiPeriod)
  const atr5 = atr(five, SP.atrPeriod)
  const runnerSma = sma(closes5, SP.exits.runnerSmaPeriod)
  const K = SP.exits.keltner
  const kUpper = keltnerUpper(five, K.emaPeriod, K.atrPeriod, K.mult)
  const pivots5 = aggPivots(five, rsi5)
  // 1-minute swing lows (confirmed one bar later).
  const swingLows1: Array<{ index: number; price: number; confirmedAt: number }> = []
  for (let i = 1; i < all.length - 1; i += 1) {
    if (all[i].l < all[i - 1].l && all[i].l < all[i + 1].l) swingLows1.push({ index: i, price: all[i].l, confirmedAt: all[i + 1].t + 60_000 })
  }
  const lastSwingLow1 = (beforeIndex: number, time: number) => {
    let found: { index: number; price: number } | undefined
    for (const pivot of swingLows1) {
      if (pivot.index >= beforeIndex || pivot.confirmedAt > time) break
      found = pivot
    }
    return found
  }

  const premarket = todayBars.filter((bar) => minuteIn(midnight, bar.t) < SP.regularOpenMinute)
  const pmh = premarket.length ? Math.max(...premarket.map((bar) => bar.h)) : null
  const pdhBars = prior ? prior.bars.filter((bar) => { const m = minuteIn(prior.midnight, bar.t); return m >= SP.regularOpenMinute && m < 960 }) : []
  const pdh = pdhBars.length ? Math.max(...pdhBars.map((bar) => bar.h)) : null
  const pivotHighsNear = pivots5.highs.filter((pivot) => five[pivot.index].session === day || five[pivot.index].session === prior?.day)

  const signals: Signal[] = []
  const events: FiveEvent[] = []
  let hod = -Infinity
  let impulse: { startIndex: number; highIndex: number; high: number } | null = null
  let lastPullbackLow = -Infinity

  for (let i = todayStart; i < all.length; i += 1) {
    const bar = all[i]
    const time = bar.t + 60_000
    const minute = minuteIn(midnight, bar.t) + 1 // boundary minute when this bar's close is known
    const prevHod = hod
    const k = lastCompleted(five, time)
    const range = k >= 0 ? atr5[k] : null
    const v1 = vwap1[i]

    // Impulse tracking (Setup 2): a new high of day ≥ 1.5 ATR(5m) above the last 1m swing low.
    if (bar.h > prevHod && range != null) {
      const base = lastSwingLow1(i, time)
      const startIndex = base && base.index >= todayStart ? base.index : todayStart
      let low = Infinity
      for (let x = startIndex; x <= i; x += 1) low = Math.min(low, all[x].l)
      if (impulse && impulse.highIndex === i - 1) impulse = { startIndex: impulse.startIndex, highIndex: i, high: bar.h }
      else if (bar.h - low >= SP.setup2.impulseMinAtr * range) impulse = { startIndex, highIndex: i, high: bar.h }
      else impulse = null
    }
    hod = Math.max(hod, bar.h)

    const gateOk = (() => {
      if (k < 0 || v1 == null) return false
      const [a, b, c] = [s1[k], s2[k], s3[k]]
      const line = macd5.line[k]
      const signalLine = macd5.signal[k]
      const strength = rsi5[k]
      if (a == null || b == null || c == null || line == null || signalLine == null || strength == null) return false
      return bar.c > v1 && a > b && b > c && line > signalLine && strength >= SP.gate5m.rsiMin && strength <= SP.gate5m.rsiMax
    })()

    const smartStop = (pullbackLow: number, trigger: number, setup: '1' | '2') => {
      if (range == null || v1 == null) return null
      let stop = Math.max(pullbackLow - SP.stop.bufferAtr * range, v1 - SP.stop.bufferAtr * range, trigger - SP.stop.maxAtrFromEntry * range)
      if (input.widenTightStop && trigger - stop < minWidthAtr * range) stop = trigger - minWidthAtr * range
      const width = trigger - stop
      let why = ''
      if (width < minWidthAtr * range - 1e-12) why = `too tight (< ${minWidthAtr} ATR)`
      else if (width > SP.stop.maxWidthPct * trigger) why = `too wide (> ${SP.stop.maxWidthPct * 100}% of entry)`
      else if (width > SP.stop.maxWidthAtr * range) why = `too wide (> ${SP.stop.maxWidthAtr} ATR)`
      if (why) {
        bump(`${setup} smart stop width: ${why}`)
        return null
      }
      return stop
    }
    // High of day BEFORE this 1-min signal candle: the signal candle's own wick is not resistance.
    const resistances = (): TypedLevel[] => [['prior-day high', pdh], ['premarket high', pmh], ['HOD', prevHod > -Infinity ? prevHod : null],
      ...input.dailyPivotHighs.map((level): TypedLevel => ['daily swing high (60d)', level]),
      ...pivotHighsNear.filter((pivot) => pivot.confirmedAt <= time).map((pivot): TypedLevel => ['5-min swing high (today/yesterday)', pivot.price])]
    const scannerOk = minute < 1440 && input.scanner.eligible[minute] === 1
    const gap = minute < 1440 ? input.scanner.gap[minute] : Number.NaN
    const rvolNow = minute < 1440 ? input.scanner.rvol[minute] : Number.NaN
    const emit = (setup: '1' | '2', trigger: number, stop: number, basis: number, minRoomR: number, note: string) => {
      const nearest = nearestAboveTyped(resistances(), trigger)
      const roomR = roomInR(nearest.level, trigger, stop)
      const tierOk = !(gap > SP.scanner.standardGapMax) || roomR >= SP.scanner.clearSetupMinRoomR
      const windowOk = minute >= SP.entryStartMinute && minute <= SP.entryEndMinute
      const blockers: string[] = []
      if (!windowOk) blockers.push(minute < SP.entryStartMinute ? 'before 7:00' : 'after 15:00')
      else if (!scannerOk) blockers.push(`scanner: ${SCAN_WHY[input.scanner.why[minute]] ?? 'unknown'}`)
      if (!tierOk) blockers.push('gap 30-50% without 3R room')
      if (roomR < minRoomR) blockers.push(`room < ${minRoomR}R`)
      bump(`${setup} signal ${blockers.length ? 'blocked' : 'eligible'}`)
      if (roomR < minRoomR || !tierOk) {
        bump(`room-blocked nearest: ${nearest.type}`)
        bump(`room-blocked with no other blocker: ${blockers.every((item) => item.startsWith('room') || item.startsWith('gap 30-50%')) ? 'yes' : 'no'}`)
        if (funnelOn) roomLog.push({ version: 'SP', ticker: symbol, day, time, setup, entry: trigger, stop, level: nearest.level, type: nearest.type, roomR, minRoomR: tierOk ? minRoomR : SP.scanner.clearSetupMinRoomR, otherBlockers: blockers.filter((item) => !item.startsWith('room') && !item.startsWith('gap 30-50%')).join(' + ') })
      }
      signals.push({
        version: 'SP', symbol, setup, time, trigger, limit: trigger * (1 + SP.entryLimitOffset), stop, atr5: range!, basisLow: basis,
        level: null, levelKey: null, roomR, minRoomR,
        entryEligible: scannerOk && tierOk && roomR >= minRoomR && minute >= SP.entryStartMinute && minute <= SP.entryEndMinute,
        addEligible: setup === '1', gapPct: Number.isFinite(gap) ? gap : null, rvol: Number.isFinite(rvolNow) ? rvolNow : null, note, blockers,
      })
    }

    if (gateOk && range != null && i > 0) {
      // ---- Setup 1: 1m close above PMH / HOD / next whole-or-half dollar, volume ≥ 2× 10-bar average ----
      const previous = all[i - 1].c
      const candidates: Array<[string, number]> = []
      if (pmh != null && minute > SP.regularOpenMinute) candidates.push(['PMH', pmh])
      if (prevHod > -Infinity) candidates.push(['HOD', prevHod])
      for (let level = Math.floor(previous * 2) / 2 + 0.5; level <= bar.c; level += 0.5) candidates.push([level % 1 === 0 ? 'whole $' : 'half $', level])
      const crossed = candidates.filter(([, level]) => previous <= level && bar.c > level).sort((left, right) => right[1] - left[1])[0]
      if (crossed && i >= SP.setup1.volumeAvgBars) {
        let total = 0
        for (let x = i - SP.setup1.volumeAvgBars; x < i; x += 1) total += all[x].v
        const average = total / SP.setup1.volumeAvgBars
        if (bar.v < volumeMult * average) bump(`1 level crossed, volume < ${volumeMult}x`)
        else if (bar.c - crossed[1] > SP.setup1.maxChaseAtr * range) bump('1 level crossed, chased > 0.5 ATR')
        if (bar.v >= volumeMult * average && bar.c - crossed[1] <= SP.setup1.maxChaseAtr * range) {
          const base = lastSwingLow1(i, time)
          let basis = base?.price
          if (basis == null) {
            basis = Infinity
            for (let x = Math.max(0, i - 10); x <= i; x += 1) basis = Math.min(basis, all[x].l)
          }
          const stop = smartStop(basis, bar.c, '1')
          if (stop != null) emit('1', bar.c, stop, basis, SP.setup1.minRoomR, `${crossed[0]} ${crossed[1].toFixed(2)} breakout, vol ${(bar.v / Math.max(average, 1)).toFixed(1)}x`)
        }
      }

      // ---- Setup 2: low-volume pullback that holds support + hammer/engulfing closing above the 1m 9 EMA ----
      if (impulse && i - impulse.highIndex >= SP.setup2.pullbackMinBars && bar.h <= impulse.high) {
        const leg = all.slice(impulse.startIndex + 1, impulse.highIndex + 1)
        const pull = all.slice(impulse.highIndex + 1, i)
        const average = (list: Bar[], pick: (item: Bar) => number) => list.reduce((sum, item) => sum + pick(item), 0) / Math.max(list.length, 1)
        const quiet = leg.length > 0 && pull.length > 0 && average(pull, (item) => item.v) < average(leg, (item) => item.v)
          && average(pull, (item) => item.h - item.l) <= SP.setup2.pullbackMaxRangeRatio * average(leg, (item) => item.h - item.l)
        const confirm = (isHammer(bar) || isBullishEngulfing(all[i - 1], bar)) && ema1[i] != null && bar.c > ema1[i]!
        if (quiet && confirm) {
          const pullbackLow = Math.min(...[...pull, bar].map((item) => item.l))
          const minClose = Math.min(...[...pull, bar].map((item) => item.c))
          const tolerance = SP.setup2.supportToleranceAtr * range
          const supports: Array<[string, number, number]> = [] // name, zone low, zone high
          supports.push(['VWAP', v1!, v1!])
          if (s3[k] != null) supports.push(['5m 13 SMA', s3[k]!, s3[k]!])
          if (pmh != null && minute > SP.regularOpenMinute && impulse.high > pmh) supports.push(['broken PMH', pmh, pmh])
          for (let x = impulse.startIndex + 2; x <= impulse.highIndex; x += 1) {
            if (all[x].l > all[x - 2].h) supports.push(['1m FVG', all[x - 2].h, all[x].l])
          }
          const held = supports.find(([, low, high]) => pullbackLow >= low - tolerance && pullbackLow <= high + tolerance && minClose >= low)
          if (held && pullbackLow > lastPullbackLow) {
            const stop = smartStop(pullbackLow, bar.h, '2')
            if (stop != null) {
              emit('2', bar.h, stop, pullbackLow, SP.setup2.minRoomR, `pullback held ${held[0]}, low ${pullbackLow.toFixed(2)}`)
              lastPullbackLow = pullbackLow
              impulse = null
            }
          }
        }
      }
    }
  }

  // ---- Exit facts at each 5m close today ----
  for (let k = 0; k < five.length; k += 1) {
    const bar = five[k]
    if (bar.session !== day) continue
    const range = atr5[k]
    const v = (() => {
      let index = -1
      for (let x = todayStart; x < all.length && all[x].t + 60_000 <= bar.end; x += 1) index = x
      return index >= 0 ? vwap1[index] : null
    })()
    let outside = 0
    for (let x = Math.max(0, k - K.outOf); x < k; x += 1) if (kUpper[x] != null && five[x].l > kUpper[x]!) outside += 1
    const keltner = outside >= K.outsideBars && bar.c < bar.o && k > 0 && bar.c < five[k - 1].l
    let hodNow = -Infinity
    for (let x = todayStart; x < all.length && all[x].t + 60_000 <= bar.end; x += 1) hodNow = Math.max(hodNow, all[x].h)
    const prevHigh = lastConfirmed(pivots5.highs.filter((pivot) => pivot.index < k), bar.end)
    const divergence = prevHigh != null && bar.h > prevHigh.price && rsi5[k] != null && prevHigh.rsi != null && rsi5[k]! < prevHigh.rsi
    const bearish = isShootingStar(bar) || (k > 0 && isBearishEngulfing(five[k - 1], bar))
    let tightenTo: number | null = null
    if (range != null && divergence && bearish && bar.h >= hodNow - SP.exits.hodToleranceAtr * range) {
      let lastIndex = -1
      for (let x = 0; x < all.length && all[x].t + 60_000 <= bar.end; x += 1) lastIndex = x
      tightenTo = lastSwingLow1(lastIndex + 1, bar.end)?.price ?? null
    }
    events.push({
      end: bar.end,
      close: bar.c,
      runnerBelow: runnerSma[k] != null && bar.c < runnerSma[k]!,
      belowVwap: v != null && bar.c < v,
      exhaustion: keltner,
      structureBreakAt: null,
      tightenTo,
    })
  }
  const { byMinute, cumVolume } = minuteMaps(todayBars, midnight)
  return { version: 'SP', symbol, day, midnight, bars: todayBars, byMinute, cumVolume, signals, events, pdh, prevClose: input.prevClose, float: input.float }
}
