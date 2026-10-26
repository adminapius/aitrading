// Shared fill and halt models (scripts/backtest/fill-halt-models.ts), kept when the Strategy R runner was archived.
import assert from 'node:assert/strict'
import test from 'node:test'
import { exitOnBar, haltResumes, planEntry, R, sellPrice } from '../scripts/backtest/fill-halt-models'

const MID = Date.parse('2025-03-03T05:00:00Z') // ET midnight (EST)
const at = (h, m) => MID + (h * 60 + m) * 60_000
const bar = (h, m, o, hi, lo, c, v = 10_000, vw = (hi + lo) / 2) => ({ t: at(h, m), o, h: hi, l: lo, c, v, vw })
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('halt model: a 5+ minute regular-hours gap after 5 traded minutes is a halt; pre-market gaps are not', () => {
  const bars = [bar(8, 0, 5, 5, 5, 5), bar(8, 30, 5, 5, 5, 5)]
  for (let m = 40; m <= 44; m += 1) bars.push(bar(9, m, 5, 5, 5, 5))
  bars.push(bar(9, 50, 5, 5, 5, 5)) // 9:45-9:49 missing -> halt
  bars.push(bar(9, 51, 5, 5, 5, 5), bar(9, 55, 5, 5, 5, 5)) // 3 missing minutes: not a halt
  assert.deepEqual([...haltResumes(bars, MID)], [7])
})

test('entry fill model: quote rules, fill price, stop, risk bounds, size and volume caps', () => {
  const br = { i: 5, minute: 425, high: 6.0, low: 5.7, bars: 2, trigger: 6.01 }
  const b = bar(7, 5, 5.8, 6.2, 5.8, 6.15, 400_000, 6.05)
  assert.deepEqual(planEntry(br, b, null, 1e6), { skip: 'no quote within 120 s' })
  assert.equal(planEntry(br, b, { bp: 5.8, ap: 6.2 }, 1e6).skip, 'spread over 3%')
  const p = planEntry(br, b, { bp: 6.0, ap: 6.04 }, 1e6)
  close(p.fill, 6.01 + 0.02 + 0.01)
  close(p.stop, 5.69)
  assert.equal(p.shares, Math.floor(Math.min((R.equity * R.riskPct) / (6.04 - 5.69), (R.equity * R.positionPct) / 6.04)))
  assert.equal(planEntry({ ...br, low: 6.02 }, b, { bp: 6.0, ap: 6.0 }, 1e6).skip, 'risk under $0.02')
  assert.equal(planEntry({ ...br, low: 5.0 }, b, { bp: 6.0, ap: 6.02 }, 1e6).skip, 'risk over 10% of price')
  assert.equal(planEntry(br, b, { bp: 6.0, ap: 6.04 }, 50).skip, 'size under 1 share (volume caps)')
})

test('exit model: stop first, target on a $0.01 trade-through, entry-bar rule, halt resumption', () => {
  const p = { stop: 5.69, target: 6.74 }
  assert.deepEqual(exitOnBar(p, bar(8, 0, 6.0, 6.8, 5.6, 6.0)), { reason: 'stop', base: 5.69 })
  assert.deepEqual(exitOnBar(p, bar(8, 0, 5.5, 5.9, 5.4, 5.8)), { reason: 'stop', base: 5.5 })
  assert.deepEqual(exitOnBar(p, bar(8, 0, 6.5, 6.75, 6.4, 6.7)), { reason: 'target', base: 6.74 })
  assert.equal(exitOnBar(p, bar(8, 0, 6.5, 6.745, 6.4, 6.7)), null)
  assert.equal(exitOnBar(p, bar(8, 0, 6.0, 6.8, 5.6, 5.7), { entryBar: true }), null)
  assert.deepEqual(exitOnBar(p, bar(8, 0, 6.0, 6.8, 5.6, 5.69), { entryBar: true }), { reason: 'stop', base: 5.69 })
  assert.deepEqual(exitOnBar(p, bar(10, 0, 7.0, 7.1, 6.9, 7.0), { resume: true }), { reason: 'target', base: 6.74 })
  assert.deepEqual(exitOnBar(p, bar(10, 0, 5.0, 5.1, 4.9, 5.0), { resume: true }), { reason: 'stop', base: 5.0 })
  assert.equal(sellPrice('target', 6.74, 0.05), 6.74)
  close(sellPrice('stop', 5.69, 0.02), 5.66)
})
