import assert from 'node:assert/strict'
import test from 'node:test'
import { RULEBOOK } from '../scripts/backtest/rulebook/config'
import { atr, ema, isBullishEngulfing, isHammer, isMorningStar, isShootingStar, rsi, sma, aggregate, lastCompleted } from '../scripts/backtest/rulebook/indicators'
import { minuteMaps, nearestAbove, roomInR } from '../scripts/backtest/rulebook/common'
import { Account } from '../scripts/backtest/rulebook/engine'
import { metrics, passFail, rulebookMonth } from '../scripts/backtest/rulebook/report'
import { buildSP, runScanner } from '../scripts/backtest/rulebook/strategy-sp'
import { buildS } from '../scripts/backtest/rulebook/strategy-s'

const MIDNIGHT = Date.parse('2026-05-04T00:00:00-04:00')
const at = (minute) => MIDNIGHT + minute * 60_000
const bar = (minute, o, h, l, c, v = 100_000) => ({ t: at(minute), o, h, l, c, v })

function frame({ version = 'SP', bars, signals = [], events = [], pdh = null }) {
  const { byMinute, cumVolume } = minuteMaps(bars, MIDNIGHT)
  return { version, symbol: 'TEST', day: '2026-05-04', midnight: MIDNIGHT, bars, byMinute, cumVolume, signals, events, pdh, prevClose: 1, float: 5e6 }
}

function signal(overrides = {}) {
  return {
    version: 'SP', symbol: 'TEST', setup: '1', time: at(600), trigger: 5, limit: 5 * 1.005, stop: 4.8, atr5: 0.2, basisLow: 4.85,
    level: null, levelKey: null, roomR: Infinity, minRoomR: 3, entryEligible: true, addEligible: true, gapPct: 0.25, rvol: 8, note: 'test',
    ...overrides,
  }
}

const VOL = bar(590, 4.9, 4.95, 4.85, 4.9, 5_000_000)
const run = (versions = ['SP'], mult = 1) => ({ id: 'T', label: 'test', versions, spSlippageMultiplier: mult })

test('SMA, EMA, Wilder RSI and ATR follow the rulebook definitions', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5])
  const e = ema([1, 2, 3, 4, 5], 3)
  assert.equal(e[2], 2)
  assert.equal(e[3], 0.5 * 4 + 0.5 * 2)
  const up = rsi(Array.from({ length: 20 }, (_, i) => i), 14)
  assert.equal(up[14], 100)
  const bars = Array.from({ length: 15 }, (_, i) => ({ t: i, o: 10, h: 11, l: 9, c: 10, v: 1 }))
  assert.equal(atr(bars, 14)[13], 2)
})

test('candles: hammer, shooting star, bullish engulfing, morning star', () => {
  assert.equal(isHammer({ o: 10, h: 10.05, l: 9, c: 10.1 }), true)
  assert.equal(isHammer({ o: 10, h: 11, l: 9.9, c: 10.1 }), false)
  assert.equal(isShootingStar({ o: 10.1, h: 11, l: 10, c: 10 }), true)
  assert.equal(isBullishEngulfing({ o: 10.5, h: 10.6, l: 10, c: 10.1 }, { o: 10.05, h: 10.8, l: 10, c: 10.7 }), true)
  assert.equal(isMorningStar({ o: 11, h: 11.05, l: 9.95, c: 10 }, { o: 9.9, h: 10, l: 9.7, c: 9.95 }, { o: 10, h: 10.9, l: 9.95, c: 10.8 }), true)
})

test('5-minute bars are known only at their end time (no look-ahead)', () => {
  const bars = [bar(570, 10, 10.2, 9.9, 10.1), bar(571, 10.1, 10.3, 10, 10.2), bar(574, 10.2, 10.4, 10.1, 10.3), bar(575, 10.3, 10.5, 10.2, 10.4)]
  const five = aggregate(bars, 5, (t) => Math.round((t - MIDNIGHT) / 60_000), () => 'd')
  assert.equal(five.length, 2)
  assert.equal(five[0].end, at(575))
  assert.equal(five[0].c, 10.3)
  assert.equal(lastCompleted(five, at(574)), -1)
  assert.equal(lastCompleted(five, at(575)), 0)
})

