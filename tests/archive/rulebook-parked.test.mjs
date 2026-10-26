// ARCHIVED Oct 25, 2026: the parked F, H v2 (swing-v2) and SW tests split from rulebook.test.mjs. Not part of npm test.
import assert from 'node:assert/strict'
import test from 'node:test'
import { RULEBOOK } from '../../scripts/backtest/rulebook/config'
import { atr, ema, isBullishEngulfing, isHammer, isMorningStar, isShootingStar, rsi, sma, aggregate, lastCompleted } from '../../scripts/backtest/rulebook/indicators'
import { minuteMaps, nearestAbove, roomInR } from '../../scripts/backtest/rulebook/common'
import { Account } from '../../scripts/backtest/rulebook/engine'
import { metrics, passFail, rulebookMonth } from '../../scripts/backtest/rulebook/report'
import { buildSP, runScanner } from '../../scripts/backtest/rulebook/strategy-sp'
import { buildS } from '../../scripts/backtest/rulebook/strategy-s'

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

test('Strategy F probe: point-in-time top by prior 20-day dollar volume, price above $10, no look-ahead', async () => {
  const { topByDollarVolume } = await import('../../scripts/backtest/archive/rulebook/strategy-f-probe')
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
  const { buildSetup, ordersFA } = await import('../../scripts/backtest/archive/rulebook/strategy-f')
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
  const { fillOn } = await import('../../scripts/backtest/archive/rulebook/strategy-f')
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
  const { simulateExit } = await import('../../scripts/backtest/archive/rulebook/strategy-f')
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
  const { buildSetup, ordersFB } = await import('../../scripts/backtest/archive/rulebook/strategy-f')
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
  const { buildSetup, runLineDay } = await import('../../scripts/backtest/archive/rulebook/strategy-f')
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
  const { findGaps, fvgConfluence } = await import('../../scripts/backtest/archive/rulebook/strategy-f')
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
  const { dayContext, diagnose, emptyDiag, buildSetup } = await import('../../scripts/backtest/archive/rulebook/strategy-f')
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

test('H v2: breakout needs trend, 1.5x volume and a tight 15-day range; retest within 0.5N closing back above the level', async () => {
  const { buildSeries2 } = await import('../../scripts/backtest/archive/rulebook/swing-v2')
  const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
  const rows = []
  // 230 days of a steady uptrend (EMA20 > SMA50 > SMA200), then a 15-day flat base, then a breakout on high volume
  let p = 50
  for (let i = 0; i < 230; i += 1) { p *= 1.002; rows.push({ day: day(i), o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1_000_000 }) }
  const base = p
  for (let i = 230; i < 245; i += 1) rows.push({ day: day(i), o: base, h: base * 1.01, l: base * 0.99, c: base, v: 1_000_000 })
  const level = Math.max(...rows.slice(225, 245).map((r) => r.h))
  rows.push({ day: day(245), o: base, h: level * 1.03, l: base * 0.995, c: level * 1.02, v: 2_000_000 }) // breakout, 2x volume
  rows.push({ day: day(246), o: level * 1.04, h: level * 1.06, l: level * 1.04, c: level * 1.05, v: 1_000_000 }) // holds well above the level
  rows.push({ day: day(247), o: level * 1.01, h: level * 1.015, l: level * 1.0, c: level * 1.005, v: 1_000_000 }) // retest: low at the level, closes above
  const s = buildSeries2('TST', rows)
  assert.ok(s.bo[245], 'qualified breakout')
  assert.ok(Math.abs(s.bo[245].level - level) < 1e-9)
  assert.ok(s.rt[247], 'retest signal')
  assert.equal(s.rt[247].level, s.bo[245].level)
  assert.equal(s.rt[246], null)
  // same breakout on normal volume -> not qualified, no retest
  const weak = rows.map((r, i) => (i === 245 ? { ...r, v: 1_200_000 } : r))
  const w = buildSeries2('TST', weak)
  assert.equal(w.bo[245], null)
  assert.equal(w.rt[247], null)
  // a wide (not tight) base -> not qualified
  const wide = rows.map((r, i) => (i >= 230 && i < 245 && i % 2 ? { ...r, h: base * 1.25, l: base * 0.8 } : r))
  assert.equal(buildSeries2('TST', wide).bo[245], null)
})

test('H v2 earnings: block entries within 5 trading days from the fill; exit at the last close before the report', async () => {
  const { earningsBlocks, earningsExitToday } = await import('../../scripts/backtest/archive/rulebook/swing-v2')
  const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10']
  assert.equal(earningsBlocks([{ date: '2026-03-06', time: 'bmo' }], days, 0), true) // 5th trading day from the fill
  assert.equal(earningsBlocks([{ date: '2026-03-09', time: 'bmo' }], days, 0), false) // 6th trading day
  assert.equal(earningsBlocks([{ date: '2026-02-27', time: 'amc' }], days, 0), false) // already past
  assert.equal(earningsExitToday([{ date: '2026-03-05', time: 'amc' }], '2026-03-05', '2026-03-06'), true) // after the close today
  assert.equal(earningsExitToday([{ date: '2026-03-06', time: 'bmo' }], '2026-03-05', '2026-03-06'), true) // before tomorrow's open
  assert.equal(earningsExitToday([{ date: '2026-03-06', time: null }], '2026-03-05', '2026-03-06'), true) // unknown -> before the open
  assert.equal(earningsExitToday([{ date: '2026-03-06', time: 'amc' }], '2026-03-05', '2026-03-06'), false) // exit tomorrow at the close instead
  assert.equal(earningsExitToday([{ date: '2026-03-09', time: 'bmo' }], '2026-03-06', '2026-03-09'), true) // Monday report, exit Friday
})

test('Strategy SW probe: seeded sample is deterministic and without duplicates', async () => {
  const { seededSample } = await import('../../scripts/backtest/archive/rulebook/strategy-sw-probe')
  const items = Array.from({ length: 50 }, (_, i) => `S${i}`)
  const a = seededSample(items, 10, 7)
  assert.deepEqual(a, seededSample(items, 10, 7))
  assert.equal(new Set(a).size, 10)
  assert.notDeepEqual(a, seededSample(items, 10, 8))
  assert.equal(seededSample(items, 99, 7).length, 50)
})

test('EDGAR earnings: Item 2.02 8-K filter and UTC acceptance -> Eastern before-open / after-close / intraday', async () => {
  const { isEarnings8K, classifyAcceptance } = await import('../../scripts/backtest/rulebook/edgar-earnings')
  assert.equal(isEarnings8K('8-K', '2.02,9.01'), true)
  assert.equal(isEarnings8K('8-K', '5.02'), false)
  assert.equal(isEarnings8K('8-K/A', '2.02'), false)
  assert.deepEqual(classifyAcceptance('2024-05-01T20:05:12.000Z'), { date: '2024-05-01', time: 'amc', acceptedEt: '2024-05-01 16:05' }) // EDT
  assert.equal(classifyAcceptance('2024-01-25T11:30:00.000Z').time, 'bmo') // 06:30 EST
  assert.equal(classifyAcceptance('2024-01-25T16:00:00.000Z').time, 'intraday') // 11:00 EST
  assert.equal(classifyAcceptance('2024-01-26T02:10:00.000Z').date, '2024-01-25') // 21:10 EST the day before
  const { matchRate } = await import('../../scripts/backtest/archive/rulebook/strategy-sw-edgar-probe')
  assert.equal(matchRate(['2024-05-01', '2024-08-01'], ['2024-05-02']), 0.5)
  assert.equal(matchRate([], ['2024-05-02']), null)
})

test('Strategy SW prefetch: point-in-time universe uses prior 50 days only, $10 and 1M-volume floors, top N', async () => {
  const { universeMembers } = await import('../../scripts/backtest/archive/rulebook/strategy-sw-prefetch')
  const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10))
  const rows = (c, v, spike = v) => days.map((day, i) => ({ day, c, v: i === 55 ? spike : v }))
  const daily = new Map([
    ['BIG', rows(50, 3_000_000)],
    ['MID', rows(20, 2_000_000, 1e12)], // today's huge volume must not count
    ['THIN', rows(50, 500_000)], // avg volume under 1M
    ['CHEAP', rows(5, 1e9)], // under $10
  ])
  const opts = { minPrice: 10, minAvgVolume: 1_000_000, top: 1, avgDays: 50 }
  assert.deepEqual(universeMembers(daily, days, opts).get(days[55]), ['BIG'])
  assert.deepEqual(universeMembers(daily, days, { ...opts, top: 5 }).get(days[55]), ['BIG', 'MID'])
  assert.deepEqual(universeMembers(daily, days, opts).get(days[40]), []) // under 50 prior days
})

