import assert from 'node:assert/strict'
import test from 'node:test'
import { entryMinute, failingGates, featuresAt, median, parseCsv, parseMinute, parsePnl, parsePrice, q5Qualifies, scanMinuteFor } from '../scripts/backtest/ross-audit'

const MIDNIGHT = Date.parse('2026-05-04T00:00:00-04:00')
const at = (minute) => MIDNIGHT + minute * 60_000
const bar = (minute, o, h, l, c, v = 1000) => ({ t: at(minute), o, h, l, c, v, vw: c })

test('parseCsv: quoted fields, commas and doubled quotes inside quotes', () => {
  const rows = parseCsv('a,b,c\n1,"x, y","he said ""hi"""\n2,,\n')
  assert.deepEqual(rows, [{ a: '1', b: 'x, y', c: 'he said "hi"' }, { a: '2', b: '', c: '' }])
})

test('parseMinute / parsePrice / parsePnl read Ross rows', () => {
  assert.equal(parseMinute('~07:05 (break of VWAP)'), 425)
  assert.equal(parseMinute('just after 07:00 (red-to-green)'), 420)
  assert.equal(parseMinute('premarket (micro pullback)'), null)
  assert.equal(parsePrice('~3.00 (12000 sh; stop 2.95)'), 3)
  assert.equal(parsePrice('12.72; add 13'), 12.72)
  assert.equal(parsePrice(''), null)
  assert.equal(parsePnl('-17372.37'), -17372.37)
  assert.equal(parsePnl('~7600'), 7600)
  assert.equal(parsePnl('positive (amount not stated)'), null)
})

test('entryMinute: stated time wins; else first bar whose range holds the stated price (04:00-11:00)', () => {
  const bars = [bar(230, 2, 2.1, 1.9, 2), bar(400, 3, 3.2, 2.9, 3.1), bar(401, 3.1, 3.6, 3.1, 3.5)]
  assert.deepEqual(entryMinute(bars, MIDNIGHT, '~07:30', '3.5'), { minute: 450, how: 'stated time' })
  assert.deepEqual(entryMinute(bars, MIDNIGHT, 'premarket', '3.5'), { minute: 401, how: 'first touch of stated price' })
  assert.equal(entryMinute(bars, MIDNIGHT, 'premarket', '2.0').minute, null, 'bars before 04:00 are ignored')
  assert.equal(entryMinute(bars, MIDNIGHT, 'premarket', '').how, 'no time or price stated')
})

test('scanMinuteFor: before 07:00 maps to 07:00, 07:00-08:00 every 15 min, then every 5 min, none from 11:00', () => {
  assert.equal(scanMinuteFor(400).scan, 420)
  assert.equal(scanMinuteFor(430).scan, 420)
  assert.equal(scanMinuteFor(437).scan, 435)
  assert.equal(scanMinuteFor(483).scan, 480)
  assert.equal(scanMinuteFor(487).scan, 485)
  assert.equal(scanMinuteFor(660).scan, null)
})

test('featuresAt: gain, first-5-minute volume, halt-like gaps and premarket-high break', () => {
  const bars = [bar(420, 4, 4.5, 4, 4.4, 100), bar(425, 4.4, 4.6, 4.3, 4.5, 100), bar(430, 4.5, 4.9, 4.5, 4.8, 100),
    bar(570, 5, 5.2, 5, 5.1, 300), bar(571, 5.1, 5.3, 5, 5.2, 300), bar(580, 5.2, 6, 5.2, 5.9, 500), bar(581, 5.9, 6, 5.8, 5.9, 500)]
  const pre = featuresAt(bars, MIDNIGHT, 4, 431)
  assert.ok(Math.abs(pre.gainPct - 20) < 1e-9)
  assert.equal(pre.pmHighBreak, true, '4.8 > earlier premarket highs 4.5 and 4.6')
  const rth = featuresAt(bars, MIDNIGHT, 4, 590)
  assert.equal(rth.first5Volume, 600)
  assert.equal(rth.haltGaps, 1, '571 -> 580 is a 9-minute gap')
  assert.equal(rth.pmHighBreak, null, 'only judged for premarket entries')
})

test('q5Qualifies: high >= +50% and >= 10M shares from 04:00 to before 10:00', () => {
  const ok = [{ t: at(300), h: 3, v: 6e6 }, { t: at(590), h: 3.2, v: 4e6 }]
  assert.equal(q5Qualifies(ok, MIDNIGHT, 2), true)
  assert.equal(q5Qualifies([...ok.slice(0, 1), { t: at(600), h: 3.2, v: 4e6 }], MIDNIGHT, 2), false, 'the 10:00 bar does not count')
  assert.equal(q5Qualifies(ok, MIDNIGHT, 2.2), false, '3.2 / 2.2 is +45%')
  assert.equal(q5Qualifies(ok, MIDNIGHT, 0), false)
})

test('median', () => {
  assert.equal(median([3, null, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), null)
})

test('failingGates mirrors decideEntry: a clean candidate passes, each broken gate is named', () => {
  const now = new Date('2026-05-04T09:45:00-04:00') // opening-momentum
  const good = { symbol: 'T', price: 5, bid: 4.99, ask: 5.01, volume: 2e6, averageVolume: 2e5, relativeVolume: 10, relativeVolumeReliable: true, float: 3e6, floatSource: 'fmp', changePercent: 25, vwap: 4.5, atr: 0.3, hasNews: true }
  assert.deepEqual(failingGates(good, now, 2000), [])
  assert.ok(failingGates({ ...good, hasNews: false }, now, 2000).includes('no news in the last 24h'))
  assert.ok(failingGates({ ...good, float: 2e7 }, now, 2000).includes('float > 10M'))
  assert.ok(failingGates({ ...good, vwap: 6 }, now, 2000).includes('price not above VWAP'))
  assert.ok(failingGates({ ...good, atr: 30 }, now, 2000).some((g) => g.startsWith('size < 1 share')))
})

test('failingGates is empty exactly when decideEntry enters (random candidates)', async () => {
  const { decideEntry } = await import('../lib/strategy')
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let k = 0; k < 500; k += 1) {
    const price = 1 + rnd() * 20
    const c = { symbol: 'T', price, bid: price * (1 - rnd() * 0.01), ask: price * (1 + rnd() * 0.01), volume: rnd() * 3e6, averageVolume: 1e5 + rnd() * 1e6, relativeVolumeReliable: rnd() > 0.1,
      float: rnd() > 0.2 ? rnd() * 2e7 : undefined, floatSource: 'fmp', changePercent: rnd() * 80 - 5, vwap: price * (0.8 + rnd() * 0.4), atr: rnd() > 0.05 ? rnd() * 1.5 : 0, hasNews: rnd() > 0.3 }
    const now = new Date(Date.parse('2026-05-04T07:00:00-04:00') + Math.floor(rnd() * 240) * 60_000)
    const gates = failingGates(c, now, 2000)
    const d = decideEntry(c, 2000, now, 2000 * 0.75)
    assert.equal(gates.length === 0, d.action === 'enter', JSON.stringify({ gates, d: d.reason, c }))
  }
})