test('room to resistance ignores levels at the trigger and is measured in R', () => {
  assert.equal(nearestAbove([5, 5.005, 6, 5.6], 5), 5.6)
  assert.ok(Math.abs(roomInR(5.6, 5, 4.8) - 3) < 1e-9)
  assert.equal(roomInR(Infinity, 5, 4.8), Infinity)
})

test('entry fills at max(trigger, open) + slippage; no fill when the open is above the limit', () => {
  const bars = [VOL, bar(600, 4.95, 5.1, 4.9, 5.05, 500_000), bar(601, 5.06, 5.12, 5.0, 5.1, 500_000)]
  const account = new Account(run())
  account.simulateDay('2026-05-04', [frame({ bars, signals: [signal()] })])
  const trade = account.trades[0]
  assert.ok(trade, 'one trade')
  assert.equal(trade.entryPrice.toFixed(6), (5 * 1.005).toFixed(6)) // trigger 5 (open 4.95 below it) + 0.5% RTH slippage

  const gapped = [VOL, bar(600, 5.04, 5.1, 5.0, 5.08, 500_000)] // opens above limit 5.025
  const second = new Account(run())
  second.simulateDay('2026-05-04', [frame({ bars: gapped, signals: [signal()] })])
  assert.equal(second.trades.length, 0)
  assert.equal(second.stats.expiredUnfilled + second.stats.filled, 1)
})

test('premarket SP fills use 1.0% slippage; run D doubles SP slippage', () => {
  const pre = [bar(470, 4.9, 4.95, 4.85, 4.9, 5_000_000), bar(480, 4.98, 5.05, 4.97, 5.0, 500_000)]
  const account = new Account(run(['SP'], 2))
  account.simulateDay('2026-05-04', [frame({ bars: pre, signals: [signal({ time: at(480) })] })])
  assert.equal(account.trades[0].entryPrice.toFixed(6), (5 * 1.02).toFixed(6))
})

test('stop touch fills at stop − slippage; a bar opening below the stop fills at its open − slippage', () => {
  const touch = [VOL, bar(600, 4.98, 5.02, 4.97, 5.01, 500_000), bar(601, 5.0, 5.0, 4.7, 4.75, 500_000)]
  const a = new Account(run())
  a.simulateDay('2026-05-04', [frame({ bars: touch, signals: [signal()] })])
  assert.equal(a.trades[0].exitReason, 'stop')
  assert.equal(a.trades[0].exitPrice.toFixed(6), (4.8 * 0.995).toFixed(6))

  const gap = [VOL, bar(600, 4.98, 5.02, 4.97, 5.01, 500_000), bar(601, 4.6, 4.65, 4.5, 4.55, 500_000)]
  const b = new Account(run())
  b.simulateDay('2026-05-04', [frame({ bars: gap, signals: [signal()] })])
  assert.equal(b.trades[0].exitReason, 'gap-stop')
  assert.equal(b.trades[0].exitPrice.toFixed(6), (4.6 * 0.995).toFixed(6))
  assert.ok(b.trades[0].rResult < -1, 'a gap can lose more than 1R')
})

test('fills larger than 10% of the bar volume are rejected', () => {
  const thin = [bar(600, 4.98, 5.02, 4.97, 5.01, 300)]
  const account = new Account(run())
  account.simulateDay('2026-05-04', [frame({ bars: [bar(590, 4.9, 4.95, 4.85, 4.9, 2_000_000), ...thin], signals: [signal()] })])
  assert.equal(account.trades.length, 0)
  assert.equal(account.stats.rejectedBarVolume, 1)
})

test('sizing: 0.5% risk for SP, capped at 100% of equity with no leverage', () => {
  const bars = [bar(590, 4.9, 4.95, 4.85, 4.9, 5_000_000), bar(600, 4.98, 5.02, 4.97, 5.01, 5_000_000)]
  const account = new Account(run())
  account.simulateDay('2026-05-04', [frame({ bars, signals: [signal()] })])
  const trade = account.trades[0]
  // $2,000 × 0.5% = $10 risk / $0.20 = 50 shares ($250) — under the $2,000 cap.
  assert.equal(trade.shares, 50)
  const wide = new Account(run(['S']))
  const sBars = [bar(590, 49, 49.5, 48.5, 49, 5_000_000), bar(600, 49.9, 50.1, 49.8, 50, 5_000_000)]
  wide.simulateDay('2026-05-04', [frame({ version: 'S', bars: sBars, signals: [signal({ version: 'S', setup: 'A', trigger: 50, limit: 50.1, stop: 49.9, atr5: 0.1 })] })])
  // 1% × $2,000 = $20 / $0.10 = 200 shares = $10,000 → capped to 39 shares ($2,000 / $50.1); risk $3.9 < 0.5R → skipped.
  assert.equal(wide.trades.length, 0)
  assert.equal(wide.stats.skipped['caps-below-half-R'], 1)
})

