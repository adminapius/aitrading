import assert from 'node:assert/strict'
import test from 'node:test'
import { EDGAR_FLOAT, edgarFloatOn, filerType, namesMatch, pointBefore, sharePoints, splitAdjustShares, splitRatio } from '../scripts/backtest/edgar-float'
import { enterableDays } from '../scripts/backtest/strategy-ej-310'

const units = [
  { end: '2022-04-30', val: 8_000_000, accn: 'A1', form: '10-Q', filed: '2022-05-12' },
  { end: '2022-04-30', val: 8_000_000, accn: 'A1', form: '10-Q', filed: '2022-05-12' }, // duplicate fact
  { end: '2022-07-31', val: 6_000_000, accn: 'A2', form: '10-Q', filed: '2022-08-10' }, // class A
  { end: '2022-07-31', val: 1_000_000, accn: 'A2', form: '10-Q', filed: '2022-08-10' }, // class B, same filing
  { end: '2021-12-31', val: 9_000_000, accn: 'A2', form: '10-Q', filed: '2022-08-10' }, // older balance-sheet date in the same filing
  { end: '2022-10-31', val: 0, accn: 'A3', form: '10-Q', filed: '2022-11-10' }, // invalid value dropped
]

test('sharePoints: one point per filing, latest as-of date, classes summed, duplicates and zeros dropped', () => {
  const p = sharePoints(units)
  assert.deepEqual(p.map((x) => [x.accn, x.filed, x.end, x.shares]), [['A1', '2022-05-12', '2022-04-30', 8_000_000], ['A2', '2022-08-10', '2022-07-31', 7_000_000]])
})

test('pointBefore: by filing date, strictly before the trade day (no look-ahead)', () => {
  const p = sharePoints(units)
  assert.equal(pointBefore(p, '2022-05-12'), null) // filed that day -> not yet usable
  assert.equal(pointBefore(p, '2022-05-13').accn, 'A1')
  assert.equal(pointBefore(p, '2022-08-10').accn, 'A1') // A2 period ended Jul 31 but was filed Aug 10
  assert.equal(pointBefore(p, '2022-08-11').accn, 'A2')
})

test('namesMatch: same company passes, a reused ticker fails, missing names do not exclude', () => {
  assert.equal(namesMatch('Wolfspeed, Inc. Common Stock', 'Wolfspeed, Inc.'), true)
  assert.equal(namesMatch('Biofrontera Inc. Common Stock', 'BIOFRONTERA INC.'), true)
  assert.equal(namesMatch('Digital Turbine Inc', 'Acme Mining Corp'), false)
  assert.equal(namesMatch(undefined, 'Anything Inc'), true)
})

test('split adjustment: 1-for-10 reverse split between the count date and the trade day', () => {
  const raw = new Map([['2022-08-01', 1.0], ['2022-09-01', 10.0]])
  const adjusted = new Map([['2022-08-01', 10.0], ['2022-09-01', 10.0]])
  const days = ['2022-08-01', '2022-09-01']
  const atCount = splitRatio(raw, adjusted, days, '2022-08-03') // last trading day on or before
  const onDay = splitRatio(raw, adjusted, days, '2022-09-01')
  assert.equal(atCount, 0.1)
  assert.equal(onDay, 1)
  assert.equal(splitAdjustShares(50_000_000, atCount, onDay), 5_000_000)
  assert.equal(splitAdjustShares(5_000_000, 1, 0.5), 10_000_000) // 2-for-1 forward split
  assert.equal(splitRatio(raw, adjusted, days, '2021-01-01'), 1) // no data -> no adjustment
})

const company = (form, extra = {}) => ({ cik: '0000000001', record: { cik: '0000000001', entityName: 'Test Co', source: 'dei:EntityCommonStockSharesOutstanding', points: sharePoints(units) }, nameOk: true, annual: [{ form, date: '2021-03-01' }], ...extra })

test('edgarFloatOn: value, filer type and every reason for no value', () => {
  const ok = edgarFloatOn(company('10-K'), '2022-09-01')
  assert.equal(ok.shares, 7_000_000)
  assert.equal(ok.filer, 'domestic')
  assert.equal(ok.filed, '2022-08-10')
  assert.equal(edgarFloatOn(company('20-F'), '2022-09-01').filer, 'foreign')
  assert.equal(edgarFloatOn(undefined, '2022-09-01').miss, 'no-cik')
  assert.equal(edgarFloatOn({ cik: null, record: null, nameOk: false, annual: [] }, '2022-09-01').miss, 'no-cik')
  assert.equal(edgarFloatOn(company('10-K', { nameOk: false }), '2022-09-01').miss, 'name-mismatch')
  assert.equal(edgarFloatOn(company('10-K', { record: { cik: '1', entityName: null, source: null, points: [] } }), '2022-09-01').miss, 'no-value')
  assert.equal(edgarFloatOn(company('10-K'), '2022-05-01').miss, 'none-filed-before')
  const stale = new Date(Date.parse('2022-08-10T00:00:00Z') + (EDGAR_FLOAT.maxAgeDays + 1) * 86_400_000).toISOString().slice(0, 10)
  assert.equal(edgarFloatOn(company('10-K'), stale).miss, 'stale')
  assert.equal(filerType({ cik: '1', record: null, nameOk: true, annual: [] }, '2022-09-01'), 'unknown')
})

test('enterableDays: day high >= +20% over the prior close, high >= $3, enough volume, inside the window', () => {
  const rows = [
    { day: '2022-01-03', o: 2, h: 2, l: 2, c: 2.6, v: 1e6 },
    { day: '2022-01-04', o: 2.7, h: 3.2, l: 2.6, c: 3, v: 1e6 }, // +23%, high 3.2 -> yes
    { day: '2022-01-05', o: 3, h: 3.5, l: 3, c: 3.1, v: 1e6 }, // +16.7% -> no
    { day: '2022-01-06', o: 3.1, h: 4, l: 3, c: 3.5, v: 10 }, // +29% but tiny volume -> no
  ]
  const low = [{ day: '2022-01-03', o: 1, h: 1, l: 1, c: 1, v: 1e6 }, { day: '2022-01-04', o: 1, h: 2, l: 1, c: 2, v: 1e6 }] // +100% but under $3
  const out = enterableDays({ daily: new Map([['AAA', rows], ['BBB', low]]) }, '2022-01-01', '2022-12-31')
  assert.deepEqual([...out], [['AAA', ['2022-01-04']]])
  assert.equal(enterableDays({ daily: new Map([['AAA', rows]]) }, '2022-01-05', '2022-12-31').size, 0)
})
