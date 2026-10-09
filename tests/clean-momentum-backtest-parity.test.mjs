import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { cleanMomentumFilter } from '../scripts/backtest/variants.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/clean-momentum-decisions.json', import.meta.url), 'utf8'))

test('backtest Strategy E filter reproduces every recorded validated decision', () => {
  assert.ok(fixture.cases.length > 8000)
  for (const { input, decision } of fixture.cases) {
    const priorEntries = input.priorTargetHits.map((hitTarget) => ({ exitKind: hitTarget ? 'target' : 'stop', hitTarget }))
    const actual = cleanMomentumFilter({
      candidate: { symbol: 'TEST', price: input.price, changePercent: input.changePercent ?? undefined },
      minuteOfDay: 600,
      regime: input.regime,
      spreadPct: input.spreadPct,
      entryIndex: input.entryIndex,
      minutesSinceFirstSeen: 0,
      priorEntries,
    })
    assert.equal(actual, decision, JSON.stringify(input))
  }
})