test('S scale-out sells half at +3R (resting limit), R-trail locks profit, flatten at 15:30', () => {
  const s = signal({ version: 'S', setup: 'A', trigger: 50, limit: 50.1, stop: 49.5, atr5: 0.4 })
  const bars = [
    bar(590, 49.8, 49.9, 49.7, 49.8, 5_000_000),
    bar(600, 49.95, 50.05, 49.9, 50.02, 5_000_000), // fill at 50 × 1.0005
    bar(601, 50.1, 51.7, 50.05, 51.6, 5_000_000), // +3R = 51.5015 → scale half; high 51.7 ≈ +3.4R → stop to +2R
    bar(930, 51.5, 51.6, 51.4, 51.5, 5_000_000), // flatten at the 15:30 open
  ]
  const account = new Account(run(['S']))
  account.simulateDay('2026-05-04', [frame({ version: 'S', bars, signals: [s] })])
  const trade = account.trades[0]
  assert.match(trade.partials, /scale-1/)
  assert.equal(trade.exitReason, 'flatten')
  assert.ok(trade.rResult > 2.5 && trade.rResult < 3.5, `R ${trade.rResult}`)
})

test('time stop: SP exits at the next open if +1R is not reached within 15 minutes', () => {
  const bars = [bar(590, 4.9, 4.95, 4.85, 4.9, 5_000_000)]
  for (let m = 600; m <= 620; m += 1) bars.push(bar(m, 5.0, 5.05, 4.95, 5.0, 5_000_000))
  const account = new Account(run())
  account.simulateDay('2026-05-04', [frame({ bars, signals: [signal()] })])
  assert.equal(account.trades[0].exitReason, 'time-stop')
  assert.equal(account.trades[0].exitTime, at(615))
})

test('fees: SEC $20.60/M and FINRA TAF on sells', () => {
  const bars = [bar(590, 4.9, 4.95, 4.85, 4.9, 5_000_000), bar(600, 4.98, 5.02, 4.97, 5.01, 5_000_000), bar(930, 5.01, 5.02, 5.0, 5.01, 5_000_000)]
  const account = new Account(run())
  account.simulateDay('2026-05-04', [frame({ bars, signals: [signal()] })])
  const trade = account.trades[0]
  const price = 5.01 * 0.995
  const expected = 50 * price * RULEBOOK.costs.secFeePerDollar + 50 * RULEBOOK.costs.finraTafPerShare
  assert.equal(trade.fees.toFixed(8), expected.toFixed(8))
})

test('daily loss stop blocks new entries after −3R', () => {
  const bars = [bar(590, 4.9, 4.95, 4.85, 4.9, 5_000_000)]
  const signals = []
  for (let k = 0; k < 4; k += 1) {
    const m = 600 + k * 10
    bars.push(bar(m, 4.98, 5.02, 4.97, 5.0, 5_000_000), bar(m + 1, 4.5, 4.5, 4.4, 4.45, 5_000_000))
    signals.push(signal({ symbol: 'TEST', time: at(m), basisLow: 4.85 + k * 0.01 }))
  }
  const account = new Account(run())
  account.simulateDay('2026-05-04', [frame({ bars, signals })])
  // Each gap loss is about −2.4R, so after two losses the day is past −3R and later signals are blocked.
  assert.equal(account.trades.length, 2)
  assert.equal(account.stats.skipped['daily-loss-stop'], 2)
})

test('pass/fail: rulebook months run 14th to 13th; windows use calendar months', () => {
  const P6 = { ...RULEBOOK.period, start: '2026-04-14' } // the 6-month layout this test describes
  assert.equal(rulebookMonth('2026-04-14'), '2026-04')
  assert.equal(rulebookMonth('2026-05-13'), '2026-04')
  assert.equal(rulebookMonth('2026-10-13'), '2026-09')
  const trades = Array.from({ length: 120 }, (_, i) => ({ date: `2026-0${4 + (i % 6)}-20`, rResult: i % 3 === 0 ? -1 : 1.2, equityAfter: 2000 + i, pnl: 1 }))
  const full = passFail(trades, 2000, 'full', 100, P6)
  assert.equal(full.pass, true)
  assert.equal(passFail(trades, 2000, 'full').checks[5].rule, '≥ 16 of 24') // default 24-month period
  assert.equal(metrics(trades, 2000).trades, 120)
  const tuning = passFail(trades.slice(0, 30), 2000, 'tuning', 58, P6)
  assert.equal(tuning.checks[0].pass, false) // 30 < 58 trades
})

