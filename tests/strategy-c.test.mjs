import assert from 'node:assert/strict'
import test from 'node:test'
import { C, closingPrint, dividendFactor, isHalfDay } from '../scripts/backtest/strategy-c'

test('closingPrint: primary-exchange official close (M) first, else the largest closing print (6); other exchanges ignored', () => {
  const trades = [
    { t: '1', x: 'D', p: 450.1, s: 5000, c: ['6'] }, // off-exchange: ignored
    { t: '2', x: 'P', p: 450.02, s: 300, c: ['6'] },
    { t: '3', x: 'P', p: 450.0, s: 900_000, c: ['6'] },
    { t: '4', x: 'P', p: 450.0, s: 0, c: ['M'] },
  ]
  assert.deepEqual(closingPrint(trades, 'P'), { price: 450.0, kind: 'M' })
  assert.deepEqual(closingPrint(trades.filter((t) => !t.c.includes('M')), 'P'), { price: 450.0, kind: '6' })
  assert.equal(closingPrint(trades, 'Q'), null)
  assert.equal(closingPrint([], 'P'), null)
})

test('dividendFactor: 1 - dividend / prior close on an ex-dividend day, 1 otherwise', () => {
  // prior close 400, dividend 1.60 -> Alpaca dividend-adjusted prior close 398.40; on the ex-date adj = raw
  const f = dividendFactor(400, 398.4, 401, 401)
  assert.ok(Math.abs(f - (1 - 1.6 / 400)) < 1e-12)
  assert.ok(Math.abs(400 * f - 398.4) < 1e-9) // adjusted prior close = prior close - dividend
  // an ordinary day years before a later dividend: both days carry the same later factor -> 1
  assert.equal(dividendFactor(300, 297, 303, 299.97), 1)
  assert.equal(dividendFactor(NaN, 1, 1, 1), 1) // missing data -> no adjustment
})

test('isHalfDay and the locked windows', () => {
  assert.equal(isHalfDay({ close: '16:00' }), false)
  assert.equal(isHalfDay({ close: '13:00' }), true)
  assert.deepEqual(C.passFail, ['2020-06-01', '2026-10-16'])
  assert.deepEqual(C.consistency, ['2016-01-04', '2020-05-29'])
  assert.equal(C.signalMinute, 929)
  assert.equal(C.entryMinute, 930)
  assert.deepEqual(C.primary, { SPY: 'P', QQQ: 'Q', IWM: 'P', DIA: 'P' })
})
