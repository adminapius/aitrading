export type ScanCandidate = {
  symbol: string
  price: number
  bid?: number
  ask?: number
  volume?: number
  averageVolume?: number
  float?: number
  floatSource?: 'fmp' | 'finnhub'
  changePercent?: number
  vwap?: number
  atr?: number
  hasNews?: boolean
  socialScore?: number
}

export function normalizeFloatShares(value: number | null | undefined, source: ScanCandidate['floatSource'] = 'fmp') {
  if (!Number.isFinite(value) || value == null) return undefined
  return source === 'finnhub' ? value * 1_000_000 : value
}

export type TradeDecision = {
  action: 'buy' | 'sell' | 'hold'
  symbol: string
  confidence: number
  reason: string
  riskPerShare: number
  suggestedShares: number
}

const MAX_POSITION_FRACTION = 0.9
const MAX_DAILY_LOSS_FRACTION = 0.04
const RISK_PER_TRADE_FRACTION = 0.02

function easternTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now)
  return { hour: Number(parts.find((part) => part.type === 'hour')?.value ?? 0), minute: Number(parts.find((part) => part.type === 'minute')?.value ?? 0) }
}

export function strategyRegime(now = new Date()) {
  const { hour, minute } = easternTime(now)
  const minutes = hour * 60 + minute
  if (minutes < 8 * 60) return { name: 'news-reaction', rvol: 2, volume: 100_000, dollarVolume: 500_000, spread: 0.01, score: 70, sizeFraction: 0.5 }
  if (minutes < 9 * 60 + 30) return { name: 'premarket-continuation', rvol: 2.5, volume: 250_000, dollarVolume: 1_000_000, spread: 0.01, score: 70, sizeFraction: 1 }
  if (minutes < 11 * 60) return { name: 'opening-momentum', rvol: 3, volume: 500_000, dollarVolume: 2_000_000, spread: 0.0075, score: 75, sizeFraction: 1 }
  if (minutes < 13 * 60) return { name: 'midday-selective', rvol: 4, volume: 750_000, dollarVolume: 3_000_000, spread: 0.005, score: 80, sizeFraction: 0.5 }
  if (minutes < 15 * 60 + 30) return { name: 'late-continuation', rvol: 3.5, volume: 500_000, dollarVolume: 2_000_000, spread: 0.0075, score: 75, sizeFraction: 0.75 }
  return { name: 'exits-only', rvol: Infinity, volume: Infinity, dollarVolume: Infinity, spread: 0, score: Infinity, sizeFraction: 0 }
}

export function scoreCandidate(candidate: ScanCandidate, now = new Date()) {
  const regime = strategyRegime(now)
  const rvol = candidate.averageVolume ? (candidate.volume ?? 0) / candidate.averageVolume : 0
  const dollarVolume = (candidate.volume ?? 0) * candidate.price
  const spread = candidate.bid && candidate.ask && candidate.price > 0 ? (candidate.ask - candidate.bid) / candidate.price : Infinity
  const catalysts = Number(Boolean(candidate.hasNews)) + Number((candidate.socialScore ?? 0) >= 60)
  const technicals = Number((candidate.changePercent ?? 0) > 2) + Number(candidate.vwap ? candidate.price > candidate.vwap : false)
  const normalizedFloat = normalizeFloatShares(candidate.float, candidate.floatSource)
  const liquidity = Number(rvol >= regime.rvol) + Number((normalizedFloat ?? Infinity) <= 10_000_000) + Number((candidate.volume ?? 0) >= regime.volume) + Number(dollarVolume >= regime.dollarVolume) + Number(spread <= regime.spread)
  return catalysts * 25 + technicals * 15 + liquidity * 10
}

export function decideEntry(candidate: ScanCandidate, equity: number, now = new Date(), availableAllocation = equity * MAX_POSITION_FRACTION): TradeDecision {
  const regime = strategyRegime(now)
  const score = scoreCandidate(candidate, now)
  const atr = Math.max(candidate.atr ?? candidate.price * 0.02, 0.01)
  const riskPerShare = atr
  const riskBudget = equity * RISK_PER_TRADE_FRACTION * regime.sizeFraction
  const maxNotional = Math.min(equity * MAX_POSITION_FRACTION * regime.sizeFraction, Math.max(0, availableAllocation))
  const suggestedShares = Math.max(0, Math.floor(Math.min(riskBudget / riskPerShare, maxNotional / Math.max(candidate.price, 0.01))))
  if (regime.name === 'exits-only' || score < regime.score || suggestedShares < 1) return { action: 'hold', symbol: candidate.symbol, confidence: score / 100, reason: `${regime.name}: candidate failed time-of-day, liquidity, catalyst, or technical threshold.`, riskPerShare, suggestedShares: 0 }
  return { action: 'buy', symbol: candidate.symbol, confidence: Math.min(score / 100, 0.99), reason: `${regime.name}: catalyst, relative volume, liquidity, price action, and spread align.`, riskPerShare, suggestedShares }
}

export function shouldExit(entryPrice: number, currentPrice: number, atr = entryPrice * 0.02) {
  const change = currentPrice - entryPrice
  return { exit: change >= atr * 1.5 || change <= -atr, reason: change >= atr * 1.5 ? 'profit target reached' : change <= -atr ? 'protective stop reached' : 'hold' }
}

export const strategyGuardrails = {
  mode: 'paper' as const,
  flattenBeforeEt: '15:55',
  maxPositionFraction: MAX_POSITION_FRACTION,
  maxAggregateExposureFraction: MAX_POSITION_FRACTION,
  maxDailyLossFraction: MAX_DAILY_LOSS_FRACTION,
  riskPerTradeFraction: RISK_PER_TRADE_FRACTION,
  entryMonitorSeconds: 10,
  liveTradingEnabled: false,
}

export function isTradingWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  return hour >= 7 && (hour < 15 || (hour === 15 && minute < 55))
}

export function isFlattenWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  return hour === 15 && minute >= 55
}
