// Strategy S (regular stocks, LONG ONLY for this backtest): 15m trend gate, 5m Setup A (MA bounce) and
// Setup B (level breakout / retest), market-structure stops, and the 5m facts its exits need.
import { RULEBOOK } from './config'
import { aggPivots, confirmedBy, lastConfirmed, minuteIn, minuteMaps, nearestAbove, roomInR } from './common'
import { aggregate, atr, ema, isBearishEngulfing, isBullishEngulfing, isHammer, isMorningStar, isShootingStar, lastCompleted, macd, rsi, sessionVwap, sma, type Bar } from './indicators'
import type { FiveEvent, Signal, SymbolDay } from './types'

const S = RULEBOOK.S

// Funnel: how many candidates reach / fail each rule (diagnostics only, never changes a decision).
export const sFunnel: Record<string, number> = {}
const bump = (key: string) => { sFunnel[key] = (sFunnel[key] ?? 0) + 1 }

export type SInput = {
  symbol: string
  day: string
  midnight: number
  prevClose: number
  todayBars: Bar[] // 4:00-16:00
  priorSessions: Array<{ day: string; midnight: number; bars: Bar[] }> // oldest → newest
  dailyPivotHighs: number[]
}

export function buildS(input: SInput): SymbolDay {
  const { symbol, day, midnight, todayBars } = input
  bump('stock-days on the S list')
  const sessions = [...input.priorSessions, { day, midnight, bars: todayBars }]
  const sessionOfBar = new Map<number, { day: string; midnight: number }>()
  const rth: Bar[] = []
  for (const session of sessions) {
    for (const bar of session.bars) {
      const minute = minuteIn(session.midnight, bar.t)
      if (minute >= S.sessionStartMinute && minute < 16 * 60) {
        rth.push(bar)
        sessionOfBar.set(bar.t, session)
      }
    }
  }
  const sessionKey = (t: number) => sessionOfBar.get(t)?.day ?? ''
  const minuteOf = (t: number) => {
    const session = sessionOfBar.get(t)
    return session ? minuteIn(session.midnight, t) : 0
  }
  const vwap1 = sessionVwap(rth, (bar) => sessionKey(bar.t), () => true)
  const five = aggregate(rth, 5, minuteOf, sessionKey)
  const fifteen = aggregate(rth, 15, minuteOf, sessionKey)
  const closes5 = five.map((bar) => bar.c)
  const ema5 = ema(closes5, S.setupA.emaFast)
  const sma5 = sma(closes5, S.setupA.smaSlow)
  const runnerSma = sma(closes5, S.exits.runnerSmaPeriod)
  const atr5 = atr(five, S.atrPeriod)
  const rsi5 = rsi(closes5, S.rsiPeriod)
  const volumeAvg = (index: number) => {
    const from = index - S.setupB.volumeAvgBars
    if (from < 0) return null
    let total = 0
    for (let k = from; k < index; k += 1) total += five[k].v
    return total / S.setupB.volumeAvgBars
  }
  const closes15 = fifteen.map((bar) => bar.c)
  const ema15 = ema(closes15, S.gate15m.emaFast)
  const sma15 = sma(closes15, S.gate15m.smaSlow)
  const macd15 = macd(closes15, ...S.gate15m.macd)
  const rsi15 = rsi(closes15, S.gate15m.rsiPeriod)
  const pivots = aggPivots(five, rsi5)
  const prevSession = input.priorSessions.at(-1)
  const today5 = new Set(five.map((bar, index) => (bar.session === day ? index : -1)).filter((index) => index >= 0))
  const yesterdayPivotHighs = pivots.highs.filter((pivot) => five[pivot.index].session === day || five[pivot.index].session === prevSession?.day)

  const premarket = todayBars.filter((bar) => minuteIn(midnight, bar.t) < S.sessionStartMinute)
  const pmh = premarket.length ? Math.max(...premarket.map((bar) => bar.h)) : null
  const pdhBars = prevSession ? prevSession.bars.filter((bar) => { const m = minuteIn(prevSession.midnight, bar.t); return m >= S.sessionStartMinute && m < 960 }) : []
  const pdh = pdhBars.length ? Math.max(...pdhBars.map((bar) => bar.h)) : null
  const orBars = todayBars.filter((bar) => { const m = minuteIn(midnight, bar.t); return m >= S.sessionStartMinute && m < S.setupB.orEndMinute })
  const orh = orBars.length ? Math.max(...orBars.map((bar) => bar.h)) : null
  // High of day known at time T (premarket included).
  const hodAt = (time: number) => {
    let high = -Infinity
    for (const bar of todayBars) {
      if (bar.t + 60_000 > time) break
      high = Math.max(high, bar.h)
    }
    return Number.isFinite(high) ? high : null
  }
  const last1mIndex = (time: number) => {
    let low = 0
    let high = rth.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (rth[mid].t + 60_000 <= time) low = mid + 1
      else high = mid
    }
    return low - 1
  }
  const gate = (time: number) => {
    const i1 = last1mIndex(time)
    const k = lastCompleted(fifteen, time)
    if (i1 < 0 || k < 0) return false
    const price = rth[i1].c
    const v = vwap1[i1]
    const fastValue = ema15[k]
    const slowValue = sma15[k]
    const line = macd15.line[k]
    const signalLine = macd15.signal[k]
    const strength = rsi15[k]
    if (v == null || fastValue == null || slowValue == null || line == null || signalLine == null || strength == null) return false
    return price > v && fastValue > slowValue && line > signalLine && strength > S.gate15m.rsiMin
  }
  const gateWhy = (time: number) => {
    const i1 = last1mIndex(time)
    const k = lastCompleted(fifteen, time)
    if (i1 < 0 || k < 0 || vwap1[i1] == null || ema15[k] == null || sma15[k] == null || macd15.line[k] == null || macd15.signal[k] == null || rsi15[k] == null) return 'gate:no-data'
    if (!(rth[i1].c > vwap1[i1]!)) return 'gate:below-vwap'
    if (!(ema15[k]! > sma15[k]!)) return 'gate:15m-20ema<=50sma'
    if (!(macd15.line[k]! > macd15.signal[k]!)) return 'gate:15m-macd<=signal'
    return 'gate:15m-rsi<=45'
  }
  const gated = (time: number, prefix: string) => {
    if (gate(time)) return true
    bump(`${prefix} ${gateWhy(time)}`)
    return false
  }
  const resistances = (time: number) => [
    pdh, pmh, hodAt(time), ...input.dailyPivotHighs,
    ...yesterdayPivotHighs.filter((pivot) => pivot.confirmedAt <= time).map((pivot) => pivot.price),
  ]
  // Stop: structure level − 0.25 ATR, then 1.0-3.0 ATR from the trigger (tighter → widen to 1 ATR, wider → skip).
  const placeStop = (basis: number, trigger: number, range: number) => {
    let stop = basis - S.stop.bufferAtr * range
    if (trigger - stop < S.stop.minAtr * range) stop = trigger - S.stop.minAtr * range
    if (trigger - stop > S.stop.maxAtr * range) return null
    return stop
  }

  const signals: Signal[] = []
  const events: FiveEvent[] = []
  const emit = (setup: Signal['setup'], time: number, trigger: number, basis: number, range: number, minRoomR: number, level: number | null, levelKey: string | null, note: string) => {
    const stop = placeStop(basis, trigger, range)
    if (stop == null) return bump(`${setup} stop>3ATR`)
    const roomR = roomInR(nearestAbove(resistances(time), trigger), trigger, stop)
    if (roomR < minRoomR) return bump(`${setup} room<${minRoomR}R`)
    bump(`${setup} SIGNAL`)
    signals.push({
      version: 'S', symbol, setup, time, trigger, limit: trigger * (1 + S.entryLimitOffset), stop, atr5: range, basisLow: basis,
      level, levelKey, roomR, minRoomR, entryEligible: true, addEligible: false, gapPct: input.prevClose > 0 ? trigger / input.prevClose - 1 : null, rvol: null, note,
    })
  }

  // Setup A state (touches carry over from prior sessions like the MAs; reset when 20 EMA ≤ 50 SMA).
  let bounces = 0
  let inTouch = false
  let touchHigh = 0
  let touchLow = Infinity
  const levelState = new Map<string, { brokeAt: number; level: number; retestDone: boolean }>()

  for (let j = 0; j < five.length; j += 1) {
    const bar = five[j]
    const fast = ema5[j]
    const slow = sma5[j]
    const range = atr5[j]
    const isToday = today5.has(j)
    const minute = isToday ? minuteIn(midnight, bar.end) : -1
    const inWindow = isToday && minute >= S.entryStartMinute && minute <= S.entryEndMinute

    // ---- Setup A: MA bounce ----
    if (fast == null || slow == null || fast <= slow) {
      bounces = 0
      inTouch = false
    } else {
      const touches = (bar.l <= fast && bar.c >= fast) || (bar.l <= slow && bar.c >= slow)
      const episode = inTouch || touches
      const episodeLow = inTouch ? Math.min(touchLow, bar.l) : bar.l
      const confirm = bar.c > fast && (isHammer(bar) || (j > 0 && isBullishEngulfing(five[j - 1], bar)) || (j > 1 && isMorningStar(five[j - 2], five[j - 1], bar)))
      let fired = false
      if (inWindow && episode) bump(bounces >= S.setupA.priorBouncesRequired ? 'A touch with ≥2 prior bounces' : 'A touch with <2 prior bounces')
      if (inWindow && episode && bounces >= S.setupA.priorBouncesRequired && !confirm) bump('A no confirmation candle')
      if (inWindow && range != null && bounces >= S.setupA.priorBouncesRequired && episode && confirm && gated(bar.end, 'A')) {
        const highs = confirmedBy(pivots.highs, bar.end)
        const lows = confirmedBy(pivots.lows, bar.end)
        const trending = highs.length === 2 && lows.length === 2 && highs[1].price > highs[0].price && lows[1].price > lows[0].price
        if (!trending) bump('A not HH+HL')
        if (trending) {
          emit('A', bar.end, bar.h, episodeLow, range, S.setupA.minRoomR, null, null, `third touch after ${bounces} bounces`)
          bounces = 0
          inTouch = false
          touchLow = Infinity
          fired = true
        }
      }
      if (!fired) {
        let bounced = false
        if (inTouch && bar.c > touchHigh) {
          bounces += 1
          inTouch = false
          bounced = true
        }
        if (touches && !inTouch && !bounced) {
          inTouch = true
          touchHigh = bar.h
          touchLow = bar.l
        } else if (touches) touchLow = Math.min(touchLow, bar.l)
      }
    }

    if (!isToday || range == null) continue

    // ---- Setup B: level breakout, or the first retest that holds ----
    const levels: Array<[string, number | null]> = [['PMH', pmh], ['PDH', pdh], ['ORH', minute > S.setupB.orEndMinute ? orh : null]]
    for (const [name, level] of levels) {
      if (level == null) continue
      const key = `${symbol}:${name}`
      const state = levelState.get(key)
      if (!state) {
        if (!(bar.c > level) || !(j > 0 && five[j - 1].c <= level)) continue
        if (inWindow) bump(`B ${name} close crossed level`)
        const average = volumeAvg(j)
        if (average == null || bar.v < S.setupB.breakoutVolumeMult * average) {
          if (inWindow) bump('B volume <2x avg')
          continue
        }
        let count = 0
        for (let k = j - 1; k >= 0 && today5.has(k); k -= 1) {
          if (five[k].c <= level && five[k].l >= level - S.setupB.consolidationAtr * range) count += 1
          else break
        }
        if (count < S.setupB.consolidationMinBars) {
          if (inWindow) bump('B base <3 bars within 1 ATR')
          continue
        }
        const base = five.slice(j - count, j)
        const baseAverage = base.reduce((sum, item) => sum + item.v, 0) / count
        if (!(baseAverage < average && base[count - 1].v < base[0].v)) {
          if (inWindow) bump('B base volume not falling')
          continue
        }
        levelState.set(key, { brokeAt: j, level, retestDone: false })
        if (inWindow && gated(bar.end, 'B')) emit('B', bar.end, bar.c, level, range, S.setupB.minRoomR, level, key, `${name} breakout ${level.toFixed(2)} after ${count}-bar base`)
      } else if (!state.retestDone && j > state.brokeAt) {
        if (bar.c < level || j - state.brokeAt > S.setupB.retestMaxBars) {
          state.retestDone = true
          continue
        }
        if (bar.l <= level + S.stop.bufferAtr * range) {
          state.retestDone = true
          if (inWindow && gated(bar.end, 'B-retest')) emit('B-retest', bar.end, bar.h, level, range, S.setupB.minRoomR, level, key, `${name} retest held ${level.toFixed(2)}`)
        }
      }
    }

    // ---- Exit facts at this 5m close ----
    const hod = hodAt(bar.end) ?? bar.h
    const prevHigh = lastConfirmed(pivots.highs.filter((pivot) => pivot.index < j), bar.end)
    const divergence = prevHigh != null && bar.h > prevHigh.price && rsi5[j] != null && prevHigh.rsi != null && rsi5[j]! < prevHigh.rsi
    const bearishCandle = isShootingStar(bar) || (j > 0 && isBearishEngulfing(five[j - 1], bar))
    const highsNow = confirmedBy(pivots.highs, bar.end)
    const lowsNow = confirmedBy(pivots.lows, bar.end)
    const structureBreak = highsNow.length === 2 && lowsNow.length === 2 && highsNow[1].price < highsNow[0].price && lowsNow[1].price < lowsNow[0].price
    events.push({
      end: bar.end,
      close: bar.c,
      runnerBelow: runnerSma[j] != null && bar.c < runnerSma[j]!,
      belowVwap: false,
      exhaustion: bearishCandle && bar.h >= hod - S.exits.hodToleranceAtr * range && divergence,
      structureBreakAt: structureBreak ? Math.max(highsNow[1].confirmedAt, lowsNow[1].confirmedAt) : null,
      tightenTo: null,
    })
  }

  const { byMinute, cumVolume } = minuteMaps(todayBars, midnight)
  return { version: 'S', symbol, day, midnight, bars: todayBars, byMinute, cumVolume, signals, events, pdh, prevClose: input.prevClose, float: null }
}