test('SP scanner: only the top 3 by gap × RVOL with news and volume are eligible', () => {
  const symbols = ['AAA', 'BBB', 'CCC', 'DDD'].map((symbol, index) => ({
    symbol, prevClose: 2, midnight: MIDNIGHT, newsTimes: [at(300)],
    todayBars: Array.from({ length: 30 }, (_, k) => bar(400 + k, 2.5 + index * 0.05, 2.6 + index * 0.05, 2.45 + index * 0.05, 2.5 + index * 0.05, 20_000)),
    baselineAt: () => 10_000,
  }))
  const noNews = { ...symbols[0], symbol: 'EEE', newsTimes: [], todayBars: symbols[3].todayBars }
  const scanner = runScanner([...symbols, noNews])
  const eligibleAt = (symbol) => scanner.get(symbol).eligible[425]
  assert.equal(eligibleAt('DDD'), 1)
  assert.equal(eligibleAt('CCC'), 1)
  assert.equal(eligibleAt('BBB'), 1)
  assert.equal(eligibleAt('AAA'), 0)
  assert.equal(eligibleAt('EEE'), 0)
})

test('SP builder emits a Setup 1 premarket-high breakout only with the trend gate and room', () => {
  const bars = []
  let price = 2.4
  for (let m = 240; m < 600; m += 1) {
    const open = price
    price += 0.0025 + 0.012 * Math.sin(m / 9) // oscillating uptrend so RSI stays inside 50-90
    bars.push(bar(m, open, Math.max(open, price) + 0.003, Math.min(open, price) - 0.003, price, 20_000))
  }
  const last = bars.at(-1)
  const hod = Math.max(...bars.map((item) => item.h))
  bars.push(bar(600, last.c, hod + 0.02, last.c - 0.002, hod + 0.012, 200_000)) // closes just above HOD on 10x volume
  const eligible = new Uint8Array(1440).fill(1)
  const frameSP = buildSP({ symbol: 'UP', day: '2026-05-04', midnight: MIDNIGHT, prevClose: 2.0, float: 5e6, todayBars: bars, prior: null, dailyPivotHighs: [], scanner: { eligible, gap: new Float64Array(1440).fill(0.25), rvol: new Float64Array(1440).fill(9) } })
  const breakout = frameSP.signals.find((item) => item.setup === '1' && item.time === at(601))
  assert.ok(breakout, 'setup 1 fired on the volume breakout bar')
  assert.ok(breakout.stop < breakout.trigger && breakout.trigger - breakout.stop <= 0.1 * breakout.trigger)
  assert.match(breakout.note, /HOD/)
  assert.equal(breakout.entryEligible, true)
})

test('S builder runs on regular-hours bars and never emits signals outside 9:45-14:30', () => {
  const make = (midnight, base) => {
    const list = []
    let p = base
    for (let m = 240; m < 960; m += 1) {
      p += Math.sin(m / 7) * 0.05 + 0.01
      list.push({ t: midnight + m * 60_000, o: p - 0.02, h: p + 0.08, l: p - 0.08, c: p, v: 50_000 + (m % 13) * 1000 })
    }
    return list
  }
  const priorMidnight = Date.parse('2026-05-01T00:00:00-04:00')
  const frameS = buildS({ symbol: 'LIQ', day: '2026-05-04', midnight: MIDNIGHT, prevClose: 50, todayBars: make(MIDNIGHT, 55), priorSessions: [{ day: '2026-05-01', midnight: priorMidnight, bars: make(priorMidnight, 48) }], dailyPivotHighs: [] })
  for (const item of frameS.signals) {
    const minute = (item.time - MIDNIGHT) / 60_000
    assert.ok(minute >= 585 && minute <= 870, `signal at minute ${minute}`)
    assert.ok(item.trigger - item.stop >= item.atr5 * 0.999 && item.trigger - item.stop <= item.atr5 * 3.001)
  }
  assert.ok(frameS.events.length > 0)
})

