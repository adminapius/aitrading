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

test('fill audit instant mode: fills at the SIP ask 2 s after sending, refuses above the limit, then the same exits', async () => {
  const { modelTrade } = await import('../scripts/backtest/rulebook/audit')
  const M = 60_000
  const midnight = Date.parse('2026-10-14T00:00:00-04:00')
  const at = (m) => midnight + m * M
  const bar = (m, o, h, l, c) => ({ t: at(m), o, h, l, c })
  const base = { submitMs: at(577) + 34_000, trigger: 3.85, limit: 3.87, stop: 3.43, target: 4.27, flattenMs: null, midnight, slippage: () => 0.005 }
  const bars = [bar(577, 3.9, 3.95, 3.7, 3.8), bar(578, 3.95, 4.1, 3.9, 4.05), bar(579, 4.2, 4.4, 4.1, 4.35)]
  // the next-bar rule would miss this (9:38 opens 3.95 > limit 3.87); instant mode fills at 3.79 + slippage in the 9:37 bar
  assert.equal(modelTrade(bars, base).filled, false)
  const r = modelTrade(bars, { ...base, instant: { ask: 3.79, at: base.submitMs + 2_000 } })
  assert.equal(r.filled, true)
  assert.ok(Math.abs(r.entry - 3.79 * 1.005) < 1e-9)
  assert.equal(r.entryTime, at(577))
  assert.equal(r.reason, 'target')
  assert.equal(modelTrade(bars, { ...base, instant: { ask: 3.9, at: base.submitMs + 2_000 } }).filled, false)
  assert.equal(modelTrade(bars, { ...base, instant: { ask: null, at: base.submitMs + 2_000 } }).filled, false)
})

test('SP-Runner v2: signed volume and pressure sums', async () => {
  const { signedVolume, pressureSeries } = await import('../scripts/backtest/rulebook/runner-v2')
  assert.equal(signedVolume({ h: 2, l: 1, c: 2, v: 100 }), 100)
  assert.equal(signedVolume({ h: 2, l: 1, c: 1, v: 100 }), -100)
  assert.equal(signedVolume({ h: 2, l: 1, c: 1.5, v: 100 }), 0)
  assert.equal(signedVolume({ h: 2, l: 2, c: 2, v: 100 }), 0)
  const byMinute = new Array(1440).fill(undefined)
  byMinute[600] = { h: 2, l: 1, c: 2, v: 100 }
  byMinute[602] = { h: 2, l: 1, c: 1, v: 30 } // 601 has no bar -> counts 0
  const p = pressureSeries(byMinute)
  assert.equal(p.p5(602), 70)
  assert.equal(p.sell5(602), 30)
  assert.equal(p.p5(607), 0) // window 603-607
  assert.equal(p.sell5Prev(607), 30) // 598-602
})

const v2Signal = (after, baseLow = 2.45) => {
  const bars = []
  for (let m = 420; m < 521; m += 1) bars.push(bar(m, 2.5, 2.52, 2.48, 2.5, 50_000))
  bars.push(bar(521, 2.5, 2.52, 2.49, 2.51, 50_000))
  bars.push(...after)
  return { symbol: 'V2', minute: 522, trigger: 2.5, stop: Number.NaN, baseLow, pmh: Math.max(...bars.filter((b) => b.t < at(570)).map((b) => b.h)), input: { symbol: 'V2', prevClose: 2, bars, prior: [], newsTimes: [], eligible: new Uint8Array(1440) } }
}
// two V-shaped cycles of 8 bars with rising lows -> two pivot lows -> a higher low
const cycles = (start, base0, count = 2) => {
  const out = []
  for (let k = 0; k < count; k += 1) {
    const base = base0 + 0.05 * k
    const lows = [0.03, 0.02, 0.01, 0, 0.01, 0.02, 0.03, 0.04].map((x) => base + x)
    lows.forEach((l, i) => out.push(bar(start + 8 * k + i, l + 0.01, l + 0.02, l, l + 0.015, 40_000)))
  }
  return out
}

