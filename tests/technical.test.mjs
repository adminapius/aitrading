import assert from 'node:assert/strict'
import test from 'node:test'
import { bullFlag, emaSeries, indicatorsFor, microPullback, orb5, pmhBreakout, rsiSeries, band20to30 } from '../scripts/backtest/technical'

const MINUTE = 60_000
const MIDNIGHT = Date.parse('2026-06-01T04:00:00Z') // 00:00 ET (EDT)
const at = (minuteOfDay) => MIDNIGHT + minuteOfDay * MINUTE

/** Builds a SymbolDay from [minuteOfDay, open, high, low, close, volume] rows. */
function day(rows, atr = 0.5) {
  const bars = rows.map(([minute, o, h, l, c, v]) => ({ t: at(minute), o, h, l, c, v, vw: (h + l + c) / 3 }))
  const cumVolume = []
  const cumPriceVolume = []
  let volume = 0
  let priceVolume = 0
  for (const bar of bars) {
    volume += bar.v
    priceVolume += bar.vw * bar.v
    cumVolume.push(volume)
    cumPriceVolume.push(priceVolume)
  }
  return { symbol: 'TEST', name: '', prevClose: 4, atr, float: 5e6, bars, cumVolume, cumPriceVolume, elliottBars: [], baselineSessions: null, news: [] }
}
const ctx = (data, n) => ({ data, ind: indicatorsFor(data, MIDNIGHT), n, minute: Math.round((data.bars[n - 1].t - MIDNIGHT) / MINUTE) + 1, midnight: MIDNIGHT, candidate: {} })

test('EMA and RSI basics', () => {
  assert.deepEqual(emaSeries([10, 10, 10], 9), [10, 10, 10])
  const up = rsiSeries(Array.from({ length: 20 }, (_, i) => 10 + i))
  assert.equal(up[19], 100)
  assert.ok(Number.isNaN(up[5]))
})

test('ORB5: green opening range, first close above the range high triggers; stop modes', () => {
  const rows = [[560, 5, 5.05, 4.95, 5, 1000]]
  // 09:30-09:34 range 5.00-5.20, green.
  rows.push([570, 5.0, 5.1, 4.98, 5.08, 9000], [571, 5.08, 5.2, 5.05, 5.15, 8000], [572, 5.15, 5.18, 5.1, 5.12, 6000], [573, 5.12, 5.16, 5.08, 5.14, 5000], [574, 5.14, 5.19, 5.1, 5.18, 5000])
  rows.push([575, 5.18, 5.2, 5.15, 5.19, 4000], [576, 5.19, 5.3, 5.18, 5.28, 9000])
  const data = day(rows)
  assert.equal(orb5('atr10')(ctx(data, 7)), null) // 09:35 closed at 5.19, not above 5.20
  const signal = orb5('atr10')(ctx(data, 8))
  assert.ok(signal)
  assert.ok(Math.abs(signal.stop - (5.28 - 0.05)) < 1e-9)
  assert.ok(Math.abs(orb5('range_low')(ctx(data, 8)).stop - 4.97) < 1e-9)
})

test('ORB5: red opening range never triggers', () => {
  const rows = [[570, 5.2, 5.25, 5.0, 5.05, 9000], [571, 5.05, 5.1, 5.0, 5.02, 8000], [572, 5.02, 5.05, 4.98, 5.0, 6000], [573, 5.0, 5.04, 4.97, 5.01, 5000], [574, 5.01, 5.03, 4.99, 5.0, 5000], [575, 5.0, 5.4, 5.0, 5.35, 9000]]
  assert.equal(orb5('range_low')(ctx(day(rows), 6)), null)
})

test('PMH breakout needs a fresh close above the pre-market high on a volume surge', () => {
  const rows = []
  for (let m = 480; m < 490; m += 1) rows.push([m, 4.5, 4.8, 4.45, 4.6, 2000])
  for (let m = 570; m < 580; m += 1) rows.push([m, 4.6, 4.75, 4.55, 4.7, 3000])
  rows.push([580, 4.7, 5.0, 4.69, 4.95, 20000])
  const data = day(rows)
  const signal = pmhBreakout(ctx(data, rows.length))
  assert.ok(signal)
  assert.match(signal.reason, /PMH break of 4.8000/)
  // Same bar on weak volume does not trigger.
  rows[rows.length - 1][5] = 3000
  assert.equal(pmhBreakout(ctx(day(rows), rows.length)), null)
})

