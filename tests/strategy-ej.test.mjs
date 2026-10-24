import assert from 'node:assert/strict'
import test from 'node:test'
import { EJ, rvol5Above, simulateTrade, vwapAt } from '../scripts/backtest/ej-engine'
import { SCAN_MINUTES, passCheck } from '../scripts/backtest/strategy-ej'

const MIDNIGHT = Date.parse('2026-05-04T00:00:00-04:00')
const at = (minute) => MIDNIGHT + minute * 60_000
const bar = (minute, o, h, l, c, v = 1000) => ({ t: at(minute), o, h, l, c, v, vw: c })

function day(bars) {
  const cumVolume = []
  const cumPriceVolume = []
  let v = 0, pv = 0
  for (const b of bars) { v += b.v; pv += b.vw * b.v; cumVolume.push(v); cumPriceVolume.push(pv) }
  return { symbol: 'TEST', name: 'Test', prevClose: 8, atr: 1, float: 5e6, bars, cumVolume, cumPriceVolume, elliottBars: [], baselineSessions: null, news: [] }
}
const entry = (o = {}) => ({ day: '2026-05-04', symbol: 'TEST', minute: 600, fillIndex: 0, fill: 10, shares: 9, stop: 9, atr: 1, rank: 1, regime: 'opening-momentum', entryIndex: 1, ...o })
const flat = (from, n, price = 10, v = 1000) => Array.from({ length: n }, (_, k) => bar(from + k, price, price + 0.05, price - 0.05, price, v))

test('E-current: stop at fill - 1 ATR with slippage', () => {
  const d = day([bar(600, 10, 10.1, 9.95, 10), bar(601, 9.8, 9.9, 8.9, 9)])
  const r = simulateTrade('E', d, MIDNIGHT, entry(), 955)
  assert.equal(r.exitReason, 'stop')
  assert.ok(Math.abs(r.fills.at(-1).price - 9 * (1 - EJ.slippage)) < 1e-9)
  assert.ok(r.r < -1 && r.r > -1.1)
})

test('E-current: target at fill + 1.5 ATR needs a trade-through, not on the entry bar', () => {
  const d = day([bar(600, 10, 11.6, 9.95, 10.2), bar(601, 10.2, 11.5, 10.1, 11.4), bar(602, 11.4, 11.52, 11.3, 11.5)])
  const r = simulateTrade('E', d, MIDNIGHT, entry(), 955)
  assert.equal(r.exitReason, 'target')
  assert.equal(r.fills.at(-1).t, at(602))
  assert.equal(r.fills.at(-1).price, 11.5)
})

test('worst case: stop and target in the same bar -> stop', () => {
  const d = day([bar(600, 10, 10.1, 9.95, 10), bar(601, 10, 11.6, 8.9, 10)])
  assert.equal(simulateTrade('E', d, MIDNIGHT, entry(), 955).exitReason, 'stop')
})

test('E-J: scale-out 1 of a third at +$0.50, then the rest stops at breakeven', () => {
  const d = day([bar(600, 10, 10.1, 9.95, 10), bar(601, 10.2, 10.55, 10.1, 10.4), bar(602, 10.3, 10.35, 9.9, 9.95)])
  const r = simulateTrade('EJ', d, MIDNIGHT, entry(), 930)
  assert.deepEqual(r.fills.filter((f) => f.side === 'sell').map((f) => [f.shares, f.why]), [[3, 'scale-out 1'], [6, 'breakeven stop']])
  assert.equal(r.fills[1].price, 10.5)
  assert.ok(Math.abs(r.fills[2].price - 10 * (1 - EJ.slippage)) < 1e-9)
  assert.ok(r.so1 && !r.so2)
})

test('E-J: thirds by floor; fewer than 3 shares -> 1 share per scale-out', () => {
  const d = day([bar(600, 10, 10.1, 9.95, 10), bar(601, 10.2, 11.1, 10.1, 11), bar(602, 11, 11.05, 10.95, 11)])
  const r = simulateTrade('EJ', d, MIDNIGHT, entry({ shares: 2 }), 930)
  assert.deepEqual(r.fills.filter((f) => f.side === 'sell').map((f) => [f.shares, f.why]), [[1, 'scale-out 1'], [1, 'scale-out 2']])
})

