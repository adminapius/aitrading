import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchJson, isPermanentHttpError, retryDelayMs } from '../scripts/backtest/data'

test('retry backoff grows then caps at 60s', () => {
  assert.equal(retryDelayMs(0), 1_000)
  assert.equal(retryDelayMs(3), 8_000)
  assert.equal(retryDelayMs(6), 60_000)
  assert.equal(retryDelayMs(50), 60_000)
})

test('only real HTTP 4xx errors are permanent', () => {
  assert.equal(isPermanentHttpError(new Error('bars HTTP 403: forbidden'), 'bars'), true)
  assert.equal(isPermanentHttpError(new TypeError('fetch failed'), 'bars'), false)
})

test('a DNS outage (ENOTFOUND) is retried instead of killing the run', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls <= 2) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  try {
    const body = await fetchJson('https://example.test/x', 'probe', 'fmp')
    assert.deepEqual(body, { ok: true })
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = realFetch
  }
})
