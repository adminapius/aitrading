import assert from 'node:assert/strict'
import test from 'node:test'
import { EDGAR_FLOAT, edgarFloatOn, filerType, namesMatch, pointBefore, sharePoints, splitAdjustShares, splitRatio } from '../scripts/backtest/edgar-float'

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
  assert.equal(splitRatio(raw, adjusted, days, '2021-01-01'), null) // no bar on or before -> no ratio
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

// Real SEC companyconcept rows (CIK 1321834, dei:EntityCommonStockSharesOutstanding), scraped Oct 24, 2026.
const real = [
  { end: '2017-11-10', val: 9920552, accn: '0001493152-17-013253', form: '10-Q', filed: '2017-11-14' },
  { end: '2018-03-15', val: 81973964, accn: '0001493152-18-004626', form: '10-K', filed: '2018-04-03' },
  { end: '2017-08-14', val: 8901245, accn: '0001493152-18-009974', form: '10-Q/A', filed: '2018-07-13' },
  { end: '2017-11-10', val: 9920552, accn: '0001493152-18-009976', form: '10-Q/A', filed: '2018-07-13' },
  { end: '2018-03-15', val: 81973964, accn: '0001493152-18-009979', form: '10-K/A', filed: '2018-07-13' },
  { end: '2018-07-13', val: 94106292, accn: '0001493152-18-009983', form: '10-Q', filed: '2018-07-13' },
  { end: '2023-11-10', val: 50900715, accn: '0001493152-23-041328', form: '10-Q', filed: '2023-11-14' },
  { end: '2024-03-29', val: 2157632, accn: '0001493152-24-012533', form: '10-K', filed: '2024-04-01' },
]

test('pointBefore on real SEC rows: a later amendment with an older count does not override the newer count', () => {
  const p = sharePoints(real)
  assert.equal(pointBefore(p, '2018-04-04').shares, 81973964)
  // On Jul 13, 2018 three amendments re-filed 2017 counts; on Jul 13 itself nothing from that day is usable yet.
  assert.equal(pointBefore(p, '2018-07-13').shares, 81973964)
  // Jul 14: the same-day 10-Q (as of Jul 13) is the most current count; the 10-Q/As (2017 as-of dates) are ignored.
  assert.equal(pointBefore(p, '2018-07-14').shares, 94106292)
  // A count is available only after its filing date, even after a 1-for-~24 reverse split.
  assert.equal(pointBefore(p, '2024-04-01').shares, 50900715)
  assert.equal(pointBefore(p, '2024-04-02').shares, 2157632)
})

test('pointBefore: amendment-only case would have picked a stale 2017 count under "latest filed"', () => {
  const p = sharePoints(real.filter((r) => r.accn !== '0001493152-18-009983'))
  assert.equal(pointBefore(p, '2018-07-14').shares, 81973964) // not the 10-Q/A's 8.9M from Aug 2017
})

// Split-adjusted closes are adjusted for every split up to the download date (Alpaca adjustment=split), so a
// later split is in every ratio. Build a 50M-share stock: count dated 2022-06-30, trade day 2022-09-15.
function series(splits) {
  // splits: [{ date, factor }] where factor = new shares per old share (1-for-25 reverse = 1/25, 2-for-1 = 2)
  const days = ['2022-06-30', '2022-09-15', '2023-03-01', '2023-09-01']
  const raw = new Map(), adjusted = new Map()
  for (const d of days) {
    const after = splits.filter((x) => x.date > d).reduce((m, x) => m * x.factor, 1) // splits after d, up to "today"
    raw.set(d, 2) // the raw price itself does not matter, only raw / adjusted
    adjusted.set(d, 2 / after)
  }
  return { raw, adjusted, days }
}
const fiftyM = (end) => ({ cik: '1', record: { cik: '1', entityName: 'Test Co', source: 'dei', points: [{ filed: '2022-07-15', end, shares: 50_000_000, form: '10-Q', accn: 'X' }] }, nameOk: true, annual: [{ form: '10-K', date: '2022-03-01' }] })

test('split adjustment never uses splits after the trade day: a 2023 reverse split does not shrink a 2022 count', () => {
  const r = edgarFloatOn(fiftyM('2022-06-30'), '2022-09-15', series([{ date: '2023-03-01', factor: 1 / 25 }]))
  assert.equal(r.shares, 50_000_000) // not 2M, so it still fails the 10M gate
  const forward = edgarFloatOn(fiftyM('2022-06-30'), '2022-09-15', series([{ date: '2023-03-01', factor: 2 }]))
  assert.equal(forward.shares, 50_000_000) // a later 2-for-1 does not change it either
})

test('split adjustment applies splits between the count date and the trade day only', () => {
  const r = edgarFloatOn(fiftyM('2022-06-30'), '2022-09-15', series([{ date: '2022-08-01', factor: 1 / 25 }, { date: '2023-03-01', factor: 2 }]))
  assert.ok(Math.abs(r.shares - 2_000_000) < 1e-6) // 1-for-25 in Aug 2022 applies; the 2023 2-for-1 does not
})

test('a count dated before the first daily bar is missing (no-split-data), never scaled by later splits alone', () => {
  const r = edgarFloatOn(fiftyM('2022-06-01'), '2022-09-15', series([{ date: '2023-03-01', factor: 2 }]))
  assert.equal(r.miss, 'no-split-data')
})