test('SP-Runner v2: stop below base/VWAP minus 0.25 ATR, capped at 15%; flat day ends at the 15:30 backstop', async () => {
  const { simulateV2 } = await import('../scripts/backtest/rulebook/runner-v2')
  const flat = [bar(522, 2.5, 2.56, 2.5, 2.55, 50_000)]
  for (let m = 523; m < 960; m += 1) flat.push(bar(m, 2.53, 2.54, 2.52, 2.53, 50_000))
  const fill = 2.5 * 1.01
  const r = simulateV2(v2Signal(flat), '2026-05-04', MIDNIGHT, 10, 2000, 'full')
  assert.ok(r.trade, JSON.stringify(r))
  assert.ok(r.trade.stop < 2.45 && r.trade.stop > fill * 0.85, `stop ${r.trade.stop}`)
  assert.equal(r.trade.exitReason, 'backstop-15:30')
  assert.equal(r.trade.exitTime, at(930))
  assert.ok(Math.abs(r.trade.riskDollars - 10) <= fill - r.trade.stop) // sized to 0.5% risk (10 dollars) within one share
  const deep = simulateV2(v2Signal(flat, 1.5), '2026-05-04', MIDNIGHT, 10, 2000, 'full')
  assert.equal(deep.trade.stop.toFixed(6), (fill * 0.85).toFixed(6)) // structural stop too deep -> capped at 15%
  assert.ok(deep.trade.shares < r.trade.shares) // wider stop -> fewer shares, same dollar risk
})

test('SP-Runner v2: a higher low lifts the stop; the pressure trio exits at the next open before the raised stop', async () => {
  const { simulateV2 } = await import('../scripts/backtest/rulebook/runner-v2')
  const after = [bar(522, 2.51, 2.56, 2.5, 2.55, 50_000), ...cycles(523, 2.6)]
  const hl = 2.65 // second cycle's pivot low
  after.push(bar(539, hl + 0.03, hl + 0.035, hl - 0.003, hl - 0.002, 1_000_000)) // heavy selling, close below the higher low, low above the raised stop
  after.push(bar(540, hl - 0.01, hl, hl - 0.02, hl - 0.015, 50_000))
  const r = simulateV2(v2Signal(after), '2026-05-04', MIDNIGHT, 10, 2000, 'noAdd')
  assert.ok(r.trade, JSON.stringify(r))
  assert.equal(r.trade.exitReason, 'pressure-exit')
  assert.equal(r.trade.exitTime, at(540))
  assert.equal(r.trade.exitPrice.toFixed(4), ((hl - 0.01) * 0.99).toFixed(4))
  assert.ok(r.trade.rResult > 0)
  // without a higher low the trio cannot fire: the same selling bar after flat bars just holds
  const flatThenSell = [bar(522, 2.51, 2.56, 2.5, 2.55, 50_000)]
  for (let m = 523; m < 539; m += 1) flatThenSell.push(bar(m, 2.6, 2.61, 2.59, 2.6, 40_000))
  flatThenSell.push(bar(539, 2.6, 2.61, 2.56, 2.565, 1_000_000), bar(540, 2.56, 2.57, 2.55, 2.56, 50_000))
  const hold = simulateV2(v2Signal(flatThenSell), '2026-05-04', MIDNIGHT, 10, 2000, 'noAdd')
  assert.notEqual(hold.trade.exitReason, 'pressure-exit')
})

