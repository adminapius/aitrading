import assert from 'node:assert/strict'
import test from 'node:test'
import { exitOnBar, paperPick, sellFees, sellPrice, simulateDay, verdict } from '../scripts/backtest/strategy-r-run'

const DAY = '2025-03-03'
const MID = Date.parse('2025-03-03T05:00:00Z')
const at = (h, m) => MID + (h * 60 + m) * 60_000
const bar = (h, m, o, hi, lo, c, v = 100_000, vw = (hi + lo) / 2) => ({ t: at(h, m), o, h: hi, l: lo, c, v, vw })

test('exitOnBar: stop first, target on a $0.01 trade-through, entry bar stop only on a close at or below', () => {
  const p = { stop: 5.69, target: 6.74 }
  assert.deepEqual(exitOnBar(p, bar(8, 0, 6.0, 6.8, 5.6, 6.0)), { reason: 'stop', base: 5.69 })
  assert.deepEqual(exitOnBar(p, bar(8, 0, 5.5, 5.9, 5.4, 5.8)), { reason: 'stop', base: 5.5 }, 'gap below the stop fills at the open')
  assert.deepEqual(exitOnBar(p, bar(8, 0, 6.5, 6.75, 6.4, 6.7)), { reason: 'target', base: 6.74 })
  assert.equal(exitOnBar(p, bar(8, 0, 6.5, 6.745, 6.4, 6.7)), null, 'touching the target is not a trade-through')
  assert.equal(exitOnBar(p, bar(8, 0, 6.0, 6.8, 5.6, 5.7), { entryBar: true }), null, 'no target on the entry bar; close above the stop')
  assert.deepEqual(exitOnBar(p, bar(8, 0, 6.0, 6.8, 5.6, 5.69), { entryBar: true }), { reason: 'stop', base: 5.69 })
  assert.deepEqual(exitOnBar(p, bar(10, 0, 7.0, 7.1, 6.9, 7.0), { resume: true }), { reason: 'target', base: 6.74 }, 'after a halt: open above the target fills at the target')
  assert.deepEqual(exitOnBar(p, bar(10, 0, 5.0, 5.1, 4.9, 5.0), { resume: true }), { reason: 'stop', base: 5.0 }, 'after a halt: the gap is taken in full')
})

test('sellPrice and fees', () => {
  assert.equal(sellPrice('target', 6.74, 0.05), 6.74)
  assert.ok(Math.abs(sellPrice('stop', 5.69, 0.02) - 5.66) < 1e-9)
  assert.ok(Math.abs(sellFees(10, 100) - (1000 * 20.6e-6 + 100 * 0.000195)) < 1e-12)
})

const trade = (part, r, pnl) => ({ part, r, pnl })
test('verdict: every condition, both parts positive, coverage gate', () => {
  const good = [...Array(25).fill(0).map(() => trade('tuning', 1, 10)), ...Array(10).fill(0).map(() => trade('tuning', -1, -10)), trade('holdout', 2, 20), trade('holdout', -1, -10)]
  const v = verdict(good, true)
  assert.equal(v.all.n, 37)
  assert.equal(v.pass, true)
  assert.equal(verdict(good, false).pass, false, 'coverage under 75% cannot pass')
  const badHoldout = [...good.slice(0, 35), trade('holdout', -1, -10)]
  assert.deepEqual(verdict(badHoldout, true).rules.filter((r) => !r.pass).map((r) => r.rule), [5])
  const few = good.slice(0, 20).concat([trade('holdout', 1, 1)])
  assert.ok(verdict(few, true).rules.find((r) => r.rule === 1).pass === false)
  const thin = [...Array(20).fill(0).map(() => trade('tuning', 1, 10)), ...Array(14).fill(0).map(() => trade('tuning', -1, -10)), trade('holdout', 1, 10), trade('holdout', -1, -10)]
  const t = verdict(thin, true) // expectancy 6/36 = 0.167, PF 21/15 = 1.4 -> not > 1.4
  assert.deepEqual(t.rules.filter((r) => !r.pass).map((r) => r.rule), [3, 5])
})

test('paperPick: R13', () => {
  assert.match(paperPick([]), /none/)
  assert.match(paperPick(['H3']), /^H3/)
  assert.match(paperPick(['H2', 'H1']), /^H1/)
  assert.match(paperPick(['H2', 'H3']), /Jose decides/)
})

// one symbol: entry at the break of 6.01 at 07:05, then the target
const sd = (bars, setupIdx) => ({ symbol: 'ABC', u1: false, bars, cumVolume: bars.map((_, i) => 1e6 * (i + 1)), resumes: new Set(), floatResult: { shares: 1e6, filed: 'x', ageDays: 1, source: 's', filer: 'domestic' }, candidate: true, setups: { H1: setupIdx.map((i) => ({ i, minute: 0, high: 6.0, low: 5.7, bars: 2, trigger: 6.01 })), H2: [], H3: [] } })
const acct = () => ({ equity: 2000, trades: [], skips: {}, peak: 2000, maxDd: 0 })
const q = async () => ({ bp: 6.0, ap: 6.02 })

