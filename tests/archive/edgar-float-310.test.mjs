// ARCHIVED (Oct 25, 2026): the parked E-J $3-10 runner's enterable-day screen. Not part of npm test.
import assert from 'node:assert/strict'
import test from 'node:test'
import { enterableDays } from '../../scripts/backtest/archive/strategy-ej-310'

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