test('Micro pullback: uptrend, light-volume dip that holds VWAP, first new-high candle', () => {
  const rows = []
  let price = 4
  // Choppy uptrend (up 0.11, down 0.05) so RSI stays in the 50-80 zone instead of being stretched.
  for (let m = 560; m < 600; m += 1) {
    const step = m % 2 === 0 ? 0.11 : -0.05
    rows.push([m, price, Math.max(price, price + step) + 0.01, Math.min(price, price + step) - 0.01, price + step, 5000])
    price += step
  }
  // High of day 5.26; pullback 3 bars on light volume, holding above VWAP/EMA 20
  rows.push([600, 5.2, 5.24, 5.14, 5.15, 1500], [601, 5.15, 5.17, 5.1, 5.12, 1200], [602, 5.12, 5.16, 5.11, 5.14, 1000])
  rows.push([603, 5.14, 5.22, 5.13, 5.21, 4000]) // closes above the prior bar's high
  const data = day(rows)
  const signal = microPullback(ctx(data, rows.length))
  assert.ok(signal, 'expected a micro-pullback entry')
  assert.ok(Math.abs(signal.stop - 5.09) < 1e-9)
  // A stretched trend (RSI above 80) is rejected.
  const stretched = []
  let p = 4
  for (let m = 560; m < 600; m += 1) { stretched.push([m, p, p + 0.06, p - 0.01, p + 0.05, 5000]); p += 0.05 }
  stretched.push([600, 6.0, 6.02, 5.9, 5.92, 1500], [601, 5.92, 5.95, 5.85, 5.88, 1200], [602, 5.88, 5.93, 5.86, 5.9, 1000], [603, 5.9, 6.01, 5.89, 5.99, 4000])
  assert.equal(microPullback(ctx(day(stretched), stretched.length)), null)
})

test('Bull flag on 5-minute candles with measured-move target', () => {
  const rows = []
  const five = (start, o, h, l, c, v) => { for (let i = 0; i < 5; i += 1) rows.push([start + i, i === 0 ? o : c, h, l, c, v / 5]) }
  five(570, 5.0, 5.05, 4.95, 5.0, 10000)
  five(575, 5.0, 5.05, 4.95, 5.01, 10000)
  five(580, 5.0, 5.3, 4.99, 5.28, 40000) // pole 1
  five(585, 5.28, 5.5, 5.25, 5.48, 40000) // pole 2  (+9.6%)
  five(590, 5.48, 5.49, 5.38, 5.42, 12000) // flag
  five(595, 5.42, 5.46, 5.36, 5.4, 10000) // flag
  rows.push([600, 5.4, 5.52, 5.39, 5.5, 8000]) // 1-min close above flag high 5.49
  const data = day(rows)
  const signal = bullFlag(ctx(data, rows.length))
  assert.ok(signal, 'expected a bull-flag entry')
  assert.ok(Math.abs(signal.stop - 5.35) < 1e-9)
  assert.ok(Math.abs(signal.target - (5.49 + (5.5 - 4.99))) < 1e-9)
})

test('no look-ahead: adding future bars does not change a decision at bar n', () => {
  const rows = [[570, 5.0, 5.1, 4.98, 5.08, 9000], [571, 5.08, 5.2, 5.05, 5.15, 8000], [572, 5.15, 5.18, 5.1, 5.12, 6000], [573, 5.12, 5.16, 5.08, 5.14, 5000], [574, 5.14, 5.19, 5.1, 5.18, 5000], [575, 5.18, 5.3, 5.17, 5.28, 9000]]
  const before = orb5('range_low')(ctx(day(rows), 6))
  const withFuture = orb5('range_low')(ctx(day([...rows, [576, 5.28, 9, 1, 2, 1e6]]), 6))
  assert.deepEqual(before, withFuture)
})

