import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { cleanMomentumBlockReason } from '../lib/strategies/clean-momentum'
import { decideStrategyEntry, resolveStrategyConfig, summarizeSymbolDayHistory } from '../lib/strategies/live-strategy'
import { decideEntry } from '../lib/strategy'

// Generated on the backtest branch from scripts/backtest/variants.ts cleanMomentumFilter.
const rawFixture = JSON.parse(readFileSync(new URL('./fixtures/clean-momentum-decisions.json', import.meta.url), 'utf8'))
const fixture = {
  source: rawFixture.source,
  cases: rawFixture.rows.map(([changePercent, price, spreadPct, regime, entryIndex, priorTargetHits, decision]) => ({
    input: { changePercent, price, spreadPct, regime, entryIndex, priorTargetHits },
    decision,
  })),
}

test('live Strategy E filter matches every recorded backtest decision', () => {
  assert.ok(fixture.cases.length > 1000)
  for (const { input, decision } of fixture.cases) {
    const live = cleanMomentumBlockReason({
      changePercent: input.changePercent,
      price: input.price,
      spreadPct: input.spreadPct,
      regime: input.regime,
      entryIndex: input.entryIndex,
      firstEntryHitTarget: input.priorTargetHits[0] === true,
    })
    assert.equal(live, decision, JSON.stringify(input))
  }
})

const openingBell = new Date('2026-10-07T13:35:00Z')
const candidate = (changePercent, price = 10) => ({
  symbol: 'TEST', price, bid: price - 0.01, ask: price + 0.01, spreadPct: 0.2, volume: 2_000_000, relativeVolume: 4,
  changePercent, atr: 0.4, vwap: price * 0.98, ema9: price * 0.99, floatShares: 20_000_000, catalyst: 'news',
  lastTradeAt: openingBell.toISOString(),
})

test('Strategy A decisions are identical to the existing decideEntry', () => {
  for (const gain of [5, 25, 60]) {
    const input = candidate(gain)
    const decision = decideStrategyEntry('A', { scanCandidate: input, executable: input, equity: 100_000, now: openingBell, availableAllocation: 25_000, history: null })
    const { strategy, ...rest } = decision
    assert.equal(strategy, 'A')
    assert.deepEqual(rest, decideEntry(input, 100_000, openingBell, 25_000))
  }
})

test('Strategy E only ever narrows A: it never enters where A holds and blocks out-of-range gains', () => {
  for (const gain of [5, 15, 22, 28, 35, 80]) {
    const input = candidate(gain)
    const args = { scanCandidate: input, executable: input, equity: 100_000, now: openingBell, availableAllocation: 25_000, history: { entries: 0, firstEntryHitTarget: false } }
    const a = decideStrategyEntry('A', args)
    const e = decideStrategyEntry('E', args)
    if (a.action !== 'enter') assert.equal(e.action, 'hold')
    if (e.action === 'enter') {
      assert.equal(e.suggestedShares, a.suggestedShares)
      assert.ok(gain >= 20 && gain < 30)
    }
    if (a.action === 'enter' && (gain < 20 || gain >= 30)) assert.equal(e.blockedBy, 'gain_range')
  }
})

test('Strategy E fails closed when today\u2019s symbol history is unavailable', () => {
  const input = candidate(25)
  const a = decideStrategyEntry('A', { scanCandidate: input, executable: input, equity: 100_000, now: openingBell, availableAllocation: 25_000, history: null })
  const e = decideStrategyEntry('E', { scanCandidate: input, executable: input, equity: 100_000, now: openingBell, availableAllocation: 25_000, history: null })
  if (a.action === 'enter') assert.equal(e.blockedBy, 'history_unavailable')
  assert.equal(e.action, 'hold')
})

test('symbol day history counts entries and records whether the first one hit target', () => {
  const history = summarizeSymbolDayHistory([
    { symbol: 'AAA', opened_at: '2026-10-07T14:00:00Z', metadata: {} },
    { symbol: 'AAA', opened_at: '2026-10-07T13:40:00Z', metadata: { exitReason: 'profit target reached' } },
    { symbol: 'BBB', opened_at: '2026-10-07T13:45:00Z', metadata: { exitReason: 'protective stop reached' } },
  ])
  assert.deepEqual(history.get('AAA'), { entries: 2, firstEntryHitTarget: true })
  assert.deepEqual(history.get('BBB'), { entries: 1, firstEntryHitTarget: false })
})

test('strategy config defaults to live E with shadow A, and supports rollback to A', () => {
  assert.deepEqual(resolveStrategyConfig({}), { live: 'E', shadow: 'A', warnings: [] })
  assert.deepEqual(resolveStrategyConfig({ STRATEGY_LIVE: 'a', STRATEGY_SHADOW: 'E' }), { live: 'A', shadow: 'E', warnings: [] })
  assert.equal(resolveStrategyConfig({ STRATEGY_LIVE: 'E', STRATEGY_SHADOW: 'E' }).shadow, null)
  const bad = resolveStrategyConfig({ STRATEGY_LIVE: 'Z' })
  assert.equal(bad.live, 'E')
  assert.equal(bad.warnings.length, 1)
})
