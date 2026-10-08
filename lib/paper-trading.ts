import { alpacaHeaders, supabaseHeaders, tradingConfig } from './trading-config.ts'
import { scanConfig } from './scan-config.ts'
export { paperExitLevels, paperExitReason, paperExitRequestedPrice } from './paper-exits.ts'

export type PaperPosition = {
  id: string
  symbol: string
  opened_at?: string
  quantity: number | string
  entry_price: number | string
  current_price?: number | string | null
  stop_price?: number | string | null
  target_price?: number | string | null
  unrealized_pnl?: number | string | null
  metadata?: Record<string, unknown> | null
}

export type PaperMarketMark = {
  symbol: string
  price: number
  bid: number
  ask: number
  at: string
}

type PaperRpcResult = {
  status: string
  reason?: string
  positionId?: string
  tradeId?: string
  quantity?: number
  fillPrice?: number
  realizedPnl?: number
}

function numeric(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function isFreshPaperMarketMark(value: unknown, now = new Date()): value is PaperMarketMark {
  if (!value || typeof value !== 'object') return false
  const mark = value as Partial<PaperMarketMark>
  const at = typeof mark.at === 'string' ? Date.parse(mark.at) : Number.NaN
  return typeof mark.symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,9}$/.test(mark.symbol)
    && Number.isFinite(mark.price) && Number(mark.price) > 0
    && Number.isFinite(mark.bid) && Number(mark.bid) > 0
    && Number.isFinite(mark.ask) && Number(mark.ask) >= Number(mark.bid)
    && Number.isFinite(at) && now.getTime() >= at && now.getTime() - at <= scanConfig.maxQuoteAgeSeconds * 1_000
}

async function callPaperRpc(name: string, body: Record<string, unknown>): Promise<PaperRpcResult> {
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase paper execution RPC ${name} failed (${response.status}); apply the paper-trading migration before enabling the loop`)
  return await response.json() as PaperRpcResult
}

export async function loadOpenPaperPositions(): Promise<PaperPosition[]> {
  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_positions`)
  url.search = new URLSearchParams({
    select: 'id,symbol,quantity,entry_price,current_price,stop_price,target_price,unrealized_pnl,metadata',
    status: 'eq.open',
    order: 'opened_at.asc',
  }).toString()
  const response = await fetch(url, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5_000), cache: 'no-store' })
  if (!response.ok) throw new Error(`Paper position read failed (${response.status})`)
  return await response.json() as PaperPosition[]
}

export async function markPaperPosition(positionId: string, price: number) {
  return callPaperRpc('mark_ait_paper_position', { p_position_id: positionId, p_mark_price: price })
}

export async function openPaperPosition(input: {
  sessionId: string
  scanId: string
  symbol: string
  quantity: number
  requestedPrice: number
  fillPrice: number
  stopPrice: number
  targetPrice: number
  riskPerShare: number
  idempotencyKey: string
  maxPositionFraction: number
  maxAggregateExposureFraction: number
  riskPerTradeFraction: number
  maxDailyLossFraction: number
  maxOpenPositions: number
  minimumMarginEquity: number
  reentryCooldownMinutes: number
  entryMetadata: Record<string, unknown>
}) {
  return callPaperRpc('open_ait_paper_position', {
    p_session_id: input.sessionId,
    p_scan_id: input.scanId,
    p_symbol: input.symbol,
    p_quantity: input.quantity,
    p_requested_price: input.requestedPrice,
    p_fill_price: input.fillPrice,
    p_stop_price: input.stopPrice,
    p_target_price: input.targetPrice,
    p_risk_per_share: input.riskPerShare,
    p_idempotency_key: input.idempotencyKey,
    p_max_position_fraction: input.maxPositionFraction,
    p_max_aggregate_exposure_fraction: input.maxAggregateExposureFraction,
    p_risk_per_trade_fraction: input.riskPerTradeFraction,
    p_max_daily_loss_fraction: input.maxDailyLossFraction,
    p_max_open_positions: input.maxOpenPositions,
    p_minimum_margin_equity: input.minimumMarginEquity,
    p_reentry_cooldown_minutes: input.reentryCooldownMinutes,
    p_entry_metadata: input.entryMetadata,
  })
}