test('Jose band filter: 20-30%, $3+, RVOL 2.5+', () => {
  assert.equal(band20to30({ changePercent: 25, price: 4, relativeVolumeReliable: true, relativeVolume: 3 }), null)
  assert.equal(band20to30({ changePercent: 35, price: 4, relativeVolumeReliable: true, relativeVolume: 3 }), 'gain_band')
  assert.equal(band20to30({ changePercent: 25, price: 2, relativeVolumeReliable: true, relativeVolume: 3 }), 'min_price')
  assert.equal(band20to30({ changePercent: 25, price: 4, relativeVolumeReliable: true, relativeVolume: 2 }), 'rvol')
})

test('round 2: wide universe (10-60%) and looser bull flag (+3% pole, flag volume <= 75%)', async () => {
  const { gainers10to60, bullFlagWith, LOOSE_FLAG, STRICT_FLAG } = await import('../scripts/backtest/technical')
  assert.equal(gainers10to60({ changePercent: 45, price: 4, relativeVolumeReliable: true, relativeVolume: 3 }), null)
  assert.equal(gainers10to60({ changePercent: 75, price: 4, relativeVolumeReliable: true, relativeVolume: 3 }), 'gain_range')
  const rows = []
  const five = (start, o, h, l, c, v) => { for (let i = 0; i < 5; i += 1) rows.push([start + i, i === 0 ? o : c, h, l, c, v / 5]) }
  five(570, 5.0, 5.05, 4.95, 5.0, 10000)
  five(575, 5.0, 5.05, 4.95, 5.01, 10000)
  five(580, 5.0, 5.18, 4.99, 5.17, 30000) // pole +3.4%
  five(585, 5.17, 5.16, 5.1, 5.12, 21000) // flag at 70% of pole volume
  five(590, 5.12, 5.15, 5.09, 5.13, 21000)
  rows.push([595, 5.13, 5.2, 5.12, 5.19, 8000])
  const data = day(rows)
  assert.equal(bullFlagWith(STRICT_FLAG)(ctx(data, rows.length)), null)
  assert.ok(bullFlagWith(LOOSE_FLAG)(ctx(data, rows.length)))
})

test('Strategy J helpers: buy/sell ratio, next round level, wide vs tight stop', async () => {
  const { buySellRatio, nextRoundLevel, joseSetup, joseChecklist } = await import('../scripts/backtest/technical')
  const flow = [{ c: 5, v: 0 }, { c: 5.1, v: 300 }, { c: 5.05, v: 100 }, { c: 5.2, v: 300 }]
  assert.equal(buySellRatio(flow, 3, 15), 6)
  assert.equal(nextRoundLevel(3.37), 3.5)
  assert.equal(nextRoundLevel(3.45), 4) // 3.50 is less than 2% away
  assert.equal(nextRoundLevel(12.3), 13)
  assert.equal(joseChecklist({ changePercent: 30, price: 5, relativeVolumeReliable: true, relativeVolume: 3, hasNews: false, float: 5e6 }), 'no_news')
  assert.equal(joseChecklist({ changePercent: 30, price: 5, relativeVolumeReliable: true, relativeVolume: 3, hasNews: true, float: 20e6 }), 'float')

  // Uptrend on heavy up-volume, a 3-bar pullback, then a green candle above the prior high.
  const build = (pullbackVolume) => {
    const rows = []
    let p = 4
    for (let m = 560; m < 600; m += 1) {
      const step = m % 2 === 0 ? 0.11 : -0.05
      rows.push([m, p, Math.max(p, p + step) + 0.01, Math.min(p, p + step) - 0.01, p + step, step > 0 ? 9000 : 3000])
      p += step
    }
    rows.push([600, 5.2, 5.24, 5.14, 5.15, pullbackVolume], [601, 5.15, 5.17, 5.1, 5.12, pullbackVolume], [602, 5.12, 5.16, 5.11, 5.14, 1000], [603, 5.14, 5.22, 5.13, 5.21, 4000])
    return rows
  }
  const bullish = joseSetup(0.2)(ctx(day(build(1000)), 44))
  assert.ok(bullish && /bullish/.test(bullish.reason))
  assert.ok(Math.abs(bullish.stop - 5.21 * 0.8) < 1e-9)
  assert.equal(bullish.target, 5.5)
  const heavySelling = joseSetup(0.2)(ctx(day(build(60000)), 44))
  assert.ok(heavySelling && /not bullish/.test(heavySelling.reason))
  assert.ok(Math.abs(heavySelling.stop - 5.09) < 1e-9)
})
