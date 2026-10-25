import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Isolated cache: the data cache root is taken from the working directory when the module loads.
const repo = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'edgar-float-'))
process.chdir(dir)
process.env.SEC_USER_AGENT = 'Test Runner test@example.com'
process.env.FMP_API_KEY = 'test'
const ef = await import(join(repo, 'scripts/backtest/edgar-float.ts'))
test.after(() => { process.chdir(repo); rmSync(dir, { recursive: true, force: true }) })

const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const TICKERS = { 0: { cik_str: 101, ticker: 'NOUNITS' }, 1: { cik_str: 102, ticker: 'NOSHARES' }, 2: { cik_str: 103, ticker: 'GONE' }, 3: { cik_str: 104, ticker: 'BAD' }, 4: { cik_str: 105, ticker: 'GOOD' } }
const submissions = { filings: { recent: { form: ['10-K'], filingDate: ['2021-03-01'], items: [''], acceptanceDateTime: ['2021-03-01T20:00:00.000Z'], accessionNumber: ['0000000000-21-000001'] } } }
const goodShares = { cik: 105, entityName: 'Good Co Inc', units: { shares: [{ end: '2022-06-30', val: 5_000_000, accn: 'G1', form: '10-Q', filed: '2022-07-15' }] } }
let badResponse = '<html>Request Rate Threshold Exceeded</html>'

globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.endsWith('/files/company_tickers.json')) return json(TICKERS)
  if (u.includes('/submissions/')) return json(submissions)
  const cik = /CIK(\d{10})/.exec(u)?.[1]
  if (cik === '0000000101') return json({ cik: 101, entityName: 'Nounits Corp', taxonomy: 'dei' }) // no units at all
  if (cik === '0000000102') return json({ cik: 102, entityName: 'Noshares Corp', units: { USD: [{ end: '2022-06-30', val: 1, accn: 'X', filed: '2022-07-01' }] } }) // units, no shares
  if (cik === '0000000103') return json({ message: 'not found' }, 404) // every concept 404
  if (cik === '0000000104') return json(badResponse) // 200 with a body that is not JSON
  if (cik === '0000000105') return json(goodShares)
  return json({}, 404)
}

const names = new Map([['NOUNITS', 'Nounits Corp'], ['NOSHARES', 'Noshares Corp'], ['GONE', 'Gone Inc'], ['BAD', 'Bad Data Inc'], ['GOOD', 'Good Co Inc']])
const cacheFile = (cik) => join(dir, '.cache', 'backtest', 'sec', 'v4', 'shares', `${cik}.json.gz`)

test('sharePoints treats a missing or non-array units.shares as no data', () => {
  for (const value of [undefined, null, {}, 'x', 5, { 0: { val: 1 } }]) assert.deepEqual(ef.sharePoints(value), [])
  assert.deepEqual(ef.sharePoints([null, 'x', { val: 5 }]), [])
})

test('response with no units -> no value (not a crash, not an error)', async () => {
  const data = await ef.loadEdgarFloat(['NOUNITS'], names)
  const d = data.get('NOUNITS')
  assert.equal(d.error, undefined)
  assert.equal(ef.edgarFloatOn(d, '2022-09-01').miss, 'no-value')
  assert.ok(ef.edgarIssues.noSharesShape >= 1)
})

test('response with units but no shares -> no value', async () => {
  const d = (await ef.loadEdgarFloat(['NOSHARES'], names)).get('NOSHARES')
  assert.equal(d.error, undefined)
  assert.equal(ef.edgarFloatOn(d, '2022-09-01').miss, 'no-value')
})

test('a 404 on every concept -> no value; the run continues', async () => {
  const d = (await ef.loadEdgarFloat(['GONE'], names)).get('GONE')
  assert.equal(d.error, undefined) // SEC's documented answer for a concept the company never reported
  assert.equal(ef.edgarFloatOn(d, '2022-09-01').miss, 'no-value')
})

test('a bad response is sec-error, does not stop the run, is not cached, and is retried on the next run', async () => {
  const before = ef.edgarIssues.errors
  const data = await ef.loadEdgarFloat(['BAD', 'GOOD'], names) // BAD first: GOOD must still load
  assert.equal(ef.edgarFloatOn(data.get('BAD'), '2022-09-01').miss, 'sec-error')
  assert.equal(ef.edgarFloatOn(data.get('GOOD'), '2022-09-01').shares, 5_000_000)
  assert.equal(ef.edgarIssues.errors, before + 1)
  assert.equal(existsSync(cacheFile('0000000104')), false) // the error was not cached
  assert.equal(existsSync(cacheFile('0000000105')), true)
  badResponse = { ...goodShares, cik: 104, entityName: 'Bad Data Inc' } // SEC answers properly on the rerun
  const again = await ef.loadEdgarFloat(['BAD'], names)
  assert.equal(again.get('BAD').error, undefined)
  assert.equal(ef.edgarFloatOn(again.get('BAD'), '2022-09-01').shares, 5_000_000)
})