export async function closePaperPosition(input: {
  sessionId: string
  positionId: string
  fillPrice: number
  exitReason: string
  idempotencyKey: string
  exitMetadata: Record<string, unknown>
}) {
  return callPaperRpc('close_ait_paper_position', {
    p_session_id: input.sessionId,
    p_position_id: input.positionId,
    p_fill_price: input.fillPrice,
    p_exit_reason: input.exitReason,
    p_idempotency_key: input.idempotencyKey,
    p_exit_metadata: input.exitMetadata,
  })
}

export async function loadFreshPaperMarketMarks(symbols: string[], now = new Date()): Promise<Map<string, PaperMarketMark>> {
  const uniqueSymbols = [...new Set(symbols.filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)))].slice(0, 50)
  if (!uniqueSymbols.length) return new Map()

  const url = new URL(`${tradingConfig.alpacaDataUrl}/v2/stocks/snapshots`)
  url.search = new URLSearchParams({ symbols: uniqueSymbols.join(','), feed: tradingConfig.alpacaDataFeed }).toString()
  const response = await fetch(url, { headers: alpacaHeaders(), signal: AbortSignal.timeout(8_000), cache: 'no-store' })
  if (!response.ok) throw new Error(`Open-position quote request failed (${response.status})`)
  const snapshots = await response.json() as Record<string, {
    latestQuote?: { bp?: number; ap?: number; t?: string }
    latestTrade?: { p?: number; t?: string }
  }>
  const marks = new Map<string, PaperMarketMark>()
  for (const symbol of uniqueSymbols) {
    const quote = snapshots[symbol]?.latestQuote
    const bid = numeric(quote?.bp)
    const ask = numeric(quote?.ap)
    const at = typeof quote?.t === 'string' ? quote.t : ''
    const price = bid != null && ask != null ? (bid + ask) / 2 : null
    const mark = { symbol, price: price ?? 0, bid: bid ?? 0, ask: ask ?? 0, at }
    if (isFreshPaperMarketMark(mark, now)) marks.set(symbol, mark)
  }
  return marks
}

export function normalizePaperMarketMarks(value: unknown, now = new Date()) {
  const marks = new Map<string, PaperMarketMark>()
  if (!Array.isArray(value)) return marks
  for (const item of value) {
    if (isFreshPaperMarketMark(item, now)) marks.set(item.symbol, item)
  }
  return marks
}

export function positionExposure(positions: PaperPosition[]) {
  return positions.reduce((sum, position) => sum + (numeric(position.quantity) ?? 0) * (numeric(position.current_price) ?? numeric(position.entry_price) ?? 0), 0)
}

export function paperExecutionGuardrails() {
  return {
    mode: 'paper-margin',
    liveTradingEnabled: false,
    slippageFraction: 0.0005,
    marginMultiplier: 2,
  } as const
}

export function validatePaperExecutionRuntime() {
  return tradingConfig.mode === 'paper' && tradingConfig.liveTradingEnabled === false
}

export function marketMarkFromCandidate(symbol: string, bid: unknown, ask: unknown, at: unknown, now = new Date()): PaperMarketMark | null {
  const numericBid = numeric(bid)
  const numericAsk = numeric(ask)
  const mark = {
    symbol,
    price: numericBid != null && numericAsk != null ? (numericBid + numericAsk) / 2 : 0,
    bid: numericBid ?? 0,
    ask: numericAsk ?? 0,
    at: typeof at === 'string' ? at : '',
  }
  return isFreshPaperMarketMark(mark, now) ? mark : null
}

export function _paperTradingTypes() {
  return null
}
