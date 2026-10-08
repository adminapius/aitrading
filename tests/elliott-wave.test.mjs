import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { advanceShadowOutcome, analyzeElliottWave, createElliottSignalDrafts } from '../lib/elliott-wave'
import { isBarCacheFresh, mergeIncrementalBars, updateTrackedWaveCandidates } from '../lib/elliott-wave-shadow'

const sessionStart = Date.parse('2026-10-08T13:00:00.000Z')

function makeBars(turns, options = {}) {
  const bars = []
  const volumes = options.volumes ?? [1_000, 500, 2_500, 600, 300, 250]
  for (let segment = 0; segment < turns.length - 1; segment += 1) {
    const start = turns[segment]
    const end = turns[segment + 1]
    const steps = Math.max(3, Math.ceil(Math.abs(end - start) / 0.15))
    for (let step = segment === 0 ? 0 : 1; step <= steps; step += 1) {
      const previous = start + ((end - start) * Math.max(0, step - 1)) / steps
      const close = start + ((end - start) * step) / steps
      const time = new Date(sessionStart + bars.length * 60_000).toISOString()
      bars.push({
        t: time,
        h: Math.max(previous, close) + 0.015,
        l: Math.min(previous, close) - 0.015,
        c: close,
        v: volumes[segment] ?? 900,
        vw: options.barVwap ?? 9,
      })
    }
  }
  return bars
}

function analyze(bars, now = new Date(Date.parse(bars.at(-1).t) + 60_000), overrides = {}) {
  return analyzeElliottWave({ bars, now, rvol: 5, regimeRvol: 3, vwap: 9, ...overrides })
}

function pivotSeries(turns, options = {}) {
  return analyze(makeBars(turns, options))
}

const validTurns = [10, 12, 11, 15, 14, 17, 16.4]

function shadowSignal(overrides = {}) {
  return {
    stop: 9,
    t1: 11,
    t2: 12,
    triggered_at: '2026-10-08T14:00:00.000Z',
    would_be_shares: 100,
    metadata: {
      entryFill: 10,
      initialRiskDollars: 100,
      remainingShares: 100,
      t1Shares: 50,
      t1Hit: false,
      partialRealizedPnl: 0,
      trailingStop: 9,
      ...overrides,
    },
  }
}

const liveMark = (price, bid = price - 0.05, ask = price + 0.05) => ({ price, bid, ask })

test('incremental bars replace the latest candle and keep timestamps ordered', () => {
  const firstBar = { t: '2026-10-08T14:00:00.000Z', h: 10.2, l: 9.8, c: 10, v: 100, vw: 10 }
  const revisedBar = { ...firstBar, h: 10.4, c: 10.3, v: 150 }
  const nextBar = { ...firstBar, t: '2026-10-08T14:01:00.000Z', c: 10.2 }
  const merged = mergeIncrementalBars([firstBar], [revisedBar, nextBar])

  assert.deepEqual(merged, [revisedBar, nextBar])
  assert.equal(isBarCacheFresh({ fetchedMinute: Math.floor(Date.parse(firstBar.t) / 60_000) }, new Date('2026-10-08T14:00:59.000Z')), true)
  assert.equal(isBarCacheFresh({ fetchedMinute: Math.floor(Date.parse(firstBar.t) / 60_000) }, new Date('2026-10-08T14:01:00.000Z')), false)
})

test('eligible symbols remain wave-tracked through gate failures until timeout or invalidation', () => {
  const startedAt = new Date('2026-10-08T14:00:00.000Z')
  const candidate = { symbol: 'TEST', price: 10, relativeVolume: 5 }
  const tracked = new Map()

  assert.deepEqual(updateTrackedWaveCandidates({ tracked, eligibleCandidates: [candidate], now: startedAt }), [candidate])
  const latestCandidate = { ...candidate, price: 9.8, relativeVolume: 2 }
  assert.deepEqual(updateTrackedWaveCandidates({ tracked, eligibleCandidates: [], observedCandidates: [latestCandidate], now: new Date(startedAt.getTime() + 44 * 60_000) }), [latestCandidate])
  assert.equal(tracked.get('TEST').startedAt, startedAt.getTime())
  assert.deepEqual(updateTrackedWaveCandidates({ tracked, eligibleCandidates: [], now: new Date(startedAt.getTime() + 45 * 60_000) }), [])

  updateTrackedWaveCandidates({ tracked, eligibleCandidates: [candidate], now: startedAt })
  assert.deepEqual(updateTrackedWaveCandidates({ tracked, eligibleCandidates: [], invalidatedSymbols: ['TEST'], now: new Date(startedAt.getTime() + 1_000) }), [])
})

// These paths deliberately use synthetic, closed one-minute candles, not hand-built pivots.
test('recognizes a valid 0-1-2-3-4-5 impulse and calculates bounded confidence', () => {
  const result = pivotSeries(validTurns)
  assert.equal(result.valid, true)
  assert.equal(result.impulsePivots.length, 6)
  assert.deepEqual(result.impulsePivots.map((pivot) => pivot.kind), ['low', 'high', 'low', 'high', 'low', 'high'])
  assert.equal(result.currentWave, 5)
  assert.ok(result.waveConfidence >= 0 && result.waveConfidence <= 100)
})

test('invalidates a wave 2 that breaks the wave 1 start', () => {
  const result = pivotSeries([10, 12, 9.4, 15, 14, 18, 17.4])
  assert.equal(result.valid, false)
  assert.equal(result.invalidationReason, 'wave2_broke_wave0')
})