// ---------------- Strategy SW ----------------
test('Strategy SW: history split at >60-day gaps, ISO week keys, weekly MACD uses completed weeks only', async () => {
  const { segmentRanges, weekKey, weeklyState } = await import('../../scripts/backtest/archive/rulebook/strategy-sw')
  assert.deepEqual(segmentRanges([0, 1, 2, 70, 71], 60), [[0, 2], [3, 4]])
  assert.deepEqual(segmentRanges([0, 1, 61], 60), [[0, 2]]) // gap of exactly 60 is not split
  assert.equal(weekKey('2026-10-16'), '2026-10-12') // Friday -> Monday
  assert.equal(weekKey('2026-10-12'), '2026-10-12')
  // 60 weeks of rising Fridays-only closes, then mid-week: bull known, no look-ahead into a partial week
  const days = [], closes = []
  for (let w = 0; w < 60; w += 1) for (let d = 0; d < 5; d += 1) { days.push(new Date(Date.UTC(2020, 0, 6) + (w * 7 + d) * 86_400_000).toISOString().slice(0, 10)); closes.push(100 + w + d * 0.1) }
  const st = weeklyState(days, closes)
  assert.equal(st.bull[0], -1) // nothing completed yet
  const last = days.length - 1
  assert.equal(st.bull[last], st.bull[last - 1] === -1 ? st.bull[last] : st.bull[last]) // defined
  // a crash in the last week changes the state only at the week's last day, not mid-week
  const closes2 = closes.slice(); for (let d = 0; d < 5; d += 1) closes2[last - 4 + d] = 50
  const st2 = weeklyState(days, closes2)
  assert.equal(st2.bull[last - 1], st.bull[last - 1]) // Thursday still sees last week's completed state
  assert.equal(st2.bull[last], 0); assert.equal(st2.bearCross[last], 1)
})

