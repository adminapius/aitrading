import { strategyGuardrails } from '@/lib/strategy'

/**
 * Strategy M (Midday). Shadow-only: entries 11:00-15:30 ET, every position closed by the existing 15:55 flatten.
 * Pure rules shared by the live shadow path and the offline backtest so both evaluate identical signals.
 */
export const STRATEGY_M_RULE = 'strategy_m'

export const MIDDAY_VARIANTS = ['vwap_reclaim', 'hod_break', 'ema_pullback'] as const
export type MiddayVariant = (typeof MIDDAY_VARIANTS)[number]

export const middayConfig = {
  entryStartMinute: 11 * 60,
  entryEndMinute: 15 * 60 + 30,
  flattenMinute: 15 * 60 + 55,
  minChangePercent: 10,
  minSessionBars: 60,
  minRiskFraction: 0.01,
  maxRiskFraction: 0.06,
  targetR: 2,
  volumeSurge: 1.5,
  volumeLookback: 20,
  vwapReclaim: { lookback: 30, minBarsBelow: 10, stopLookback: 15 },
  hodBreak: { baseBars: 20, maxBaseRangeFraction: 0.06 },
  emaPullback: { fast: 9, slow: 20, trendBars: 10, touchTolerance: 0.003, stopLookback: 5 },
  startingEquity: 2_000,
}

/** One closed regular-session 1-minute bar (t = bar start, epoch ms). */
export type MiddayBar = { t: number; o: number; h: number; l: number; c: number; v: number; vw?: number }

export type MiddaySignal = {
  variant: MiddayVariant
  triggerPrice: number
  stop: number
  target: number
  riskPerShare: number
  reason: string
}

export function easternMinuteOfDay(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return value('hour') * 60 + value('minute')
}

/** New M entries are allowed only from 11:00 up to (not including) 15:30 ET. */
export function isMiddayEntryWindow(now: Date) {
  const minute = easternMinuteOfDay(now)
  return minute >= middayConfig.entryStartMinute && minute < middayConfig.entryEndMinute
}

/** STRATEGY_M_SHADOW defaults to off; only an explicit true/1/yes/on enables it. */
export function strategyMShadowEnabled(env: Record<string, string | undefined> = process.env) {
  return /^(true|1|yes|on)$/i.test(env.STRATEGY_M_SHADOW?.trim() ?? '')
}

export function sessionVwap(bars: MiddayBar[]) {
  const out: number[] = []
  let volume = 0
  let priceVolume = 0
  for (const bar of bars) {
    const price = bar.vw ?? (bar.h + bar.l + bar.c) / 3
    volume += bar.v
    priceVolume += price * bar.v
    out.push(volume > 0 ? priceVolume / volume : bar.c)
  }
  return out
}

export function ema(values: number[], period: number) {
  const out: number[] = []
  const k = 2 / (period + 1)
  values.forEach((value, index) => out.push(index === 0 ? value : value * k + out[index - 1] * (1 - k)))
  return out
}

function volumeSurge(bars: MiddayBar[]) {
  const n = bars.length
  const prior = bars.slice(Math.max(0, n - 1 - middayConfig.volumeLookback), n - 1)
  if (!prior.length) return false
  const average = prior.reduce((sum, bar) => sum + bar.v, 0) / prior.length
  return average > 0 && bars[n - 1].v >= middayConfig.volumeSurge * average
}

/** Clamp risk to 1%-6% of price: a tighter structural stop is widened to 1%, a wider one rejects the setup. */
function levels(variant: MiddayVariant, triggerPrice: number, structuralStop: number, reason: string): MiddaySignal | null {
  if (!(triggerPrice > 0) || !(structuralStop > 0) || structuralStop >= triggerPrice) return null
  let risk = triggerPrice - structuralStop
  if (risk / triggerPrice > middayConfig.maxRiskFraction) return null
  risk = Math.max(risk, triggerPrice * middayConfig.minRiskFraction)
  return { variant, triggerPrice, stop: triggerPrice - risk, target: triggerPrice + risk * middayConfig.targetR, riskPerShare: risk, reason }
}

/**
 * Evaluate one variant on the regular-session bars closed so far (09:30 onward). Returns a signal only when the
 * latest closed bar completes the setup; the caller decides whether the entry window and ledger allow it.
 */
