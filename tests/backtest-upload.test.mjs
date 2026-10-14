import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsv, tradeRow } from '../scripts/backtest/upload'

test('parseCsv handles quoted commas, escaped quotes and CRLF', () => {
  const rows = parseCsv('run,symbol,reason\r\nC1,ABC,"stop, after 3m; ""halt"""\r\nE,XYZ,\r\n')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { run: 'C1', symbol: 'ABC', reason: 'stop, after 3m; "halt"' })
  assert.equal(rows[1].reason, '')
})

test('tradeRow maps CSV fields to table columns with types', () => {
  const row = tradeRow({ run: 'C1', date: '2025-04-01', symbol: 'ABC', rank: '3', entryPrice: '5.25', r: '-1.02', liquidityCapped: 'false', t1Hit: 'true', float: '', catalyst: '' }, 'uuid-1')
  assert.equal(row.backtest_run_id, 'uuid-1')
  assert.equal(row.rank, 3)
  assert.equal(row.entry_price, 5.25)
  assert.equal(row.r, -1.02)
  assert.equal(row.liquidity_capped, false)
  assert.equal(row.t1_hit, true)
  assert.equal(row.float_shares, null)
  assert.equal(row.catalyst, null)
})
