// Assistant mode must never place, change or cancel an order (docs/assistant-mode-spec.md, principle 1), and its
// service must never call E's worker or scan routes.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { accountMode, accountProblem, keyProblem } from '../lib/assistant/config'

const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p] })
const files = [...walk('lib/assistant'), ...walk('app/api/assistant'), ...walk('app/assistant'), 'assistant-worker/main.py']

test('no assistant file imports the order code or names an order endpoint', () => {
  for (const f of files) {
    const s = readFileSync(f, 'utf8')
    assert.doesNotMatch(s, /alpaca-broker|alpaca-execution|paper-trading'|strategies\/live-strategy/, `${f} imports trading code`)
    assert.doesNotMatch(s, /\/v2\/orders|\/v2\/positions|closeAllPositions|submitOrder|placeOrder/, `${f} names an order endpoint`)
  }
})

test('the Alpaca client for the manual account sends GET only', () => {
  const s = readFileSync('lib/assistant/alpaca-read.ts', 'utf8')
  assert.match(s, /method: 'GET'/)
  assert.doesNotMatch(s, /'POST'|'DELETE'|'PATCH'|'PUT'/)
})

test('the assistant service never calls E\'s worker or scan routes', () => {
  const s = readFileSync('assistant-worker/main.py', 'utf8')
  assert.doesNotMatch(s, /["']\/api\/worker|["']\/api\/scan|["']\/api\/cron/)
  for (const path of s.match(/"\/api\/[a-z/]+"/g) ?? []) assert.match(path, /^"\/api\/assistant\//)
})

test('A1: refuses E\'s keys and E\'s account', () => {
  assert.match(keyProblem('', '', 'EKEY'), /must be set/)
  assert.match(keyProblem('EKEY', 's', 'EKEY'), /Strategy E's key/)
  assert.equal(keyProblem('MKEY', 's', 'EKEY'), null)
  assert.match(accountProblem({ id: 'a' }, { id: 'a' }), /Strategy E's Alpaca account/)
  assert.match(accountProblem({ id: 'a', account_number: 'PA1' }, { id: 'b', account_number: 'PA1' }), /Strategy E/)
  assert.equal(accountProblem({ id: 'a', account_number: 'PA1' }, { id: 'b', account_number: 'PA2' }), null)
  assert.match(accountProblem(null, { id: 'b' }), /could not be read/)
  assert.equal(accountMode('https://paper-api.alpaca.markets'), 'paper')
  assert.equal(accountMode('https://api.alpaca.markets'), 'live')
})