test('variant E: R-trail moves on 5-min closes, so a 1-min spike to +1.2R does not move the stop to breakeven', () => {
  // Entry 5.025 (trigger 5 + 0.5%), stop 4.8, R ≈ 0.225. A 1-min high of 5.30 (+1.2R) then a dip to 5.00.
  const bars = [VOL, bar(600, 4.98, 5.02, 4.97, 5.01, 5_000_000), bar(601, 5.05, 5.30, 5.04, 5.10, 5_000_000), bar(602, 5.08, 5.09, 5.00, 5.05, 5_000_000), bar(930, 5.6, 5.6, 5.5, 5.55, 5_000_000)]
  const events = [{ end: at(605), close: 5.06, runnerBelow: false, belowVwap: false, exhaustion: false, structureBreakAt: null, tightenTo: null }]
  const base = new Account(run())
  base.simulateDay('2026-05-04', [frame({ bars, signals: [signal()], events })])
  assert.equal(base.trades[0].exitReason, 'trail-stop') // base: breakeven stop hit by the 5.00 dip
  const variant = new Account({ ...run(), id: 'E', variant: 'E' })
  variant.simulateDay('2026-05-04', [frame({ bars, signals: [signal()], events })])
  assert.equal(variant.trades[0].exitReason, 'flatten') // E: 5-min close 5.06 < +1R, stop stays at 4.8
})

test('variant E: the time stop exits only if the trade is below entry at 15 minutes', () => {
  const green = [VOL, bar(600, 4.98, 5.02, 4.97, 5.01, 5_000_000)]
  for (let m = 601; m <= 620; m += 1) green.push(bar(m, 5.05, 5.08, 5.03, 5.06, 5_000_000))
  const e1 = new Account({ ...run(), id: 'E', variant: 'E' })
  e1.simulateDay('2026-05-04', [frame({ bars: [...green, bar(930, 5.06, 5.07, 5.05, 5.06, 5_000_000)], signals: [signal()] })])
  assert.equal(e1.trades[0].exitReason, 'flatten')
  const red = [VOL, bar(600, 4.98, 5.02, 4.97, 5.01, 5_000_000)]
  for (let m = 601; m <= 620; m += 1) red.push(bar(m, 4.95, 4.97, 4.9, 4.94, 5_000_000))
  const e2 = new Account({ ...run(), id: 'E', variant: 'E' })
  e2.simulateDay('2026-05-04', [frame({ bars: red, signals: [signal()] })])
  assert.equal(e2.trades[0].exitReason, 'time-stop')
})

test('variant E: SP smart stop is widened to at least 1.0 ATR(5m)', () => {
  const bars = []
  let price = 2.4
  for (let m = 240; m < 600; m += 1) {
    const open = price
    price += 0.0025 + 0.012 * Math.sin(m / 9)
    bars.push(bar(m, open, Math.max(open, price) + 0.003, Math.min(open, price) - 0.003, price, 20_000))
  }
  const last = bars.at(-1)
  const hod = Math.max(...bars.map((item) => item.h))
  bars.push(bar(600, last.c, hod + 0.02, last.c - 0.002, hod + 0.012, 200_000))
  const scanner = { eligible: new Uint8Array(1440).fill(1), gap: new Float64Array(1440).fill(0.25), rvol: new Float64Array(1440).fill(9), why: new Uint8Array(1440) }
  const input = { symbol: 'UP', day: '2026-05-04', midnight: MIDNIGHT, prevClose: 2.0, float: 5e6, todayBars: bars, prior: null, dailyPivotHighs: [], scanner }
  const variant = buildSP({ ...input, stopMinWidthAtr: 1.0, widenTightStop: true, countFunnel: false })
  const signalE = variant.signals.find((item) => item.setup === '1' && item.time === at(601))
  assert.ok(signalE)
  assert.ok(signalE.trigger - signalE.stop >= signalE.atr5 - 1e-9, 'stop at least 1 ATR away')
})

