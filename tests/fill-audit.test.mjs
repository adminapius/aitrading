// E's fill audit (scripts/backtest/rulebook/audit.ts): the model the Friday report's adjusted R uses
// (docs/strategy-e-paper-run.md: adjusted R = min(paper R, model R), SP slippage, instant mode).
import assert from 'node:assert/strict'
import test from 'node:test'
import { INSTANT_DELAY_MS, modelTrade, sellFees } from '../scripts/backtest/rulebook/audit'
import { RULEBOOK } from '../scripts/backtest/rulebook/config'
import { EJW, SCAN_MINUTES } from '../scripts/backtest/windows'

const MID = Date.parse('2026-10-26T04:00:00Z') // ET midnight, Mon Oct 26, 2026 (EDT)
const M = 60_000
const at = (h, m, s = 0) => MID + (h * 60 + m) * M + s * 1000
const bar = (h, m, o, hi, lo, c) => ({ t: at(h, m), o, h: hi, l: lo, c })
const sp = (m) => (m < RULEBOOK.SP.regularOpenMinute ? RULEBOOK.SP.slippagePremarket : RULEBOOK.SP.slippage)
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)
const base = { trigger: 5, limit: 5.05, stop: 4.8, target: 5.3, flattenMs: null, slippage: sp, midnight: MID }

test('instant mode: fills at the SIP ask 2 s after sending + slippage; no fill above the limit or without a quote', () => {
  const bars = [bar(9, 50, 5, 5.05, 4.98, 5.02), bar(9, 51, 5.02, 5.31, 5.0, 5.25)]
  const send = at(9, 50, 10)
  const r = modelTrade(bars, { ...base, submitMs: send, instant: { ask: 5.01, at: send + INSTANT_DELAY_MS } })
  assert.equal(r.filled, true)
  close(r.entry, 5.01 * (1 + sp(590)))
  assert.equal(r.reason, 'target')
  close(r.exit, 5.3)
  assert.equal(modelTrade(bars, { ...base, submitMs: send, instant: { ask: 5.06, at: send + 2000 } }).filled, false)
  assert.match(modelTrade(bars, { ...base, submitMs: send, instant: { ask: null, at: send + 2000 } }).why, /no SIP quote/)
})

test('exits: fill-bar stop on a close at or below; gap stop at the open; stop before target; flatten at the real minute', () => {
  const send = at(10, 0, 5)
  const inst = { ask: 5.0, at: send + 2000 }
  const fillBarStop = modelTrade([bar(10, 0, 5, 5.02, 4.7, 4.75)], { ...base, submitMs: send, instant: inst })
  assert.equal(fillBarStop.reason, 'stop (fill bar)')
  const gap = modelTrade([bar(10, 0, 5, 5.02, 4.95, 5.0), bar(10, 1, 4.6, 4.7, 4.5, 4.6)], { ...base, submitMs: send, instant: inst })
  assert.equal(gap.reason, 'gap-stop'); close(gap.exit, 4.6 * (1 - sp(601)))
  const both = modelTrade([bar(10, 0, 5, 5.02, 4.95, 5.0), bar(10, 1, 5.0, 5.4, 4.7, 5.0)], { ...base, submitMs: send, instant: inst })
  assert.equal(both.reason, 'stop'); close(both.exit, 4.8 * (1 - sp(601)))
  const flat = modelTrade([bar(10, 0, 5, 5.02, 4.95, 5.0), bar(15, 29, 5.1, 5.2, 5.0, 5.1), bar(15, 30, 5.12, 5.2, 5.0, 5.1)], { ...base, submitMs: send, instant: inst, flattenMs: at(15, 30, 4) })
  assert.equal(flat.reason, 'flatten'); close(flat.exit, 5.12 * (1 - sp(930)))
})

test('fees on sells: SEC per dollar + FINRA TAF capped', () => {
  const C = RULEBOOK.costs
  close(sellFees(100, 5), 500 * C.secFeePerDollar + 100 * C.finraTafPerShare)
  close(sellFees(1e6, 1), 1e6 * C.secFeePerDollar + C.finraTafMaxPerTrade)
})

test('shared windows unchanged by the move out of the E-J runner', () => {
  assert.deepEqual({ start: EJW.start, end: EJW.end, windows: EJW.windows, lookback: EJW.historyLookbackDays, equity: EJW.equity }, { start: '2024-10-14', end: '2026-10-16', windows: { tuning: ['2024-10-14', '2026-07-31'], holdout: ['2026-08-01', '2026-10-16'] }, lookback: 57, equity: 2000 })
  assert.deepEqual(SCAN_MINUTES.slice(0, 6), [420, 435, 450, 465, 480, 485])
  assert.equal(SCAN_MINUTES.at(-1), 655)
})