test('SP-Runner v2: one add 9:30-9:45 only after a higher low lifted the stop; none in no-add mode', async () => {
  const { simulateV2 } = await import('../scripts/backtest/rulebook/runner-v2')
  const after = [bar(522, 2.51, 2.56, 2.5, 2.55, 50_000)]
  for (let m = 523; m < 560; m += 1) after.push(bar(m, 2.55, 2.56, 2.54, 2.55, 40_000))
  after.push(...cycles(560, 2.6)) // pivots at 563 and 571 -> higher low confirmed at the 574 close
  // the 9:35 close (2.705) is above the premarket high (2.70) with P5 > 0 -> the one add order; 9:36 fills it
  after.push(bar(576, 2.71, 2.91, 2.7, 2.9, 40_000))
  after.push(bar(577, 2.9, 2.92, 2.89, 2.915, 40_000))
  for (let m = 578; m < 600; m += 1) after.push(bar(m, 2.92, 2.93, 2.91, 2.925, 40_000))
  const full = simulateV2(v2Signal(after), '2026-05-04', MIDNIGHT, 10, 2000, 'full')
  assert.ok(full.trade, JSON.stringify(full))
  assert.equal(full.trade.units, 2)
  assert.ok(full.trade.maxShares > full.trade.shares)
  assert.ok(full.trade.maxShares * full.trade.avgCost <= 2000 + 1e-6) // never more than 100% of equity
  const noAdd = simulateV2(v2Signal(after), '2026-05-04', MIDNIGHT, 10, 2000, 'noAdd')
  assert.equal(noAdd.trade.units, 1)
  // no higher low before the add window -> open risk is still 1R -> no add
  const flat = [bar(522, 2.51, 2.56, 2.5, 2.55, 50_000)]
  for (let m = 523; m < 576; m += 1) flat.push(bar(m, 2.55, 2.56, 2.54, 2.55, 40_000))
  flat.push(bar(576, 2.6, 2.91, 2.6, 2.9, 40_000), bar(577, 2.9, 2.92, 2.89, 2.915, 40_000))
  const none = simulateV2(v2Signal(flat), '2026-05-04', MIDNIGHT, 10, 2000, 'full')
  assert.equal(none.trade.units, 1)
})

test('SP-Runner v3: a higher low before 9:45 does not raise the stop; from 9:45 it does', async () => {
  const { simulateV2 } = await import('../scripts/backtest/rulebook/runner-v2')
  // higher low confirmed at the 8:54 close (premarket): v2 raises the stop, v3 keeps the initial stop
  const after = [bar(522, 2.51, 2.56, 2.5, 2.55, 50_000), ...cycles(523, 2.6)]
  // dip to 2.58: below v2's raised stop (~2.64) but above the initial stop (~2.44); no heavy selling
  after.push(bar(539, 2.66, 2.67, 2.58, 2.66, 20_000))
  for (let m = 540; m < 600; m += 1) after.push(bar(m, 2.66, 2.67, 2.65, 2.665, 20_000))
  const v2 = simulateV2(v2Signal(after), '2026-05-04', MIDNIGHT, 10, 2000, 'full')
  const v3 = simulateV2(v2Signal(after), '2026-05-04', MIDNIGHT, 10, 2000, 'full', { raiseStopFrom: 585 })
  assert.equal(v2.trade.exitReason, 'trail-stop')
  assert.equal(v2.trade.exitTime, at(540))
  assert.notEqual(v3.trade.exitReason, 'trail-stop')
  assert.ok(v3.trade.exitTime > at(540))
  // the same pattern after 9:45 raises the stop in v3 too
  const late = [bar(522, 2.51, 2.56, 2.5, 2.55, 50_000)]
  for (let m = 523; m < 590; m += 1) late.push(bar(m, 2.55, 2.56, 2.54, 2.55, 40_000))
  late.push(...cycles(590, 2.6))
  late.push(bar(606, 2.66, 2.67, 2.58, 2.66, 20_000), bar(607, 2.66, 2.67, 2.65, 2.665, 20_000))
  const v3late = simulateV2(v2Signal(late), '2026-05-04', MIDNIGHT, 10, 2000, 'full', { raiseStopFrom: 585 })
  assert.equal(v3late.trade.exitReason, 'trail-stop')
})

