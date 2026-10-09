import assert from 'node:assert/strict'
import test from 'node:test'
import { admitShadowEntry, buildShadowLedger, resolveShadowOutcome, shadowAvailableAllocation } from '../lib/strategies/shadow-strategy'

const limits = { maxOpenPositions: 3, maxPositionFraction: 0.25, maxAggregateExposureFraction: 0.75, maxDailyLossFraction: 0.04, reentryCooldownMinutes: 30 }
const now = new Date('2026-10-12T14:30:00Z')
const row = (overrides) => ({ symbol: 'AAA', session_id: 's1', outcome: null, outcome_at: null, trigger_price: 10, would_be_shares: 100, fill_price: null, ...overrides })
const ledger = (rows, marks = new Map()) => buildShadowLedger({ rows, sessionId: 's1', startingBalance: 10_000, marks, slippageFraction: 0, limits })

test('shadow ledger equity moves only with shadow P&L, split into prior sessions and today', () => {
  const state = ledger([
    row({ session_id: 's0', outcome: 't1', fill_price: 15 }),
    row({ symbol: 'BBB', outcome: 'stop', fill_price: 9, outcome_at: now.toISOString() }),
    row({ symbol: 'CCC' }),
  ], new Map([['CCC', { bid: 11 }]]))
  assert.equal(state.sessionStartEquity, 10_500)
  assert.equal(state.dailyPnl, -100 + 100)
  assert.equal(state.equity, 10_500)
  assert.deepEqual([...state.openSymbols], ['CCC'])
  assert.equal(state.openExposure, 1_000)
  assert.equal(state.dailyLossStopped, false)
})

test('shadow caps a single position at 25% of shadow equity and total exposure at 75%', () => {
  const state = ledger([])
  const first = admitShadowEntry(state, { symbol: 'AAA', fill: 10, shares: 10_000, now }, limits)
  assert.deepEqual(first, { admitted: true, shares: 250 })
  admitShadowEntry(state, { symbol: 'BBB', fill: 10, shares: 10_000, now }, limits)
  state.openExposure = 7_000
  const third = admitShadowEntry(state, { symbol: 'CCC', fill: 10, shares: 10_000, now }, limits)
  assert.deepEqual(third, { admitted: true, shares: 50 })
})

test('shadow allows at most 3 concurrent positions and one per symbol', () => {
  const state = ledger([row({ symbol: 'AAA' }), row({ symbol: 'BBB' })])
  assert.deepEqual(admitShadowEntry(state, { symbol: 'AAA', fill: 1, shares: 10, now }, limits), { admitted: false, blockedBy: 'symbol_already_open' })
  assert.equal(admitShadowEntry(state, { symbol: 'CCC', fill: 1, shares: 10, now }, limits).admitted, true)
  assert.deepEqual(admitShadowEntry(state, { symbol: 'DDD', fill: 1, shares: 10, now }, limits), { admitted: false, blockedBy: 'max_open_positions' })
  assert.equal(shadowAvailableAllocation(state, limits), 0)
})

test('shadow enforces the 30-minute re-entry cooldown after a stop', () => {
  const stoppedAt = new Date(now.getTime() - 29 * 60_000).toISOString()
  const state = ledger([row({ outcome: 'stop', fill_price: 9.9, outcome_at: stoppedAt })])
  assert.deepEqual(admitShadowEntry(state, { symbol: 'AAA', fill: 10, shares: 10, now }, limits), { admitted: false, blockedBy: 'reentry_cooldown' })
  const later = new Date(now.getTime() + 2 * 60_000)
  assert.equal(admitShadowEntry(state, { symbol: 'AAA', fill: 10, shares: 10, now: later }, limits).admitted, true)
})

test('shadow daily loss stop triggers at -4% of session-start shadow equity, including open marks', () => {
  const state = ledger([
    row({ symbol: 'BBB', outcome: 'stop', fill_price: 7, outcome_at: now.toISOString() }),
    row({ symbol: 'CCC' }),
  ], new Map([['CCC', { bid: 9 }]]))
  assert.equal(state.dailyPnl, -400)
  assert.equal(state.dailyLossStopped, true)
  assert.equal(shadowAvailableAllocation(state, limits), 0)
  assert.deepEqual(admitShadowEntry(state, { symbol: 'DDD', fill: 1, shares: 10, now }, limits), { admitted: false, blockedBy: 'daily_loss_stop' })
})

test('flatten always resolves an open shadow position', () => {
  const open = { stop: 9, t1: 12, trigger_price: 10 }
  assert.equal(resolveShadowOutcome(open, { bid: 10.5 }, false, 0), null)
  assert.equal(resolveShadowOutcome(open, { bid: 10.5 }, true, 0).outcome, 'flatten')
  assert.equal(resolveShadowOutcome(open, { bid: 8 }, true, 0).outcome, 'stop')
})
