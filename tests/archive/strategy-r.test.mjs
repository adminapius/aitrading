import assert from 'node:assert/strict'
import test from 'node:test'
import { addCoverage, cov, coverageShare, filterAt, findBreaks, haltResumes, planEntry, prefilter, R, tradeRange } from '../../scripts/backtest/archive/strategy-r'

const MID = Date.parse('2025-03-03T05:00:00Z') // ET midnight (EST)
const at = (h, m) => MID + (h * 60 + m) * 60_000
const bar = (h, m, o, hi, lo, c, v = 10_000, vw = (hi + lo) / 2) => ({ t: at(h, m), o, h: hi, l: lo, c, v, vw })

test('prefilter: +20% high over the prior close, $2-20 touched, 500k volume, inside the dates', () => {
  const rows = [
    { day: '2025-03-02', o: 1, h: 1, l: 1, c: 5, v: 1e6 },
    { day: '2025-03-03', o: 5, h: 6.1, l: 4.9, c: 6, v: 600_000 }, // +22%: in
    { day: '2025-03-04', o: 6, h: 7.1, l: 6, c: 7, v: 400_000 }, // volume too low
    { day: '2025-03-05', o: 7, h: 30, l: 21, c: 25, v: 9e6 }, // never at or under $20
  ]
  assert.deepEqual(prefilter(rows, '2025-03-01', '2025-03-31'), [{ day: '2025-03-03', prevClose: 5 }])
  assert.deepEqual(prefilter(rows, '2025-03-04', '2025-03-31'), [])
})

test('haltResumes: a 5+ minute gap in regular hours after 5 traded minutes; pre-market gaps are not halts', () => {
  const bars = [bar(8, 0, 5, 5, 5, 5), bar(8, 30, 5, 5, 5, 5)] // pre-market gap
  for (let m = 40; m <= 44; m += 1) bars.push(bar(9, m, 5, 5, 5, 5))
  bars.push(bar(9, 50, 5, 5, 5, 5)) // 9:45-9:49 missing: 5 minutes -> halt
  bars.push(bar(9, 51, 5, 5, 5, 5), bar(9, 55, 5, 5, 5, 5)) // 3 missing minutes: not a halt
  const r = haltResumes(bars, MID)
  assert.deepEqual([...r], [7])
})

// 04:00 base, a run to 6.00 (new high), two pullback bars to 5.70, then a break of 6.01
const setupBars = () => [
  bar(7, 0, 5.0, 5.1, 4.9, 5.0, 100_000, 5.0),
  bar(7, 1, 5.0, 5.6, 5.0, 5.5, 200_000, 5.3),
  bar(7, 2, 5.5, 6.0, 5.5, 5.9, 300_000, 5.8), // new high of day 6.00
  bar(7, 3, 5.9, 5.95, 5.75, 5.8, 50_000, 5.85), // pullback 1
  bar(7, 4, 5.8, 5.85, 5.7, 5.75, 50_000, 5.78), // pullback 2, L = 5.70
  bar(7, 5, 5.8, 6.2, 5.8, 6.15, 400_000, 6.05), // break at 6.01
]

test('findBreaks: new high, 1-5 pullback bars above VWAP within half the move, then H + $0.01', () => {
  const b = findBreaks(setupBars(), MID)
  assert.equal(b.length, 1)
  assert.deepEqual(b[0], { i: 5, minute: 7 * 60 + 5, high: 6.0, low: 5.7, bars: 2, trigger: 6.01 })
})

test('findBreaks: resets on a pullback under VWAP, a deep retrace, a 6th bar, a close below L, or a halt', () => {
  // under VWAP: VWAP is pulled up by heavy volume near the high
  const vwapFail = setupBars(); vwapFail[2] = bar(7, 2, 5.5, 6.0, 5.5, 5.9, 5_000_000, 5.98)
  assert.equal(findBreaks(vwapFail, MID).length, 0)
  // retrace more than half of low (4.90) -> high (6.00): L 5.40
  const deep = setupBars(); deep[4] = bar(7, 4, 5.8, 5.85, 5.4, 5.75, 50_000, 5.6)
  assert.equal(findBreaks(deep, MID).length, 0)
  // six pullback bars before the break
  const slow = setupBars().slice(0, 4)
  for (let m = 4; m <= 8; m += 1) slow.push(bar(7, m, 5.85, 5.9, 5.8, 5.85, 50_000, 5.85))
  slow.push(bar(7, 9, 5.9, 6.2, 5.9, 6.1, 400_000, 6.05))
  assert.equal(findBreaks(slow, MID).length, 0)
  // a close below the pullback low so far
  const closeBelow = setupBars(); closeBelow[4] = bar(7, 4, 5.8, 5.85, 5.7, 5.72, 50_000, 5.78)
  closeBelow.splice(4, 0, bar(7, 3, 5.9, 5.95, 5.75, 5.8, 50_000, 5.85))
  closeBelow[3] = bar(7, 3, 5.9, 5.95, 5.76, 5.8, 50_000, 5.85)
  closeBelow[4] = bar(7, 4, 5.8, 5.85, 5.7, 5.72, 50_000, 5.78) // close 5.72 < L 5.76
  closeBelow.length = 5
  closeBelow.push(bar(7, 5, 5.8, 6.2, 5.8, 6.15, 400_000, 6.05))
  assert.equal(findBreaks(closeBelow, MID).length, 0)
  // a halt cancels the pending buy-stop: the resumption bar cannot be the break
  assert.equal(findBreaks(setupBars(), MID, new Set([5])).length, 0)
})