test('order flow: trades at/above ask are buys, at/below bid sells, in between by tick rule; odd lots and flagged prints excluded', async () => {
  const { classifyTrades } = await import('../scripts/backtest/rulebook/orderflow')
  const t = (m, s = 0) => at(m) + s * 1000
  const quotes = [{ t: t(420), bid: 2.0, ask: 2.02 }, { t: t(421, 30), bid: 2.05, ask: 2.07 }]
  const trades = [
    { t: t(420, 5), p: 2.02, s: 500, c: ['@', 'T'] }, // at ask -> buy (extended hours kept)
    { t: t(420, 6), p: 2.0, s: 300, c: ['@', 'T'] }, // at bid -> sell
    { t: t(420, 7), p: 2.01, s: 200, c: ['@'] }, // in between, up-tick from 2.00 -> buy
    { t: t(420, 8), p: 2.005, s: 100, c: ['@'] }, // in between, down-tick -> sell
    { t: t(420, 9), p: 2.01, s: 50, c: ['@', 'I'] }, // odd lot -> excluded
    { t: t(421, 10), p: 2.02, s: 400, c: ['@', 'W'] }, // flagged (average price) -> excluded
    { t: t(421, 40), p: 2.05, s: 1000, c: ['@'] }, // new quote: at bid -> sell
  ]
  const r = classifyTrades(trades, quotes, MIDNIGHT)
  assert.equal(r.buy[0], 700)
  assert.equal(r.sell[0], 400)
  assert.equal(r.sell[1], 1000)
  assert.equal(r.counts.oddLot, 1)
  assert.equal(r.counts.flagged, 1)
  assert.equal(r.counts.kept, 5)
  assert.equal(r.counts.tick, 2)
})

test('dilution: only filings accepted before 7:00 ET count; S-3 needs an EFFECT on its file number; 424B takedown within 30 days', async () => {
  const { beforeCutoff, exactFlags, atmText } = await import('../scripts/backtest/rulebook/dilution')
  assert.equal(beforeCutoff({ filingDate: '2026-09-24', acceptance: '2026-09-24T06:01:32.000Z' }, '2026-09-24'), true)
  assert.equal(beforeCutoff({ filingDate: '2026-09-24', acceptance: '2026-09-24T09:22:39.000Z' }, '2026-09-24'), false)
  assert.equal(beforeCutoff({ filingDate: '2026-09-23', acceptance: '2026-09-23T17:00:00.000Z' }, '2026-09-24'), true)
  const f = (form, acceptance, fileNumber = '') => ({ form, filingDate: acceptance.slice(0, 10), acceptance, accession: '', primaryDocument: '', fileNumber })
  const filings = [
    f('S-3', '2026-01-10T16:00:00.000Z', '333-1'),
    f('EFFECT', '2026-01-25T00:15:00.000Z', '333-1'),
    f('S-3', '2026-08-01T16:00:00.000Z', '333-2'), // never declared effective
    f('424B5', '2026-09-03T08:30:12.000Z'),
    f('424B5', '2026-09-24T09:22:39.000Z'), // same morning, after 7:00 -> not known yet
    f('424B3', '2026-09-20T08:00:00.000Z'),
  ]
  const day = exactFlags(filings, '2026-09-24')
  assert.equal(day.effectiveS3, true)
  assert.deepEqual(day.shelfFileNumbers, ['333-1'])
  assert.equal(day.takedown30, true) // Sep 3 is within 30 days
  assert.equal(day.resale424b3, true)
  const later = exactFlags(filings, '2026-10-06') // Sep 3 now 33 days back; Sep 24 is 12 days back
  assert.equal(later.takedown30, true)
  const before = exactFlags(filings, '2026-01-20') // S-3 filed, not yet effective
  assert.equal(before.effectiveS3, false)
  const withdrawn = exactFlags([...filings, f('RW', '2026-02-01T10:00:00.000Z', '333-1')], '2026-09-24')
  assert.equal(withdrawn.effectiveS3, false)
  assert.equal(atmText('<p>entered into an At-The-Market Sales Agreement with H.C. Wainwright</p>').atm, true)
  assert.equal(atmText('<p>the Company terminated the at&#8209;the&#8209;market sales agreement</p>').terminated, true)
  assert.equal(atmText('<p>market conditions and the sales of our products</p>').atm, false)
})