test('room to resistance ignores the signal candle\'s own wick (HOD breakout with nothing above has unlimited room)', () => {
  const bars = []
  let price = 2.4
  for (let m = 240; m < 600; m += 1) {
    const open = price
    price += 0.0025 + 0.012 * Math.sin(m / 9)
    bars.push(bar(m, open, Math.max(open, price) + 0.003, Math.min(open, price) - 0.003, price, 20_000))
  }
  const last = bars.at(-1)
  const hod = Math.max(...bars.map((item) => item.h))
  bars.push(bar(600, last.c, hod + 0.05, last.c - 0.002, hod + 0.012, 200_000)) // long upper wick above the close
  const scanner = { eligible: new Uint8Array(1440).fill(1), gap: new Float64Array(1440).fill(0.25), rvol: new Float64Array(1440).fill(9), why: new Uint8Array(1440) }
  const frameSP = buildSP({ symbol: 'UP', day: '2026-05-04', midnight: MIDNIGHT, prevClose: 2.0, float: 5e6, todayBars: bars, prior: null, dailyPivotHighs: [], scanner, countFunnel: false })
  const breakout = frameSP.signals.find((item) => item.setup === '1' && item.time === at(601))
  assert.ok(breakout)
  assert.equal(breakout.roomR, Infinity)
})

test('run F: SP Setup 1 accepts 1.5x breakout volume; base still needs 2x; room log records the nearest level type', async () => {
  const { nearestAboveTyped } = await import('../scripts/backtest/rulebook/common')
  const { spFunnel } = await import('../scripts/backtest/rulebook/strategy-sp')
  assert.deepEqual(nearestAboveTyped([['HOD', 5.5], ['prior-day high', 5.2], ['premarket high', 4.9]], 5), { level: 5.2, type: 'prior-day high' })
  const bars = []
  let price = 2.4
  for (let m = 240; m < 600; m += 1) {
    const open = price
    price += 0.0025 + 0.012 * Math.sin(m / 9)
    bars.push(bar(m, open, Math.max(open, price) + 0.003, Math.min(open, price) - 0.003, price, 20_000))
  }
  const last = bars.at(-1)
  const hod = Math.max(...bars.map((item) => item.h))
  bars.push(bar(600, last.c, hod + 0.02, last.c - 0.002, hod + 0.012, 32_000)) // 1.6x the 10-bar average
  const scanner = { eligible: new Uint8Array(1440).fill(1), gap: new Float64Array(1440).fill(0.25), rvol: new Float64Array(1440).fill(9), why: new Uint8Array(1440) }
  const input = { symbol: 'UP', day: '2026-05-04', midnight: MIDNIGHT, prevClose: 2.0, float: 5e6, todayBars: bars, prior: null, dailyPivotHighs: [], scanner, countFunnel: false }
  const base = buildSP(input)
  assert.equal(base.signals.some((item) => item.setup === '1' && item.time === at(601)), false)
  const variantF = buildSP({ ...input, breakoutVolumeMult: 1.5 })
  assert.equal(variantF.signals.some((item) => item.setup === '1' && item.time === at(601)), true)
  // A daily swing high just above the trigger blocks the trade on room and is logged with its type.
  const before = spFunnel['room-blocked nearest: daily swing high (60d)'] ?? 0
  const blocked = buildSP({ ...input, breakoutVolumeMult: 1.5, dailyPivotHighs: [hod + 0.05], countFunnel: true }).signals.find((item) => item.time === at(601))
  assert.deepEqual(blocked.blockers, ['room < 3R'])
  assert.equal(spFunnel['room-blocked nearest: daily swing high (60d)'], before + 1)
})

test('room shadow (RS/RSP) trades only signals blocked by room alone; normal runs skip them', () => {
  const bars = [VOL, bar(600, 4.98, 5.02, 4.97, 5.01, 5_000_000), bar(930, 5.01, 5.02, 5.0, 5.01, 5_000_000)]
  const roomBlocked = signal({ entryEligible: false, blockers: ['room < 3R'], roomR: 1.2 })
  const base = new Account(run())
  base.simulateDay('2026-05-04', [frame({ bars, signals: [roomBlocked] })])
  assert.equal(base.trades.length, 0)
  const shadow = new Account({ ...run(), id: 'RSP', variant: 'RSP' })
  shadow.simulateDay('2026-05-04', [frame({ bars, signals: [roomBlocked] })])
  assert.equal(shadow.trades.length, 1)
  const normal = new Account({ ...run(), id: 'RSP', variant: 'RSP' })
  normal.simulateDay('2026-05-04', [frame({ bars, signals: [signal()] })])
  assert.equal(normal.trades.length, 0) // eligible signals are not part of the shadow group
  const scannerBlocked = new Account({ ...run(), id: 'RSP', variant: 'RSP' })
  scannerBlocked.simulateDay('2026-05-04', [frame({ bars, signals: [signal({ entryEligible: false, blockers: ['scanner: RVOL < 5x', 'room < 3R'] })] })])
  assert.equal(scannerBlocked.trades.length, 0)
})

