import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedScanIntervalSeconds } from '../lib/scan-config.ts'
import { decideEntry, normalizeFloatShares, simulatedMarginBuyingPower, strategyGuardrails } from '../lib/strategy.ts'

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

test('reported scan cadence changes from 15 to 30 seconds at 11 ET', () => {
  assert.equal(expectedScanIntervalSeconds(new Date('2026-10-08T14:59:00.000Z')), 15)
  assert.equal(expectedScanIntervalSeconds(new Date('2026-10-08T15:00:00.000Z')), 30)
})