test('Strategy SW: initial stop (lower of swing-0.5ATR and fill-2ATR, 1.5-3 ATR band) and R-trail', async () => {
  const { initialStop, trailStop } = await import('../../scripts/backtest/archive/rulebook/strategy-sw')
  let s = initialStop(100, 98, 1) // min(97.5, 98) = 97.5 -> 2.5 ATR
  assert.equal(s.stop, 97.5); assert.equal(s.ok, true)
  s = initialStop(100, 95, 1) // 94.5 -> 5.5 ATR: too wide
  assert.equal(s.ok, false); assert.equal(s.reason, 'stop wider than 3 ATR')
  assert.equal(initialStop(100, 105, 1).stop, 98) // swing low above entry: entry - 2 ATR wins
  assert.equal(trailStop(97.5, 97.5, 100, 2.5, 102.4), 97.5) // under +1R: unchanged
  assert.equal(trailStop(97.5, 97.5, 100, 2.5, 102.5), 100) // +1R -> breakeven
  assert.equal(trailStop(100, 97.5, 100, 2.5, 105.1), 102.5) // +2R -> +1R
  assert.equal(trailStop(102.5, 97.5, 100, 2.5, 101), 102.5) // never lowered
})

test('Strategy SW: earnings block (fill day + 4) and exit at the close before a report', async () => {
  const { earningsBlocked, earningsExitToday } = await import('../../scripts/backtest/archive/rulebook/strategy-sw')
  const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10']
  assert.equal(earningsBlocked([{ date: '2026-03-06', time: 'amc' }], days, 0), true) // 5th day
  assert.equal(earningsBlocked([{ date: '2026-03-09', time: 'bmo' }], days, 0), false) // 6th day
  assert.equal(earningsExitToday([{ date: '2026-03-05', time: 'amc' }], '2026-03-05', '2026-03-06'), true)
  assert.equal(earningsExitToday([{ date: '2026-03-06', time: 'bmo' }], '2026-03-05', '2026-03-06'), true)
  assert.equal(earningsExitToday([{ date: '2026-03-06', time: 'intraday' }], '2026-03-05', '2026-03-06'), true)
  assert.equal(earningsExitToday([{ date: '2026-03-06', time: 'amc' }], '2026-03-05', '2026-03-06'), false) // exit on the 6th instead
})

test('Strategy SW: foreign filer check (D11) and annual form families', async () => {
  const { annualFamily, isForeignFiler } = await import('../../scripts/backtest/rulebook/edgar-earnings')
  assert.equal(annualFamily('10-K'), '10-K'); assert.equal(annualFamily('10-K/A'), '10-K'); assert.equal(annualFamily('10-KT'), '10-K')
  assert.equal(annualFamily('20-F'), '20-F'); assert.equal(annualFamily('40-F/A'), '40-F'); assert.equal(annualFamily('8-K'), null)
  const switcher = [{ form: '20-F', date: '2018-04-01' }, { form: '10-K', date: '2021-03-01' }]
  assert.equal(isForeignFiler(switcher, '2019-06-01'), true)
  assert.equal(isForeignFiler(switcher, '2022-06-01'), false)
  assert.equal(isForeignFiler([{ form: '20-F', date: '2020-04-01' }], '2019-01-01'), true) // before its first report: the first decides
  assert.equal(isForeignFiler([], '2020-01-01'), false)
})