test('E-J runner: a 5-minute close below VWAP exits at the next 1-minute open', () => {
  const bars = [...flat(590, 10, 10, 5000), bar(600, 10, 10.1, 9.95, 10), bar(601, 10.2, 11.1, 10.1, 11), bar(602, 11, 11, 10.9, 10.95), bar(603, 10.9, 10.9, 10.5, 10.6), bar(604, 10.4, 10.4, 10.2, 9.99), bar(605, 9.98, 10, 9.9, 9.95)]
  const d = day(bars)
  const r = simulateTrade('EJ', d, MIDNIGHT, entry({ fillIndex: 10 }), 930)
  assert.equal(r.exitReason, 'runner: 5-min close below VWAP')
  assert.equal(r.fills.at(-1).t, at(605))
  assert.ok(vwapAt(d, 14) > 9.99)
})

test('E-J: everything is flat at 15:30, at that bar open', () => {
  const d = day([bar(925, 10, 10.1, 9.95, 10), bar(929, 10, 10.2, 9.95, 10.1), bar(930, 10.1, 10.2, 10, 10.1)])
  const r = simulateTrade('EJ', d, MIDNIGHT, entry({ minute: 925 }), 930)
  assert.equal(r.exitReason, 'flat 15:30')
  assert.equal(r.exitT, at(930))
  assert.ok(Math.abs(r.fills.at(-1).price - 10.1 * (1 - EJ.slippage)) < 1e-9)
})

test('rvol5Above: last 5-minute bar vs the average of the previous 12', () => {
  const bars = flat(570, 65, 10, 100) // 13 five-minute bars of 500
  assert.equal(rvol5Above(bars, 64, MIDNIGHT), false) // equal, not above
  const spike = [...flat(570, 60, 10, 100), ...flat(630, 5, 10, 200)]
  assert.equal(rvol5Above(spike, 64, MIDNIGHT), true)
  assert.equal(rvol5Above(spike, 63, MIDNIGHT), false) // the 630 bar is not complete yet; 625 vs 12 earlier needs 13 bars
})

test('E-J add: after scale-out 2, new high, close above VWAP and rising volume -> add within the 1R cap', () => {
  const bars = [bar(570, 10, 10.05, 9.95, 10, 100), ...flat(571, 64, 10, 100),
    bar(635, 10, 10.6, 9.98, 10.5, 100), bar(636, 10.5, 11.1, 10.45, 11, 100), bar(637, 11, 11.15, 10.95, 11.1, 100),
    bar(638, 11.1, 11.2, 11.05, 11.15, 100), bar(639, 11.15, 11.3, 11.1, 11.2, 30_000), bar(640, 11.2, 11.25, 11.15, 11.2, 10_000), bar(641, 11.2, 11.25, 11.15, 11.2, 10_000)]
  const r = simulateTrade('EJ', day(bars), MIDNIGHT, entry({ minute: 570 }), 930)
  const add = r.fills.find((f) => f.why === 'add 1')
  assert.ok(add, 'add 1 fired')
  assert.equal(add.t, at(640))
  assert.equal(add.shares, 3)
  assert.equal(r.adds, 1)
  const none = simulateTrade('EJ-noadd', day(bars), MIDNIGHT, entry({ minute: 570 }), 930)
  assert.equal(none.adds, 0)
})

test('scan times and the holdout pass rule', () => {
  assert.deepEqual(SCAN_MINUTES.slice(0, 6), [420, 435, 450, 465, 480, 485])
  assert.equal(SCAN_MINUTES.at(-1), 655)
  const t = (r, pnl) => ({ r, pnl })
  const ej = [...Array(20).fill(t(1, 10)), ...Array(12).fill(t(-1, -10))]
  const ec = Array(32).fill(t(0, 0))
  assert.equal(passCheck(ej, ec).pass, true)
  assert.equal(passCheck(ej.slice(0, 29), ec).pass, false) // under 30 trades
})