export function middaySignal(variant: MiddayVariant, bars: MiddayBar[], prevClose: number): MiddaySignal | null {
  const n = bars.length
  if (n < middayConfig.minSessionBars || !(prevClose > 0)) return null
  const last = bars[n - 1]
  const changePercent = (last.c / prevClose - 1) * 100
  if (changePercent < middayConfig.minChangePercent) return null
  const vwap = sessionVwap(bars)

  if (variant === 'vwap_reclaim') {
    const config = middayConfig.vwapReclaim
    const prev = bars[n - 2]
    if (!(prev.c < vwap[n - 2] && last.c > vwap[n - 1] && last.c > last.o)) return null
    let below = 0
    for (let index = Math.max(0, n - 1 - config.lookback); index < n - 1; index += 1) if (bars[index].c < vwap[index]) below += 1
    if (below < config.minBarsBelow || !volumeSurge(bars)) return null
    const stop = Math.min(...bars.slice(n - config.stopLookback).map((bar) => bar.l))
    return levels(variant, last.c, stop, `VWAP reclaim after ${below}/${config.lookback} bars below, change ${changePercent.toFixed(1)}%`)
  }

  if (variant === 'hod_break') {
    const config = middayConfig.hodBreak
    let hod = -Infinity
    let hodIndex = -1
    for (let index = 0; index < n - 1; index += 1) if (bars[index].h > hod) { hod = bars[index].h; hodIndex = index }
    if (!(last.c > hod) || n - 1 - hodIndex < config.baseBars) return null
    const base = bars.slice(n - 1 - config.baseBars, n - 1)
    const baseLow = Math.min(...base.map((bar) => bar.l))
    const baseHigh = Math.max(...base.map((bar) => bar.h))
    if ((baseHigh - baseLow) / hod > config.maxBaseRangeFraction || !(last.c > vwap[n - 1]) || !volumeSurge(bars)) return null
    return levels(variant, last.c, baseLow, `HOD ${hod.toFixed(4)} break after ${n - 1 - hodIndex}-bar base, change ${changePercent.toFixed(1)}%`)
  }

  const config = middayConfig.emaPullback
  const closes = bars.map((bar) => bar.c)
  const fast = ema(closes, config.fast)
  const slow = ema(closes, config.slow)
  for (let index = n - config.trendBars; index < n; index += 1) if (!(fast[index] > slow[index])) return null
  if (!(last.c > vwap[n - 1] && last.l <= slow[n - 1] * (1 + config.touchTolerance) && last.c > fast[n - 1] && last.c > last.o)) return null
  const stop = Math.min(...bars.slice(n - config.stopLookback).map((bar) => bar.l))
  return levels(variant, last.c, stop, `EMA${config.slow} pullback hold in EMA${config.fast}>EMA${config.slow} trend, change ${changePercent.toFixed(1)}%`)
}

/** First variant (in MIDDAY_VARIANTS order) that fires on these bars. */
export function firstMiddaySignal(variants: readonly MiddayVariant[], bars: MiddayBar[], prevClose: number) {
  for (const variant of variants) {
    const signal = middaySignal(variant, bars, prevClose)
    if (signal) return signal
  }
  return null
}

/** Risk 1% of the M ledger per trade, capped by the per-position exposure limit. */
export function middayShares(equity: number, fill: number, riskPerShare: number) {
  if (!(equity > 0) || !(fill > 0) || !(riskPerShare > 0)) return 0
  const byRisk = (equity * strategyGuardrails.riskPerTradeFraction) / riskPerShare
  const byExposure = (equity * strategyGuardrails.maxPositionFraction) / fill
  return Math.max(0, Math.floor(Math.min(byRisk, byExposure)))
}

/** Entry fill = ask plus slippage; levels are re-anchored to the fill so R stays the signal's risk per share. */
export function middayEntryLevels(signal: MiddaySignal, ask: number, slippageFraction: number) {
  const fill = ask * (1 + slippageFraction)
  return { fill, stop: Math.max(0.01, fill - signal.riskPerShare), target: fill + signal.riskPerShare * middayConfig.targetR }
}