test('findBreaks: the sequence continues after a break (the break bar is the next high)', () => {
  const bars = setupBars()
  bars.push(bar(7, 6, 6.1, 6.15, 6.05, 6.1, 50_000, 6.1), bar(7, 7, 6.1, 6.3, 6.1, 6.25, 300_000, 6.2))
  const b = findBreaks(bars, MID)
  assert.deepEqual(b.map((x) => [x.i, x.trigger]), [[5, 6.01], [7, 6.21]])
})

test('filterAt: window, price, gain, volume and news, using bars closed before the break bar', () => {
  const bars = setupBars()
  let v = 0
  const cumVolume = bars.map((b) => (v += b.v))
  const ctx = { prevClose: 4.5, cumVolume, newsTimes: [at(6, 0)] }
  assert.equal(filterAt(bars, 5, ctx, R.lines.H1, MID), null)
  assert.equal(filterAt(bars, 5, ctx, R.lines.H3, MID), 'outside the entry window')
  assert.equal(filterAt(bars, 5, { ...ctx, prevClose: 5.0 }, R.lines.H1, MID), 'gain under 20%')
  assert.equal(filterAt(bars, 5, { ...ctx, cumVolume: cumVolume.map((x) => x / 10) }, R.lines.H1, MID), 'volume under 500k')
  assert.equal(filterAt(bars, 5, { ...ctx, newsTimes: [at(4, 0)] }, R.lines.H1, MID), 'no news within 120 min')
  assert.equal(filterAt(bars, 5, { ...ctx, newsTimes: [at(7, 5)] }, R.lines.H1, MID), 'no news within 120 min') // not before the bar
  assert.equal(filterAt(bars, 5, { ...ctx, prevClose: 1 }, R.lines.H1, MID), null)
})

test('planEntry: quote rules, fill = max(trigger, open) + half spread + $0.01, stop L - $0.01, risk bounds, size', () => {
  const br = { i: 5, minute: 425, high: 6.0, low: 5.7, bars: 2, trigger: 6.01 }
  const b = bar(7, 5, 5.8, 6.2, 5.8, 6.15, 400_000, 6.05)
  assert.deepEqual(planEntry(br, b, null, 1e6), { skip: 'no quote within 120 s' })
  assert.equal(planEntry(br, b, { bp: 5.8, ap: 6.2 }, 1e6).skip, 'spread over 3%')
  const p = planEntry(br, b, { bp: 6.0, ap: 6.04 }, 1e6)
  assert.ok(Math.abs(p.fill - (6.01 + 0.02 + 0.01)) < 1e-9)
  assert.ok(Math.abs(p.stop - 5.69) < 1e-9)
  assert.equal(p.shares, Math.floor(Math.min(20 / (6.04 - 5.69), 500 / 6.04)))
  assert.equal(planEntry({ ...br, low: 6.02 }, b, { bp: 6.0, ap: 6.0 }, 1e6).skip, 'risk under $0.02')
  assert.equal(planEntry({ ...br, low: 5.0 }, b, { bp: 6.0, ap: 6.02 }, 1e6).skip, 'risk over 10% of price')
  assert.equal(planEntry(br, b, { bp: 6.0, ap: 6.04 }, 50).skip, 'size under 1 share (volume caps)')
})

test('tradeRange: upper = every fill, lower = at most 3 a day', () => {
  assert.deepEqual(tradeRange(new Map([['a', 1], ['b', 5], ['c', 3]])), { upper: 9, lower: 7, capDays: 1 })
})

test('coverage: foreign excluded from the gate base, misses counted by reason', () => {
  const c = cov()
  addCoverage(c, { shares: 3e6, filed: 'x', ageDays: 10, source: 's', filer: 'domestic' }, false)
  addCoverage(c, { shares: 9e6, filed: 'x', ageDays: 10, source: 's', filer: 'domestic' }, true)
  addCoverage(c, { shares: 1e6, filed: 'x', ageDays: 10, source: 's', filer: 'foreign' }, false)
  addCoverage(c, { miss: 'no-cik', filer: 'unknown' }, true)
  assert.deepEqual({ n: c.n, covered: c.covered, under5m: c.under5m, foreign: c.foreign, u1: c.u1, u1Covered: c.u1Covered, miss: c.miss }, { n: 4, covered: 2, under5m: 1, foreign: 1, u1: 2, u1Covered: 1, miss: { 'no-cik': 1 } })
  assert.ok(Math.abs(coverageShare(c) - 2 / 3) < 1e-12)
})
