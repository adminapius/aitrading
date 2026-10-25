import assert from 'node:assert/strict'
import test from 'node:test'
import { alpacaTicker, asofFor, isCommonStock, normalizeCompanyName, parseCikLine, resolveTicker } from '../scripts/backtest/u1-delisted'

test('isCommonStock: drops preferreds, units, warrants, rights, notes and funds', () => {
  assert.equal(isCommonStock({ symbol: 'ABCD', companyName: 'Abcd Therapeutics, Inc.' }), true)
  assert.equal(isCommonStock({ symbol: 'BIRD', companyName: 'Allbirds, Inc.' }), true, '4 letters ending in D/R are fine')
  assert.equal(isCommonStock({ symbol: 'CAR', companyName: 'Avis Budget Group' }), true, '3 letters ending in R are fine')
  assert.equal(isCommonStock({ symbol: 'ABCDW', companyName: 'Abcd Acquisition Corp' }), false, '5-letter W = warrant')
  assert.equal(isCommonStock({ symbol: 'ABCDU', companyName: 'Abcd Acquisition Corp' }), false, '5-letter U = unit')
  assert.equal(isCommonStock({ symbol: 'XYZ-PA', companyName: 'XYZ Corp' }), false)
  assert.equal(isCommonStock({ symbol: 'XYZ', companyName: 'XYZ Corp 6.5% Series A Preferred Stock' }), false)
  assert.equal(isCommonStock({ symbol: 'XYZW', companyName: 'XYZ Warrants' }), false)
  assert.equal(isCommonStock({ symbol: 'FUNX', companyName: 'Some Income Fund' }), false)
  assert.equal(isCommonStock({ symbol: 'NOTE', companyName: 'XYZ 5.25% Senior Notes due 2028' }), false)
  assert.equal(isCommonStock({ symbol: '', companyName: 'x' }), false)
  // Oct 25 probe leaks: mutual funds (X), Nasdaq preferreds (P/O/N/M), convertibles
  for (const s of ['CAEAX', 'JIGZX', 'TSAGX', 'MTBCO', 'OCESP', 'AUBAP', 'MPLXP', 'ABCDN', 'ABCDM', 'ABCDG']) assert.equal(isCommonStock({ symbol: s, companyName: 'Xyz' }), false, s)
  // second probe (Oct 25): closed-end and ETF trusts named without "Fund"
  for (const n of ['Bitwise Funds Trust', 'MFS High Income Municipal Trust', 'Nuveen New York Select Tax-Free Income Portfolio']) assert.equal(isCommonStock({ symbol: 'ABC', companyName: n }), false, n)
  for (const n of ['The Duckhorn Portfolio, Inc.', 'Medical Properties Trust, Inc.', 'Whitestone REIT']) assert.equal(isCommonStock({ symbol: 'ABC', companyName: n }), true, n)
  for (const s of ['BHLLD', 'ABCDA', 'ABCDF', 'ABCDY', 'CWEN-A']) assert.equal(isCommonStock({ symbol: s, companyName: 'Xyz Inc' }), true, s)
})

test('alpacaTicker: FMP class shares use a dot at Alpaca', () => {
  assert.equal(alpacaTicker('cwen-a'), 'CWEN.A')
  assert.equal(alpacaTicker('BRK.B'), 'BRK.B')
  assert.equal(alpacaTicker('XYZ-PA'), 'XYZ-PA')
  assert.equal(alpacaTicker('ABCD'), 'ABCD')
})

test('asofFor: the calendar day before the delisting date', () => {
  assert.equal(asofFor('2025-03-14'), '2025-03-13')
  assert.equal(asofFor('2025-03-01'), '2025-02-28')
  assert.equal(asofFor('2024-01-01 00:00:00'), '2023-12-31')
})

test('normalizeCompanyName: FMP and EDGAR spellings meet', () => {
  assert.equal(normalizeCompanyName('Acme Therapeutics, Inc.'), 'ACME THERAPEUTICS')
  assert.equal(normalizeCompanyName('ACME THERAPEUTICS INC /DE/'), 'ACME THERAPEUTICS')
  assert.equal(normalizeCompanyName('The Widget Co.'), 'WIDGET')
  assert.equal(normalizeCompanyName('Smith & Jones Holdings Ltd'), 'SMITH AND JONES HOLDINGS')
  assert.equal(normalizeCompanyName('Inc'), 'INC', 'a one-word name is kept')
})

test('parseCikLine: NAME:CIK: lines, names may contain colons', () => {
  assert.deepEqual(parseCikLine('ACME THERAPEUTICS INC:1234567:'), ['ACME THERAPEUTICS INC', '0001234567'])
  assert.deepEqual(parseCikLine('A:B HOLDINGS:0000000042:'), ['A:B HOLDINGS', '0000000042'])
  assert.equal(parseCikLine('garbage'), null)
})

test('resolveTicker: plain symbol, then a delisted entity until its asof date, then renames (chains)', () => {
  const bars = { NEWCO: new Set(['2025-05-01', '2025-01-02']), 'OLD@2025-03-13': new Set(['2025-02-03']), 'ZZZ@2025-09-30': new Set(['2025-01-15']) }
  const hasBar = (k, d) => Boolean(bars[k]?.has(d))
  const entities = [{ key: 'OLD@2025-03-13', ticker: 'OLD', asof: '2025-03-13' }, { key: 'ZZZ@2025-09-30', ticker: 'ZZZ', asof: '2025-09-30' }]
  const renames = [{ old: 'ABC', new: 'NEWCO', date: '2025-03-01', name: '' }, { old: 'QQA', new: 'QQB', date: '2025-02-01', name: '' }, { old: 'QQB', new: 'ZZZ', date: '2025-06-01', name: '' }]
  assert.deepEqual(resolveTicker('NEWCO', '2025-05-01', hasBar, entities, renames), { key: 'NEWCO', how: 'plain' })
  assert.deepEqual(resolveTicker('OLD', '2025-02-03', hasBar, entities, renames), { key: 'OLD@2025-03-13', how: 'delisted' })
  assert.equal(resolveTicker('OLD', '2025-04-01', hasBar, entities, renames).how, 'missing', 'after its asof date')
  assert.deepEqual(resolveTicker('ABC', '2025-01-02', hasBar, entities, renames), { key: 'NEWCO', how: 'rename' })
  assert.equal(resolveTicker('ABC', '2025-05-01', hasBar, entities, renames).how, 'missing', 'the rename happened before that day')
  assert.deepEqual(resolveTicker('QQA', '2025-01-15', hasBar, entities, renames), { key: 'ZZZ@2025-09-30', how: 'rename' }, 'QQA -> QQB -> ZZZ (later delisted)')
})
