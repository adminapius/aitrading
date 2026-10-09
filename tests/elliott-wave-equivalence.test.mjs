import assert from 'node:assert/strict'
import test from 'node:test'
import { elliottInternalsForTest } from '../lib/elliott-wave'
import { elliottWaveConfig } from '../lib/elliott-wave-config'

const MINUTE_MS = 60_000
const FIVE_MINUTE_MS = 5 * MINUTE_MS
const EASTERN_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

// Pre-optimization implementations, copied verbatim from main before the backtest change.
function legacyEasternMinute(value) {
  const parts = EASTERN_FORMAT.formatToParts(value)
  return Number(parts.find((part) => part.type === 'hour')?.value ?? 0) * 60
    + Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
}

function legacyFiveMinuteAtrByBar(bars) {
  const groups = new Map()
  for (const bar of bars) {
    const bucket = Math.floor(Date.parse(bar.t) / FIVE_MINUTE_MS) * FIVE_MINUTE_MS
    const group = groups.get(bucket) ?? []
    group.push(bar)
    groups.set(bucket, group)
  }
  const completed = []
  for (const [start, group] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    if (!group.length) continue
    completed.push({ end: start + FIVE_MINUTE_MS, high: Math.max(...group.map((bar) => bar.h)), low: Math.min(...group.map((bar) => bar.l)), close: group.at(-1).c })
  }
  const output = new Map()
  for (const bar of bars) {
    const completedBars = completed.filter((item) => item.end <= Date.parse(bar.t) + MINUTE_MS)
    const recent = completedBars.slice(-elliottWaveConfig.pivot.fiveMinuteAtrPeriod)
    if (!recent.length) continue
    const ranges = recent.map((item, index) => {
      const previousClose = completedBars[completedBars.length - recent.length + index - 1]?.close ?? item.close
      return Math.max(item.high - item.low, Math.abs(item.high - previousClose), Math.abs(item.low - previousClose))
    })
    output.set(Date.parse(bar.t), ranges.reduce((sum, value) => sum + value, 0) / ranges.length)
  }
  return output
}

function seededRandom(seed) {
  let state = seed
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32
    return state / 2 ** 32
  }
}

function syntheticBars({ start, count, seed, gapEvery = 0 }) {
  const random = seededRandom(seed)
  const bars = []
  let price = 3
  let time = start
  for (let index = 0; index < count; index += 1) {
    if (gapEvery && index > 0 && index % gapEvery === 0) time += 7 * MINUTE_MS
    const open = price
    price = Math.max(0.2, price * (1 + (random() - 0.48) * 0.03))
    const high = Math.max(open, price) * (1 + random() * 0.01)
    const low = Math.min(open, price) * (1 - random() * 0.01)
    bars.push({ t: new Date(time).toISOString(), o: open, h: high, l: low, c: price, v: Math.round(1_000 + random() * 20_000) })
    time += MINUTE_MS
  }
  return bars
}

const series = [
  { name: 'regular session', start: Date.parse('2026-10-08T13:30:00.000Z'), count: 390, seed: 1 },
  { name: 'premarket into open', start: Date.parse('2026-04-08T08:00:00.000Z'), count: 600, seed: 7 },
  { name: 'halts and gaps', start: Date.parse('2026-07-15T13:30:00.000Z'), count: 300, seed: 42, gapEvery: 37 },
  { name: 'DST boundary week', start: Date.parse('2026-11-02T14:30:00.000Z'), count: 200, seed: 99 },
]

for (const item of series) {
  test(`fiveMinuteAtrByBar matches legacy output: ${item.name}`, () => {
    const bars = syntheticBars(item)
    const expected = legacyFiveMinuteAtrByBar(bars)
    const actual = elliottInternalsForTest.fiveMinuteAtrByBar(bars)
    assert.equal(actual.size, expected.size)
    for (const [key, value] of expected) {
      assert.ok(actual.has(key), `missing ATR at ${new Date(key).toISOString()}`)
      assert.ok(Math.abs(actual.get(key) - value) <= 1e-12 * Math.max(1, Math.abs(value)), `ATR differs at ${new Date(key).toISOString()}`)
    }
  })

  test(`easternMinute matches legacy output: ${item.name}`, () => {
    for (const bar of syntheticBars(item)) {
      const date = new Date(bar.t)
      assert.equal(elliottInternalsForTest.easternMinute(date), legacyEasternMinute(date))
      const offset = new Date(date.getTime() + 37_123)
      assert.equal(elliottInternalsForTest.easternMinute(offset), legacyEasternMinute(offset))
    }
  })
}

test('easternMinute matches legacy across both 2026 DST transitions minute by minute', () => {
  for (const anchor of ['2026-03-08T05:00:00.000Z', '2026-11-01T04:00:00.000Z']) {
    const start = Date.parse(anchor)
    for (let minute = 0; minute < 4 * 60; minute += 1) {
      const date = new Date(start + minute * MINUTE_MS)
      assert.equal(elliottInternalsForTest.easternMinute(date), legacyEasternMinute(date), date.toISOString())
    }
  }
})