test('run G: entries only until 9:59 AM ET and only with RVOL >= 100x', () => {
  const bars = [VOL, bar(600, 4.98, 5.02, 4.97, 5.01, 5_000_000), bar(930, 5.01, 5.02, 5.0, 5.01, 5_000_000)]
  const g = () => new Account({ ...run(), id: 'G', variant: 'G' })
  const lowRvol = g(); lowRvol.simulateDay('2026-05-04', [frame({ bars, signals: [signal({ rvol: 50 })] })])
  assert.equal(lowRvol.trades.length, 0)
  const ok = g(); ok.simulateDay('2026-05-04', [frame({ bars, signals: [signal({ rvol: 150, time: at(599) })] })])
  assert.equal(ok.trades.length, 1)
  const late = g(); late.simulateDay('2026-05-04', [frame({ bars, signals: [signal({ rvol: 150, time: at(600) })] })])
  assert.equal(late.trades.length, 0)
})

test('run H: daily series flags a 20-day-high close in an uptrend (Turtle S1) and nothing without the 20>50>200 trend', async () => {
  const { buildSeries } = await import('../scripts/backtest/rulebook/swing')
  const rows = []
  let price = 20
  for (let d = 0; d < 260; d += 1) {
    const open = price
    price *= 1 + 0.002 + 0.01 * Math.sin(d / 5)
    rows.push({ day: `D${String(d).padStart(3, '0')}`, o: open, h: Math.max(open, price) * 1.005, l: Math.min(open, price) * 0.995, c: price, v: 2e6 })
  }
  const up = buildSeries('UP', rows)
  assert.ok(up.signal.some((value) => value === 'B'))
  const down = buildSeries('DN', rows.map((row) => ({ ...row, o: 100 - row.o * 0.2, h: 100 - row.l * 0.2, l: 100 - row.h * 0.2, c: 100 - row.c * 0.2 })))
  assert.equal(down.signal.some((value) => value !== null), false)
})

test('SP-Runner: fact check finds the high time; runner enters on a VWAP reclaim 8:30-9:15 and exits by 11:30', async () => {
  const { runnerSignal, simulateRunner } = await import('../scripts/backtest/rulebook/runner')
  const bars = []
  // 7:00-8:29 base around 2.45-2.55 with volume; 8:30-8:40 dip below VWAP; 8:41 reclaim; then trend up to ~3.2 by 10:30; fade after.
  for (let m = 420; m < 510; m += 1) bars.push(bar(m, 2.5, 2.55, 2.45, 2.5 + 0.02 * Math.sin(m / 3), 30_000))
  for (let m = 510; m < 521; m += 1) bars.push(bar(m, 2.48, 2.49, 2.46, 2.47, 20_000))
  bars.push(bar(521, 2.47, 2.56, 2.47, 2.55, 60_000)) // close back above VWAP
  let p = 2.55
  for (let m = 522; m < 630; m += 1) { const o = p; p += 0.006; bars.push(bar(m, o, p + 0.01, o - 0.01, p, 40_000)) }
  for (let m = 630; m < 960; m += 1) { const o = p; p -= 0.002; bars.push(bar(m, o, o + 0.005, p - 0.005, p, 20_000)) }
  const eligible = new Uint8Array(1440).fill(1)
  const input = { symbol: 'RUN', prevClose: 2.0, bars, prior: [], newsTimes: [at(300)], eligible }
  const sig = runnerSignal(input, '2026-05-04', MIDNIGHT)
  assert.ok(sig, 'signal')
  assert.equal(sig.minute, 522)
  assert.ok(sig.stop < sig.baseLow)
  const result = simulateRunner(sig, '2026-05-04', MIDNIGHT, 10, 2000)
  assert.ok(result.trade, JSON.stringify(result))
  assert.ok(result.trade.exitTime <= at(690))
  assert.ok(result.trade.pnl > 0)
})