test('dilution: effective S-1 counts for 90 days after its EFFECT notice, not before, not after, not if withdrawn', async () => {
  const { exactFlags } = await import('../scripts/backtest/rulebook/dilution')
  const f = (form, acceptance, fileNumber = '') => ({ form, filingDate: acceptance.slice(0, 10), acceptance, accession: '', primaryDocument: '', fileNumber })
  const filings = [f('S-1', '2026-06-08T17:44:54.000Z', '333-9'), f('EFFECT', '2026-06-17T00:16:06.000Z', '333-9')]
  assert.equal(exactFlags(filings, '2026-06-12').effectiveS1_90, false) // filed, not yet effective
  assert.equal(exactFlags(filings, '2026-06-17').effectiveS1_90, true) // EFFECT accepted 00:16 that morning
  assert.equal(exactFlags(filings, '2026-09-14').effectiveS1_90, true) // 89 days
  assert.equal(exactFlags(filings, '2026-09-16').effectiveS1_90, false) // 91 days
  assert.equal(exactFlags([...filings, f('RW', '2026-07-01T10:00:00.000Z', '333-9')], '2026-07-15').effectiveS1_90, false)
})

test('dilution: EDGAR time read as UTC is converted to Eastern before the 7:00 cutoff', async () => {
  const { beforeCutoff, setEdgarTz } = await import('../scripts/backtest/rulebook/dilution')
  setEdgarTz('utc')
  // 10:30 UTC on Sep 24, 2026 = 06:30 EDT -> before 7:00
  assert.equal(beforeCutoff({ filingDate: '2026-09-24', acceptance: '2026-09-24T10:30:00.000Z' }, '2026-09-24'), true)
  // 11:30 UTC = 07:30 EDT -> after 7:00
  assert.equal(beforeCutoff({ filingDate: '2026-09-24', acceptance: '2026-09-24T11:30:00.000Z' }, '2026-09-24'), false)
  // 02:00 UTC on Sep 25 = 22:00 EDT on Sep 24 -> counts for Sep 25
  assert.equal(beforeCutoff({ filingDate: '2026-09-24', acceptance: '2026-09-25T02:00:00.000Z' }, '2026-09-25'), true)
  setEdgarTz('et')
  assert.equal(beforeCutoff({ filingDate: '2026-09-24', acceptance: '2026-09-24T06:30:00.000Z' }, '2026-09-24'), true)
})

