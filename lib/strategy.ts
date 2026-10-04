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

const MAX_POSITION_FRACTION = 0.2
const MAX_DAILY_LOSS_FRACTION = 0.03

export function scoreCandidate(candidate: ScanCandidate) {
  const rvol = candidate.averageVolume ? (candidate.volume ?? 0) / candidate.averageVolume : 0
  const catalysts = Number(Boolean(candidate.hasNews)) + Number((candidate.socialScore ?? 0) >= 60)
  const technicals = Number((candidate.changePercent ?? 0) > 2) + Number(candidate.vwap ? candidate.price > candidate.vwap : false)
  const normalizedFloat = normalizeFloatShares(candidate.float, candidate.floatSource)
  const liquidity = Number(rvol >= 2.5) + Number((normalizedFloat ?? Infinity) <= 10_000_000)
  return catalysts * 25 + technicals * 15 + liquidity * 10
}

export function decideEntry(candidate: ScanCandidate, equity: number): TradeDecision {
  const score = scoreCandidate(candidate)
  const atr = Math.max(candidate.atr ?? candidate.price * 0.02, 0.01)
  const riskPerShare = atr * 0.75
  const riskBudget = equity * MAX_DAILY_LOSS_FRACTION * 0.35
  const maxNotional = equity * MAX_POSITION_FRACTION
  const suggestedShares = Math.max(0, Math.floor(Math.min(riskBudget / riskPerShare, maxNotional / Math.max(candidate.price, 0.01))))
  if (score < 70 || suggestedShares < 1) return { action: 'hold', symbol: candidate.symbol, confidence: score / 100, reason: 'Candidate does not meet the multi-signal paper-trading threshold.', riskPerShare, suggestedShares: 0 }
  return { action: 'buy', symbol: candidate.symbol, confidence: Math.min(score / 100, 0.99), reason: 'Catalyst, relative volume, price action, and liquidity align.', riskPerShare, suggestedShares }
}

export function shouldExit(entryPrice: number, currentPrice: number, atr = entryPrice * 0.02) {
  const change = currentPrice - entryPrice
  return { exit: change >= atr * 1.5 || change <= -atr, reason: change >= atr * 1.5 ? 'profit target reached' : change <= -atr ? 'protective stop reached' : 'hold' }
}

export const strategyGuardrails = {
  mode: 'paper' as const,
  flattenBeforeEt: '15:55',
  maxPositionFraction: MAX_POSITION_FRACTION,
  maxDailyLossFraction: MAX_DAILY_LOSS_FRACTION,
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
