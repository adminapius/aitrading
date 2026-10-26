// ARCHIVED (Oct 25, 2026): parked E-J runner's pass rule. Not part of npm test.
import assert from 'node:assert/strict'
import test from 'node:test'
import { SCAN_MINUTES, passCheck } from '../../scripts/backtest/archive/strategy-ej'

test('scan times and the holdout pass rule', () => {
  assert.deepEqual(SCAN_MINUTES.slice(0, 6), [420, 435, 450, 465, 480, 485])
  assert.equal(SCAN_MINUTES.at(-1), 655)
  const t = (r, pnl) => ({ r, pnl })
  const ej = [...Array(20).fill(t(1, 10)), ...Array(12).fill(t(-1, -10))]
  const ec = Array(32).fill(t(0, 0))
  assert.equal(passCheck(ej, ec).pass, true)
  assert.equal(passCheck(ej.slice(0, 29), ec).pass, false) // under 30 trades
})
