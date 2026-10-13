import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveTradingHalt } from '../lib/trading-control'

const row = (overrides = {}) => ({ trading_halt: false, schedule_enabled: true, entries_open_et: '07:00:00', entries_close_et: '11:00:00', last_effective_halt: null, reason: null, ...overrides })
const at = (iso) => new Date(iso)

test('schedule: trading allowed 07:00-11:00 ET on weekdays only', () => {
  assert.equal(effectiveTradingHalt(row(), at('2026-10-12T10:59:00Z')).halted, true) // 06:59 ET
  assert.equal(effectiveTradingHalt(row(), at('2026-10-12T11:00:00Z')).halted, false) // 07:00 ET
  assert.equal(effectiveTradingHalt(row(), at('2026-10-12T14:59:00Z')).halted, false) // 10:59 ET
  const closed = effectiveTradingHalt(row(), at('2026-10-12T15:00:00Z')) // 11:00 ET
  assert.equal(closed.halted, true)
  assert.equal(closed.source, 'schedule')
  assert.equal(effectiveTradingHalt(row(), at('2026-10-11T14:00:00Z')).halted, true) // Sunday
})

test('manual switch wins over the schedule; database is the only switch', () => {
  const manual = effectiveTradingHalt(row({ trading_halt: true, reason: 'checking something' }), at('2026-10-12T14:00:00Z'))
  assert.deepEqual([manual.halted, manual.source, manual.reason], [true, 'manual', 'checking something'])
  process.env.TRADING_HALT = 'true'
  try {
    assert.equal(effectiveTradingHalt(row(), at('2026-10-12T14:00:00Z')).halted, false) // env var is ignored
  } finally {
    delete process.env.TRADING_HALT
  }
})

test('schedule can be turned off; unreadable control fails closed', () => {
  assert.equal(effectiveTradingHalt(row({ schedule_enabled: false }), at('2026-10-12T18:00:00Z')).halted, false)
  const missing = effectiveTradingHalt(null, at('2026-10-12T14:00:00Z'))
  assert.deepEqual([missing.halted, missing.source], [true, 'unavailable'])
})