test('SP-Runner Step 2b: fixed -10% / +20% bracket from the fill, time exit at 11:30', async () => {
  const { simulateBracket } = await import('../scripts/backtest/rulebook/runner')
  const base = []
  for (let m = 420; m < 521; m += 1) base.push(bar(m, 2.5, 2.52, 2.48, 2.5, 50_000))
  const make = (after) => {
    const bars = [...base, bar(521, 2.5, 2.52, 2.49, 2.51, 50_000), ...after]
    return { symbol: 'BR', minute: 521, trigger: 2.5, stop: Number.NaN, baseLow: 2.4, pmh: null, input: { symbol: 'BR', prevClose: 2, bars, prior: [], newsTimes: [], eligible: new Uint8Array(1440) } }
  }
  const fill = 2.5 * 1.01 // premarket slippage 1%
  const win = simulateBracket(make([bar(522, 2.6, 3.2, 2.55, 3.1, 50_000)]), MIDNIGHT, 10, 2000)
  assert.equal(win.trade.exitReason, 'target')
  assert.equal(win.trade.exitPrice.toFixed(4), (fill * 1.2).toFixed(4))
  const loss = simulateBracket(make([bar(522, 2.45, 2.46, 2.2, 2.25, 50_000)]), MIDNIGHT, 10, 2000)
  assert.equal(loss.trade.exitReason, 'stop')
  assert.equal(loss.trade.exitPrice.toFixed(4), (fill * 0.9 * 0.99).toFixed(4))
  const flat = []
  for (let m = 522; m <= 700; m += 1) flat.push(bar(m, 2.55, 2.56, 2.54, 2.55, 50_000))
  const time = simulateBracket(make(flat), MIDNIGHT, 10, 2000)
  assert.equal(time.trade.exitReason, 'time-exit-11:30')
  assert.equal(time.trade.exitTime, at(690))
})

test('fill audit model: fills from the next full bar, stop before target, gap-stop at open, flatten at the real minute', async () => {
  const { modelTrade } = await import('../scripts/backtest/rulebook/audit')
  const M = 60_000
  const midnight = Date.parse('2026-10-14T00:00:00-04:00')
  const at = (m) => midnight + m * M
  const bar = (m, o, h, l, c) => ({ t: at(m), o, h, l, c })
  const base = { submitMs: at(577) + 35_000, trigger: 3.85, limit: 3.87, stop: 3.43, target: 4.27, flattenMs: null, midnight, slippage: () => 0.005 }
  // the 9:37 bar (order sent mid-bar) is ignored; 9:38 opens 3.80, trades up through 3.85 -> fill 3.85 * 1.005
  const bars = [bar(577, 3.9, 3.95, 3.7, 3.8), bar(578, 3.8, 3.86, 3.78, 3.84), bar(579, 3.84, 4.0, 3.82, 3.98), bar(580, 4.2, 4.4, 4.1, 4.35)]
  const r = modelTrade(bars, base)
  assert.equal(r.filled, true)
  assert.ok(Math.abs(r.entry - 3.85 * 1.005) < 1e-9)
  assert.equal(r.reason, 'target')
  assert.equal(r.exit, 4.27) // opened at 4.20 below the target -> fills at the target, no slippage
  // both stop and target inside one bar -> stop
  const both = modelTrade([bar(578, 3.8, 3.86, 3.78, 3.84), bar(579, 3.84, 4.5, 3.4, 4.0)], base)
  assert.equal(both.reason, 'stop')
  assert.ok(Math.abs(both.exit - 3.43 * 0.995) < 1e-9)
  // gap below the stop -> open - slippage
  const gap = modelTrade([bar(578, 3.8, 3.86, 3.78, 3.84), bar(579, 3.3, 3.35, 3.2, 3.25)], base)
  assert.equal(gap.reason, 'gap-stop')
  assert.ok(Math.abs(gap.exit - 3.3 * 0.995) < 1e-9)
  // opens above the limit for the whole valid window -> no fill
  const miss = modelTrade([bar(578, 3.9, 3.95, 3.88, 3.9), bar(579, 3.9, 3.95, 3.88, 3.9)], base)
  assert.equal(miss.filled, false)
  // flatten at the real flatten minute -> that bar's open - slippage
  const flat = modelTrade([bar(578, 3.8, 3.86, 3.78, 3.84), bar(579, 3.84, 3.9, 3.8, 3.85), bar(955, 3.7, 3.72, 3.6, 3.65)], { ...base, flattenMs: at(955) + 50_000 })
  assert.equal(flat.reason, 'flatten')
  assert.ok(Math.abs(flat.exit - 3.7 * 0.995) < 1e-9)
})