test('does not award wave 2 VWAP confluence when its closed bars are below session VWAP', () => {
  const result = pivotSeries(validTurns)
  assert.equal(result.valid, true)
  assert.equal(result.confluence.wave2AboveVwap, false)
})

test('thin premarket prints below the configured bar-volume floor cannot create pivots', () => {
  const bars = Array.from({ length: 25 }, (_, index) => {
    const close = index % 2 ? 10.3 : 10
    return {
      t: new Date(Date.parse('2026-10-08T12:00:00.000Z') + index * 60_000).toISOString(),
      h: close + 0.1,
      l: close - 0.1,
      c: close,
      v: 10,
      vw: 9,
    }
  })
  const result = analyze(bars)
  assert.equal(result.pivots.length, 0)
})

test('invalidates an impulse when wave 3 is the shortest wave', () => {
  const result = pivotSeries([10, 12, 11, 12.6, 12.2, 15, 14.4])
  assert.equal(result.valid, false)
  assert.equal(result.invalidationReason, 'wave3_shortest')
})

test('invalidates a wave 4 low that overlaps wave 1 price territory', () => {
  const result = pivotSeries([10, 12, 11, 16, 11.7, 18, 17.5])
  assert.equal(result.valid, false)
  assert.equal(result.invalidationReason, 'wave4_overlapped_wave1')
})

test('times out an untriggered wave 3 setup twenty minutes after wave 2', () => {
  const bars = makeBars([10, 12, 11, 11.45])
  const now = new Date(Date.parse(bars.at(-1).t) + 60 * 60_000)
  const analysis = analyze(bars, now)
  const drafts = createElliottSignalDrafts({
    analysis,
    symbol: 'TEST',
    regime: 'opening-momentum',
    rvol: 5,
    regimeRvol: 3,
    equity: 10_000,
    currentExposure: 0,
    mark: { bid: 11.4, ask: 11.5, price: 11.45, at: now.toISOString() },
    now,
    actualEntry: false,
    allowEntries: true,
  })
  assert.ok(drafts.some((draft) => draft.rule === 'ew_wave3' && draft.outcome === 'timeout'))
})

test('flags wave 5 exhaustion when its volume contracts below wave 3', () => {
  const result = pivotSeries(validTurns)
  assert.equal(result.wave5Complete, true)
  assert.equal(result.confluence.wave5Exhaustion, true)
  assert.equal(result.exhaustion, true)
})

test('closed-bar analysis is identical in streaming and batch delivery and ignores future bars', () => {
  const bars = makeBars(validTurns)
  let streamed
  for (let index = 0; index < bars.length; index += 1) {
    const now = new Date(Date.parse(bars[index].t) + 60_000)
    streamed = analyze(bars.slice(0, index + 1), now)
  }
  const now = new Date(Date.parse(bars.at(-1).t) + 60_000)
  const batch = analyze(bars, now)
  const futureBars = [...bars, ...makeBars([17, 19, 18]).map((bar, index) => ({ ...bar, t: new Date(now.getTime() + index * 60_000).toISOString() }))]
  const withFutureData = analyze(futureBars, now)
  assert.deepEqual(streamed.pivots, batch.pivots)
  assert.deepEqual(streamed.pivots, withFutureData.pivots)
  assert.equal(streamed.waveConfidence, batch.waveConfidence)
  assert.equal(streamed.currentWave, batch.currentWave)
})

test('tracks T1 partial, later T2, and stop/gap/flatten outcomes with the shared fill model', () => {
  const now = new Date('2026-10-08T14:01:00.000Z')
  const firstTarget = advanceShadowOutcome({ signal: shadowSignal(), mark: liveMark(11.1, 11.05, 11.15), now, flatten: false })
  assert.equal(firstTarget.outcome, null)
  assert.equal(firstTarget.metadata.t1Hit, true)
  assert.equal(firstTarget.metadata.remainingShares, 50)
  assert.ok(Number(firstTarget.metadata.partialRealizedPnl) > 0)

  const secondTarget = advanceShadowOutcome({ signal: { ...shadowSignal(), metadata: firstTarget.metadata }, mark: liveMark(12.1, 12, 12.2), now, flatten: false })
  assert.equal(secondTarget.outcome, 't2')
  assert.ok(secondTarget.rMultiple > 0)

  const stopped = advanceShadowOutcome({ signal: shadowSignal(), mark: liveMark(8.8, 8.7, 8.9), now, flatten: false })
  assert.equal(stopped.outcome, 'stop')
  assert.ok(Number(stopped.metadata.gapPastStop) > 0)

  const flattened = advanceShadowOutcome({ signal: shadowSignal(), mark: liveMark(10.5, 10.4, 10.6), now, flatten: true })
  assert.equal(flattened.outcome, 'flatten')
  assert.equal(flattened.metadata.observedBid, 10.4)
})

test('records the wave 4 projected target as a terminal T1 result', () => {
  const result = advanceShadowOutcome({
    signal: { ...shadowSignal({ phase: 'wave4_reentry' }), t1: 12 },
    mark: liveMark(12.1, 12, 12.2),
    now: new Date('2026-10-08T14:01:00.000Z'),
    flatten: false,
  })
  assert.equal(result.outcome, 't1')
})

test('shadow analysis and persistence never invoke paper open/close RPCs', () => {
  const engine = readFileSync(new URL('../lib/elliott-wave.ts', import.meta.url), 'utf8')
  const persistence = readFileSync(new URL('../lib/elliott-wave-shadow.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(engine, /open_ait_paper_position|close_ait_paper_position/)
  assert.doesNotMatch(persistence, /open_ait_paper_position|close_ait_paper_position/)
})