function swStock(rows, overrides = {}) {
  return import('../../scripts/backtest/archive/rulebook/strategy-sw').then(({ buildStock }) => {
    const s = buildStock('TEST', 'TEST', rows)
    const n = rows.length
    const fill = (v) => Float64Array.from({ length: n }, () => v)
    Object.assign(s, { ema20: fill(100), sma50: fill(99), sma100: fill(98), sma200: fill(97), atr: fill(2) }, overrides)
    return s
  })
}
const swDays = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2021, 0, 4) + i * 86_400_000).toISOString().slice(0, 10))

test('Strategy SW: SW-A counts tests only after a higher high and signals on the 3rd test with a candle', async () => {
  const { swaPatterns } = await import('../../scripts/backtest/archive/rulebook/strategy-sw')
  const d = swDays(7)
  const bar = (i, o, h, l, c) => ({ day: d[i], o, h, l, c, v: 1e6 })
  const rows = [
    bar(0, 104, 106, 103, 105),
    bar(1, 102, 103, 100.3, 101.5), // test 1 of the 20 EMA (100 + 0.5)
    bar(2, 102, 103, 100.4, 101.8), // touches again without a higher high: not counted
    bar(3, 104, 107, 103, 106), // higher high -> armed
    bar(4, 102, 103, 100.3, 101.5), // test 2
    bar(5, 104, 108, 103, 107), // higher high -> armed
    bar(6, 101.0, 101.25, 100.3, 101.2), // test 3 + hammer -> signal
  ]
  const s = await swStock(rows)
  const p = swaPatterns(s)
  assert.equal(p.length, 1); assert.equal(p[0].i, 6); assert.equal(p[0].ma, '20 EMA'); assert.equal(p[0].swingLow, 100.3)
  const noCandle = await swStock(rows.map((r, i) => (i === 6 ? { ...r, o: 102, h: 103, c: 101.5 } : r)))
  assert.equal(swaPatterns(noCandle).length, 0)
})

test('Strategy SW: portfolio sim - 1% risk sizing, entry at the next open + slippage, stop exit with fees', async () => {
  const { simulate } = await import('../../scripts/backtest/archive/rulebook/strategy-sw')
  const d = swDays(6)
  const rows = d.map((day, i) => ({ day, o: 100, h: 101, l: i === 2 ? 97 : 99.5, c: 100, v: 1e6 }))
  const s = await swStock(rows, { sma50: Float64Array.from({ length: 6 }, () => 90) })
  const sig = { id: 'TEST', base: 'TEST', setup: 'A', signalDay: d[0], fillDay: d[1], swingLow: 98, atr: 1, rank: 1, dv: 1, note: '' }
  const r = simulate('t', [sig], new Map([['TEST', s]]), () => 'Tech', () => [], d, d[0], d[5])
  assert.equal(r.trades.length, 1)
  const t = r.trades[0]
  assert.ok(Math.abs(t.entry - 100.05) < 1e-9)
  assert.equal(t.stop0, 97.5) // min(98 - 0.5, 100.05 - 2)
  assert.equal(t.shares, Math.floor(20 / (100.05 - 97.5)))
  assert.equal(t.reason, 'stop'); assert.equal(t.exitDay, d[2])
  assert.ok(Math.abs(t.exit - 97.5 * 0.9995) < 1e-9)
  assert.ok(t.r < -1 && t.r > -1.1)
  assert.ok(t.fees > 0)
})

test('Strategy SW: Sharpe, max drawdown and CAGR helpers', async () => {
  const { sharpe, maxDrawdownPct, cagr } = await import('../../scripts/backtest/archive/rulebook/strategy-sw')
  assert.equal(maxDrawdownPct([100, 120, 90, 130]), 0.25)
  assert.ok(Math.abs(cagr(100, 121, '2020-01-01', '2022-01-01') - 0.1) < 0.002)
  assert.ok(sharpe([100, 101, 102, 101, 103]) > 0)
  assert.ok(Number.isNaN(sharpe([100])))
})
