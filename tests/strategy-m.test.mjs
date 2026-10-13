import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ema, isMiddayEntryWindow, middayConfig, middayEntryLevels, middaySignal, middayShares, strategyMShadowEnabled } from '../lib/strategies/midday-momentum'
import { strategyGuardrails } from '../lib/strategy'

const t0 = Date.parse('2026-10-13T13:30:00Z')
const bar = (i, o, h, l, c, v = 1_000) => ({ t: t0 + i * 60_000, o, h, l, c, v })
const close = (a, b) => Math.abs(a - b) < 1e-9

function hodBreakBars({ lastVolume = 3_000 } = {}) {
  const bars = []
  for (let i = 0; i < 10; i += 1) bars.push(bar(i, 5.7, 5.75, 5.65, 5.7))
  bars.push(bar(10, 5.8, 6.0, 5.8, 5.9))
  for (let i = 11; i < 70; i += 1) bars.push(bar(i, 5.85, 5.95, 5.8, 5.88))
  bars.push(bar(70, 5.9, 6.06, 5.9, 6.05, lastVolume))
  return bars
}

function vwapReclaimBars() {
  const bars = []
  for (let i = 0; i < 40; i += 1) bars.push(bar(i, 6.2, 6.25, 6.15, 6.2))
  for (let i = 40; i < 70; i += 1) bars.push(bar(i, 6.0, 6.05, 5.95, 6.0))
  bars.push(bar(70, 6.0, 6.32, 5.99, 6.3, 4_000))
  return bars
}

function emaPullbackBars({ touch = true } = {}) {
  const n = 70
  const closes = Array.from({ length: n }, (_, i) => 5.5 + 0.01 * i)
  const bars = closes.map((c, i) => bar(i, c - 0.005, c + 0.01, c - 0.01, c))
  const slow = ema(closes, middayConfig.emaPullback.slow)[n - 1]
  const last = bars[n - 1]
  last.o = closes[n - 2]
  last.l = touch ? slow - 0.01 : last.c - 0.002
  return bars
}

test('hod_break: break of a 60-bar-old HOD after a tight base, stop at base low, 2R target', () => {
  const signal = middaySignal('hod_break', hodBreakBars(), 5)
  assert.ok(signal)
  assert.equal(signal.variant, 'hod_break')
  assert.ok(close(signal.triggerPrice, 6.05))
  assert.ok(close(signal.stop, 5.8))
  assert.ok(close(signal.target, 6.05 + 2 * 0.25))
})

test('hod_break: no volume surge means no signal', () => {
  assert.equal(middaySignal('hod_break', hodBreakBars({ lastVolume: 1_000 }), 5), null)
})

test('vwap_reclaim: reclaim after 30 bars below VWAP, stop at 15-bar low, 2R target', () => {
  const signal = middaySignal('vwap_reclaim', vwapReclaimBars(), 5)
  assert.ok(signal)
  assert.ok(close(signal.triggerPrice, 6.3))
  assert.ok(close(signal.stop, 5.95))
  assert.ok(close(signal.target, 6.3 + 2 * 0.35))
})

test('vwap_reclaim: stock up less than 10% on the day is ignored', () => {
  assert.equal(middaySignal('vwap_reclaim', vwapReclaimBars(), 6), null)
})

test('ema_pullback: touch of EMA20 in an EMA9>EMA20 trend; stop at 5-bar low', () => {
  const bars = emaPullbackBars()
  const signal = middaySignal('ema_pullback', bars, 5)
  assert.ok(signal)
  const last = bars.at(-1)
  assert.ok(close(signal.stop, last.l))
  assert.ok(close(signal.target, last.c + 2 * (last.c - last.l)))
})

test('ema_pullback: no touch of EMA20 means no signal', () => {
  assert.equal(middaySignal('ema_pullback', emaPullbackBars({ touch: false }), 5), null)
})