test('Strategy F probe: point-in-time top by prior 20-day dollar volume, price above $10, no look-ahead', async () => {
  const { topByDollarVolume } = await import('../scripts/backtest/rulebook/strategy-f-probe')
  const days = Array.from({ length: 25 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`)
  const rows = (price, volume, todayVolume = volume) => days.map((day, i) => ({ day, o: price, h: price, l: price, c: price, v: i === 21 ? todayVolume : volume }))
  const daily = new Map([
    ['BIG', rows(50, 1_000_000)],
    ['MID', rows(20, 1_000_000, 1e12)], // huge volume ON the day itself must not count
    ['CHEAP', rows(9, 1e9)], // prior close under $10
    ['SPY', rows(500, 1e9)], // index ETFs are a separate line
    ['XETF', rows(100, 1e9)],
  ])
  const names = new Map([['BIG', 'Big Inc'], ['MID', 'Mid Corp'], ['CHEAP', 'Cheap Co'], ['SPY', 'SPDR S&P 500 ETF Trust'], ['XETF', 'Some Leveraged 3x ETF']])
  const top = topByDollarVolume(daily, names, days, 1)
  assert.deepEqual(top.get(days[21]), ['BIG'])
  assert.deepEqual(topByDollarVolume(daily, names, days, 5).get(days[21]), ['BIG', 'MID'])
  assert.deepEqual(top.get(days[10]), []) // fewer than 20 prior days
})

// ---------------- Strategy F ----------------
const FM = Date.parse('2026-05-04T00:00:00-04:00')
const fb = (m, o, h, l, c, v = 1_000_000) => ({ t: FM + m * 60_000, o, h, l, c, v })
// Red OR 9:30-9:44: open 101, low 98, high 102, close 99 (range 4). Flat bars elsewhere at `p`.
function fDay(after = [], pre = []) {
  const bars = [...pre]
  for (let m = 570; m <= 584; m += 1) bars.push(m === 570 ? fb(m, 101, 102, 100, 100.5) : m === 577 ? fb(m, 100, 100, 98, 99.5) : m === 584 ? fb(m, 99.5, 99.6, 98.9, 99) : fb(m, 100, 100.4, 99.6, 100))
  const set = new Map(after.map((b) => [Math.round((b.t - FM) / 60_000), b]))
  for (let m = 585; m <= 960; m += 1) bars.push(set.get(m) ?? fb(m, 99.5, 99.6, 99.4, 99.5))
  return bars
}

test('Strategy F: OR, direction, liquidity filter and F-A levels', async () => {
  const { buildSetup, ordersFA } = await import('../scripts/backtest/rulebook/strategy-f')
  const s = buildSetup('X', 0, 'stock', fDay(), FM, 10, 100, false)
  assert.equal(s.orHigh, 102); assert.equal(s.orLow, 98); assert.equal(s.range, 4); assert.equal(s.dir, 1)
  assert.equal(s.liquid, true) // 4 >= 25% of 10
  assert.equal(buildSetup('X', 0, 'stock', fDay(), FM, 20, 100, false).liquid, false) // 4 < 5
  const [o] = ordersFA(s)
  assert.equal(o.level, 98)
  assert.ok(Math.abs(o.target - (98 + 0.382 * 4)) < 1e-9)
  assert.ok(Math.abs(o.stop - (98 - 0.191 * 4)) < 1e-9)
  assert.equal(o.from, 585); assert.equal(o.to, 659)
})

test('Strategy F: fills - limit needs a 1-tick trade-through (touch line excepted); stop orders pay slippage', async () => {
  const { fillOn } = await import('../scripts/backtest/rulebook/strategy-f')
  const limit = { kind: 'limit', level: 98, stop: 97.236, target: 99.528, from: 585, to: 659, setup: 'F-A' }
  assert.equal(fillOn(limit, 1, fb(600, 98.5, 98.6, 98, 98.2), 'trade'), null) // touch only
  assert.equal(fillOn(limit, 1, fb(600, 98.5, 98.6, 98, 98.2), 'touch'), 98)
  assert.equal(fillOn(limit, 1, fb(600, 98.5, 98.6, 97.99, 98.2), 'trade'), 98)
  assert.equal(fillOn(limit, 1, fb(600, 97.8, 98.6, 97.5, 98.2), 'trade'), 97.8) // opened through the limit: better price
  const stopOrder = { kind: 'stop', level: 99, stop: 97, target: 102, from: 600, to: 604, setup: 'F-B hammer' }
  assert.ok(Math.abs(fillOn(stopOrder, 1, fb(600, 98.8, 99.2, 98.7, 99), 'trade') - 99 * 1.0005) < 1e-9)
  assert.equal(fillOn(stopOrder, 1, fb(600, 98.8, 98.9, 98.7, 98.8), 'trade'), null)
})

test('Strategy F: exits - entry-bar stop, worst case on stop+target, trade-through target, time exit at 11:00', async () => {
  const { simulateExit } = await import('../scripts/backtest/rulebook/strategy-f')
  const mk = (list) => list.map(([m, o, h, l, c]) => ({ ...fb(m, o, h, l, c), m }))
  // entry bar touches the stop -> stop, even though a target is hit there too
  let e = simulateExit(mk([[600, 98, 100, 97, 99]]), 0, 1, 97.236, 99.528, 660, 'trade')
  assert.equal(e.reason, 'stop (entry bar)'); assert.ok(Math.abs(e.price - 97.236 * 0.9995) < 1e-9)
  // later bar hits both -> stop
  e = simulateExit(mk([[600, 98, 98.1, 97.9, 98], [601, 98, 100, 97, 99]]), 0, 1, 97.236, 99.528, 660, 'trade')
  assert.equal(e.reason, 'stop')
  // target touched but not traded through -> no fill; next bar trades through -> target price
  e = simulateExit(mk([[600, 98, 98.1, 97.9, 98], [601, 99, 99.528, 98.9, 99.5], [602, 99.5, 99.54, 99.4, 99.5]]), 0, 1, 97.236, 99.528, 660, 'trade')
  assert.equal(e.reason, 'target'); assert.equal(e.minute, 602); assert.equal(e.price, 99.528)
  // nothing hit -> 11:00 bar open minus slippage
  e = simulateExit(mk([[600, 98, 98.1, 97.9, 98], [659, 98.5, 98.6, 98.4, 98.5], [660, 98.7, 98.8, 98.6, 98.7]]), 0, 1, 97.236, 99.528, 660, 'trade')
  assert.equal(e.reason, 'time 11:00'); assert.ok(Math.abs(e.price - 98.7 * 0.9995) < 1e-9)
  // gap through the stop -> open
  e = simulateExit(mk([[600, 98, 98.1, 97.9, 98], [601, 96, 96.5, 95.5, 96]]), 0, 1, 97.236, 99.528, 660, 'trade')
  assert.equal(e.reason, 'gap-stop'); assert.ok(Math.abs(e.price - 96 * 0.9995) < 1e-9)
  // short mirror
  e = simulateExit(mk([[600, 102, 102.1, 101.9, 102], [601, 101, 101.2, 100.4, 100.5]]), 0, -1, 102.764, 100.472, 660, 'trade')
  assert.equal(e.reason, 'target'); assert.equal(e.price, 100.472)
})

test('Strategy F: F-B hammer after two red candles below the OR low, reward check, one-candle validity', async () => {
  const { buildSetup, ordersFB } = await import('../scripts/backtest/rulebook/strategy-f')
  const after = []
  // 9:45 and 9:50 red 5-minute candles, 9:55 hammer with low 97 below the OR low 98
  for (let m = 585; m < 595; m += 1) after.push(fb(m, 99.4 - (m - 585) * 0.1, 99.45 - (m - 585) * 0.1, 98.3 - (m - 585) * 0.05, 99.3 - (m - 585) * 0.1))
  after.push(fb(595, 98.4, 98.45, 97, 98.3), fb(596, 98.3, 98.4, 98.2, 98.35), fb(597, 98.35, 98.45, 98.3, 98.4), fb(598, 98.4, 98.45, 98.35, 98.42), fb(599, 98.42, 98.45, 98.4, 98.45))
  const s = buildSetup('X', 0, 'stock', fDay(after), FM, 10, 100, false)
  const orders = ordersFB(s)
  const h = orders.find((o) => o.setup.startsWith('F-B hammer'))
  assert.ok(h, 'hammer order')
  assert.equal(h.from, 600); assert.equal(h.to, 604)
  assert.ok(Math.abs(h.level - 98.46) < 1e-9); assert.ok(Math.abs(h.stop - 96.99) < 1e-9); assert.equal(h.target, 102)
  assert.equal(h.setup, 'F-B hammer') // reward 3.54 >= 1.5 x 1.47
})

test('Strategy F: portfolio - flat $20 risk, max 3 open, SSR blocks shorts, daily -3R stop', async () => {
  const { buildSetup, runLineDay } = await import('../scripts/backtest/rulebook/strategy-f')
  // trade-through of the OR low at 9:50, then stop at 9:52 (loss)
  const loser = () => fDay([fb(590, 98.2, 98.3, 97.9, 98), fb(591, 97.5, 97.6, 97, 97.1)])
  const spec = { id: 't', variant: 'F-A', sizing: 'flat', mode: 'trade' }
  const st = { equity: 2000, trades: [], skips: {}, equityByDay: [] }
  const setups = ['A', 'B', 'C', 'D'].map((sym, i) => buildSetup(sym, i, 'stock', loser(), FM, 10, 100, false))
  runLineDay(spec, st, '2026-05-04', setups)
  assert.equal(st.trades.length, 3) // D finds all 3 slots busy at 9:50; after the stops (-3R) the daily stop ends the day
  assert.ok(st.trades.every((t) => Math.abs(t.riskDollars - 20) < 1)) // flat $20 (rounded shares)
  assert.ok(st.trades.every((t) => t.r < -1)) // stop slippage + fees
  assert.equal(st.skips['daily stop -3R reached (days)'], 1)
  // SSR: a short setup on a stock that fell 10% below the prior close
  const green = fDay().map((b) => ({ ...b, o: 200 - b.c, c: 200 - b.o, h: 200 - b.l, l: 200 - b.h }))
  const st2 = { equity: 2000, trades: [], skips: {}, equityByDay: [] }
  const short = buildSetup('S', 0, 'stock', green.map((b) => (Math.round((b.t - FM) / 60_000) === 590 ? { ...b, h: 102.2, l: 101.8 } : b)), FM, 10, 120, false)
  assert.equal(short.dir, -1); assert.ok(short.ssrMinute != null)
  runLineDay(spec, st2, '2026-05-04', [short])
  assert.equal(st2.trades.length, 0); assert.equal(st2.skips['short skipped: SSR'], 1)
})

test('Strategy F: FVG detector (Jose definition) and confluence distance', async () => {
  const { findGaps, fvgConfluence } = await import('../scripts/backtest/rulebook/strategy-f')
  const mk = (list) => list.map(([m, o, h, l, c]) => ({ ...fb(m, o, h, l, c), m }))
  // three green 5-minute candles 8:00, 8:05, 8:10: first high 10.2, third low 10.5 -> bullish gap [10.2, 10.5]
  const pre = mk([[480, 10, 10.2, 9.9, 10.1], [485, 10.2, 10.6, 10.2, 10.55], [490, 10.6, 10.9, 10.5, 10.8], [600, 10.8, 10.9, 10.6, 10.7]])
  const gaps = findGaps(pre)
  assert.equal(gaps.length, 1); assert.equal(gaps[0].dir, 1); assert.equal(gaps[0].low, 10.2); assert.equal(gaps[0].high, 10.5); assert.equal(gaps[0].closedAt, null)
  assert.equal(fvgConfluence(gaps, 1, 610, 10.6, 1).fvg, true) // 0.10 from the top edge <= 0.25 x ATR 1
  assert.equal(fvgConfluence(gaps, 1, 610, 10.9, 1).fvg, false) // 0.40 away
  assert.equal(fvgConfluence(gaps, -1, 610, 10.4, 1).fvg, false) // wrong direction
  const closed = findGaps(mk([[480, 10, 10.2, 9.9, 10.1], [485, 10.2, 10.6, 10.2, 10.55], [490, 10.6, 10.9, 10.5, 10.8], [500, 10.4, 10.4, 10.15, 10.3]]))
  assert.equal(closed[0].closedAt, 500)
  assert.equal(fvgConfluence(closed, 1, 610, 10.3, 1).fvg, false)
  // a red candle among the three -> no gap
  assert.equal(findGaps(mk([[480, 10, 10.2, 9.9, 10.1], [485, 10.6, 10.6, 10.2, 10.3], [490, 10.6, 10.9, 10.5, 10.8]])).length, 0)
})

test('Strategy F: daily context in today\'s price terms across a split; diagnostic', async () => {
  const { dayContext, diagnose, emptyDiag, buildSetup } = await import('../scripts/backtest/rulebook/strategy-f')
  // 2:1 split on day 3: adjusted rows are already halved; raw rows show 200 before, 100 after
  const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']
  const adjRows = days.map((day) => ({ day, o: 100, h: 102, l: 98, c: 100, v: 1 }))
  const rawRows = days.map((day, i) => (i < 2 ? { day, o: 200, h: 204, l: 196, c: 200, v: 1 } : { day, o: 100, h: 102, l: 98, c: 100, v: 1 }))
  const adjAtr = [4, 4, 4, 4]
  assert.deepEqual(dayContext(adjRows, adjAtr, rawRows, '2026-01-02'), { atr: 8, prevClose: 200, ssrCarry: false }) // pre-split day: raw scale
  assert.deepEqual(dayContext(adjRows, adjAtr, rawRows, '2026-01-03'), { atr: 4, prevClose: 100, ssrCarry: false }) // split day: no fake -50%
  const d = emptyDiag()
  diagnose(buildSetup('X', 0, 'stock', fDay([fb(590, 98.2, 98.3, 97.9, 98), fb(600, 99, 99.6, 98.9, 99.5)]), FM, 10, 100, false), d)
  assert.deepEqual(d, { days: 1, liquid: 1, doji: 0, back: 1, target: 1, stop: 0, neither: 0 })
})
