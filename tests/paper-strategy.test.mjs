import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedScanIntervalSeconds } from '../lib/scan-config'
import { decideEntry, normalizeFloatShares, simulatedMarginBuyingPower, strategyGuardrails } from '../lib/strategy'
import { paperExitLevels, paperExitReason, paperExitRequestedPrice } from '../lib/paper-exits'

const openingBellCandidate = {
  symbol: 'TEST',
  price: 10,
  bid: 9.99,
  ask: 10.01,
  volume: 1_000_000,
  averageVolume: 100_000,
  relativeVolume: 10,
  float: 5_000_000,
  changePercent: 10,
  vwap: 9,
  atr: 0.5,
  hasNews: true,
}
const openingScanTime = new Date('2026-10-08T14:00:00.000Z')

test('float sanity rejects implausible share counts', () => {
  assert.equal(normalizeFloatShares(6_811), undefined)
  assert.equal(normalizeFloatShares(5_000_000), 5_000_000)
})

test('unreliable relative volume cannot create an entry', () => {
  const decision = decideEntry({ ...openingBellCandidate, relativeVolumeReliable: false }, 2_000, openingScanTime)
  assert.equal(decision.action, 'hold')
})

test('entry sizing honors per-position and per-trade risk caps', () => {
  const decision = decideEntry(openingBellCandidate, 2_000, openingScanTime)
  assert.equal(decision.action, 'enter')
  assert.ok(decision.suggestedShares * openingBellCandidate.price <= 2_000 * strategyGuardrails.maxPositionFraction)
  assert.ok(decision.suggestedShares * decision.riskPerShare <= 2_000 * strategyGuardrails.riskPerTradeFraction)
  assert.equal(strategyGuardrails.maxAggregateExposureFraction, 0.75)
  assert.equal(strategyGuardrails.maxOpenPositions, 3)
})

test('margin credit is removed below the equity floor', () => {
  assert.equal(simulatedMarginBuyingPower(1_950, 1_600, 300, 2_000), 1_600)
  assert.equal(simulatedMarginBuyingPower(2_000, 1_600, 300, 2_000), 3_700)
})

test('exit orders use the triggered level while scheduled flatten uses the observed bid', () => {
  const position = {
    id: 'position-1',
    symbol: 'TEST',
    quantity: 100,
    entry_price: 10,
    stop_price: 9.5,
    target_price: 11,
    metadata: { riskPerShare: 0.5 },
  }
  const stoppedMark = { symbol: 'TEST', price: 9.45, bid: 9.4, ask: 9.5, at: '2026-10-08T14:00:00.000Z' }
  const targetMark = { ...stoppedMark, price: 11.1, bid: 11.05, ask: 11.15 }

  assert.equal(paperExitReason(position, stoppedMark, false), 'protective stop reached')
  assert.equal(paperExitRequestedPrice(position, stoppedMark, 'protective stop reached'), 9.5)
  assert.equal(paperExitReason(position, targetMark, false), 'profit target reached')
  assert.equal(paperExitRequestedPrice(position, targetMark, 'profit target reached'), 11)
  assert.equal(paperExitRequestedPrice(position, stoppedMark, 'scheduled session flatten'), 9.4)
  assert.deepEqual(paperExitLevels(position), { stopPrice: 9.5, targetPrice: 11, riskPerShare: 0.5 })
})

test('reported scan cadence changes from 15 to 30 seconds at 11 ET', () => {
  assert.equal(expectedScanIntervalSeconds(new Date('2026-10-08T14:59:00.000Z')), 15)
  assert.equal(expectedScanIntervalSeconds(new Date('2026-10-08T15:00:00.000Z')), 30)
})

test("flatten window starts at 15:30 ET (Jose's standing rule), weekdays only", async () => {
  const { isFlattenWindow, easternSchedule, strategyGuardrails: g } = await import('../lib/strategy')
  const at = (iso) => new Date(iso) // EDT on 2026-10-26 (Mon) = UTC-4
  assert.equal(isFlattenWindow(at('2026-10-26T19:29:00Z')), false) // 15:29
  assert.equal(isFlattenWindow(at('2026-10-26T19:30:00Z')), true) // 15:30
  assert.equal(isFlattenWindow(at('2026-10-26T19:55:00Z')), true) // 15:55
  assert.equal(isFlattenWindow(at('2026-10-26T20:00:00Z')), false) // 16:00
  assert.equal(isFlattenWindow(at('2026-10-24T19:45:00Z')), false) // Saturday
  assert.equal(easternSchedule(at('2026-10-26T19:45:00Z')).flattenWindow, true)
  assert.equal(g.flattenBeforeEt, '15:30')
})