test('simulateDay: fill, 2R target, fees, R; one entry per symbol', async () => {
  const bars = [bar(7, 4, 5.8, 5.85, 5.7, 5.75), bar(7, 5, 5.9, 6.1, 5.9, 6.05), bar(7, 6, 6.05, 6.7, 6.0, 6.6), bar(7, 7, 6.6, 6.75, 6.5, 6.7), bar(7, 8, 6.7, 6.8, 6.1, 6.2)]
  const a = acct()
  await simulateDay(DAY, [sd(bars, [1, 3])], 'H1', 'base', a, q, {})
  assert.equal(a.trades.length, 1)
  const t = a.trades[0]
  assert.ok(Math.abs(t.fill - 6.03) < 1e-9) // max(6.01, 5.90) + 0.01 half spread + 0.01
  assert.ok(Math.abs(t.stop - 5.69) < 1e-9)
  assert.ok(Math.abs(t.target - (6.03 + 2 * 0.34)) < 1e-9)
  assert.equal(t.reason, 'target')
  assert.equal(t.shares, Math.floor(Math.min(20 / 0.34, 500 / 6.03)))
  assert.ok(Math.abs(t.pnl - (t.shares * (t.target - t.fill) - sellFees(t.target, t.shares))) < 1e-9)
  assert.ok(Math.abs(t.r - t.pnl / (t.shares * 0.34)) < 1e-12)
  assert.ok(Math.abs(a.equity - (2000 + t.pnl)) < 1e-9)
})

test('simulateDay: stop pays half the exit spread + $0.01; flatten at the 15:30 open; no-quote skip vs fill line', async () => {
  const stopBars = [bar(7, 4, 5.8, 5.85, 5.7, 5.75), bar(7, 5, 5.9, 6.1, 5.9, 6.05), bar(7, 6, 6.0, 6.05, 5.6, 5.65)]
  const a = acct()
  await simulateDay(DAY, [sd(stopBars, [1])], 'H1', 'base', a, async () => ({ bp: 5.6, ap: 5.64 }), {})
  assert.equal(a.trades[0].reason, 'stop')
  assert.ok(Math.abs(a.trades[0].exitPrice - (5.69 - 0.02 - 0.01)) < 1e-9)
  const flatBars = [bar(7, 4, 5.8, 5.85, 5.7, 5.75), bar(7, 5, 5.9, 6.1, 5.9, 6.05), bar(15, 30, 6.2, 6.25, 6.15, 6.2)]
  const b = acct()
  await simulateDay(DAY, [sd(flatBars, [1])], 'H1', 'base', b, q, {})
  assert.equal(b.trades[0].reason, 'flatten 15:30')
  assert.ok(Math.abs(b.trades[0].exitPrice - (6.2 - 0.01 - 0.01)) < 1e-9)
  const none = async () => null
  const c = acct()
  await simulateDay(DAY, [sd(flatBars, [1])], 'H1', 'base', c, none, {})
  assert.equal(c.trades.length, 0)
  assert.equal(c.skips['no quote within 120 s'], 1)
  const d = acct()
  await simulateDay(DAY, [sd(flatBars, [1])], 'H1', 'fill-no-quote', d, none, { 'tuning|pre': 0.004 })
  assert.equal(d.trades.length, 1)
  assert.ok(d.trades[0].noQuote)
  assert.ok(Math.abs(d.trades[0].fill - (6.01 + 6.01 * 0.002 + 0.01)) < 1e-9)
  assert.ok(d.trades[0].exitQuoteFallback, 'no exit quote: the entry spread is used')
})

test('simulateDay: at most 3 open positions; the 4% daily loss limit stops new entries', async () => {
  const mk = (sym) => ({ ...sd([bar(7, 4, 5.8, 5.85, 5.7, 5.75), bar(7, 5, 5.9, 6.1, 5.9, 6.05), bar(15, 30, 6.05, 6.1, 6.0, 6.05)], [1]), symbol: sym })
  const a = acct()
  await simulateDay(DAY, ['A', 'B', 'C', 'D'].map(mk), 'H1', 'base', a, q, {})
  assert.equal(a.trades.length, 3)
  assert.equal(a.skips['3 positions open'], 1)
  const loser = (sym, m) => ({ ...sd([bar(7, m - 1, 5.8, 5.85, 5.7, 5.75), bar(7, m, 5.9, 6.1, 5.9, 6.05), bar(7, m + 1, 5.0, 5.0, 4.0, 4.1)], [1]), symbol: sym })
  const b = acct()
  await simulateDay(DAY, [loser('A', 5), loser('B', 10), loser('C', 15), loser('D', 20), loser('E', 25)], 'H1', 'base', b, q, {})
  assert.ok(b.skips['daily loss limit'] >= 1)
  assert.ok(b.trades.reduce((x, t) => x + t.pnl, 0) <= -0.04 * 2000)
})