test('fewer than 60 session bars never signals', () => {
  assert.equal(middaySignal('hod_break', hodBreakBars().slice(-50), 5), null)
})

test('risk clamp: stop under 1% is widened to 1%, stop over 6% rejects', () => {
  const tight = hodBreakBars()
  for (let i = 50; i < 70; i += 1) Object.assign(tight[i], { h: 5.995, l: 5.995, c: 5.995, o: 5.995 })
  tight[70] = bar(70, 5.99, 6.01, 5.99, 6.0, 3_000)
  tight[10].h = 5.997
  const narrow = middaySignal('hod_break', tight, 5)
  assert.ok(narrow)
  assert.ok(close(narrow.riskPerShare, 6.0 * middayConfig.minRiskFraction))

  const wide = vwapReclaimBars()
  wide[60].l = 5.5
  assert.equal(middaySignal('vwap_reclaim', wide, 5), null)
})

test('entry levels re-anchor to ask + slippage and keep 2R; shares respect 1% risk and exposure cap', () => {
  const signal = { variant: 'hod_break', triggerPrice: 6, stop: 5.8, target: 6.4, riskPerShare: 0.2, reason: '' }
  const levels = middayEntryLevels(signal, 6.02, 0.001)
  assert.ok(close(levels.fill, 6.02 * 1.001))
  assert.ok(close(levels.stop, levels.fill - 0.2))
  assert.ok(close(levels.target, levels.fill + 0.4))
  const shares = middayShares(2_000, levels.fill, 0.2)
  assert.ok(shares > 0)
  assert.ok(shares * 0.2 <= 2_000 * strategyGuardrails.riskPerTradeFraction + 1e-9)
  assert.ok(shares * levels.fill <= 2_000 * strategyGuardrails.maxPositionFraction + 1e-9)
})

test('entry window is 11:00 inclusive to 15:30 exclusive ET', () => {
  assert.equal(isMiddayEntryWindow(new Date('2026-10-13T14:59:00Z')), false)
  assert.equal(isMiddayEntryWindow(new Date('2026-10-13T15:00:00Z')), true)
  assert.equal(isMiddayEntryWindow(new Date('2026-10-13T19:29:00Z')), true)
  assert.equal(isMiddayEntryWindow(new Date('2026-10-13T19:30:00Z')), false)
  assert.equal(isMiddayEntryWindow(new Date('2026-12-14T16:00:00Z')), true)
})

test('STRATEGY_M_SHADOW defaults off', () => {
  assert.equal(strategyMShadowEnabled({}), false)
  assert.equal(strategyMShadowEnabled({ STRATEGY_M_SHADOW: '' }), false)
  assert.equal(strategyMShadowEnabled({ STRATEGY_M_SHADOW: 'false' }), false)
  assert.equal(strategyMShadowEnabled({ STRATEGY_M_SHADOW: 'yes please' }), false)
  assert.equal(strategyMShadowEnabled({ STRATEGY_M_SHADOW: 'true' }), true)
  assert.equal(strategyMShadowEnabled({ STRATEGY_M_SHADOW: ' ON ' }), true)
})

test('flag off = no change: the worker only touches Strategy M inside the flag guard and omits it from the response', () => {
  const source = readFileSync(new URL('../app/api/worker/run/route.ts', import.meta.url), 'utf8')
  const calls = source.split('runMiddayShadowPass(').length - 1
  assert.equal(calls, 1)
  const guard = source.indexOf('if (strategyMShadowEnabled()) {')
  const call = source.indexOf('runMiddayShadowPass(')
  assert.ok(guard > 0 && call > guard && call - guard < 200)
  assert.match(source, /\.\.\.\(middayShadow \? \{ middayShadow \} : \{\}\)/)
  const shadowModule = readFileSync(new URL('../lib/strategies/midday-shadow.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(shadowModule, /alpaca-broker|alpaca-execution|\/v2\/orders/)
})
