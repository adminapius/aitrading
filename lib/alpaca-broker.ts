// Thin Alpaca Trading API client for the paper account. Every call goes through `brokerFetch`
// so tests can replace the network. This module never decides WHAT to trade — only how to talk
// to Alpaca safely.

import { alpacaHeaders, tradingConfig } from '@/lib/trading-config'

export type ExecutionMode = 'internal' | 'alpaca'

/** EXECUTION_MODE=alpaca sends Strategy E's orders to the Alpaca paper account; anything else keeps the internal simulation. */
export function executionMode(env: Record<string, string | undefined> = process.env): ExecutionMode {
  return env.EXECUTION_MODE?.trim().toLowerCase() === 'alpaca' ? 'alpaca' : 'internal'
}

/** TRADING_HALT=true is the kill switch: no new entries are sent anywhere. Open positions stay protected and are still flattened at 15:55. */
export function tradingHalted(env: Record<string, string | undefined> = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(env.TRADING_HALT?.trim().toLowerCase() ?? '')
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
let brokerFetch: FetchLike = (input, init) => fetch(input, init)

/** Test hook: replace the network layer. */
export function setBrokerFetch(fn: FetchLike | null) {
  brokerFetch = fn ?? ((input, init) => fetch(input, init))
}

export class AlpacaError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 8_000): Promise<T> {
  const response = await brokerFetch(`${tradingConfig.alpacaBaseUrl}${path}`, {
    method,
    headers: { ...alpacaHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'message' in parsed ? String((parsed as { message: unknown }).message) : text.slice(0, 200)
    throw new AlpacaError(`Alpaca ${method} ${path} failed (${response.status}): ${message}`, response.status, parsed)
  }
  return parsed as T
}

export type AlpacaAccount = {
  status: string
  equity: string
  cash: string
  buying_power: string
  trading_blocked?: boolean
  account_blocked?: boolean
  account_number?: string
}

export type AlpacaOrder = {
  id: string
  client_order_id: string
  symbol: string
  side: 'buy' | 'sell'
  type: string
  order_class?: string
  status: string
  qty: string | null
  filled_qty: string
  filled_avg_price: string | null
  limit_price?: string | null
  stop_price?: string | null
  submitted_at?: string
  filled_at?: string | null
  legs?: AlpacaOrder[] | null
}

export type AlpacaPosition = { symbol: string; qty: string; avg_entry_price: string; current_price?: string; side: string }

export type MarketClock = { isOpen: boolean; nextClose: string | null; minutesToClose: number | null; nextOpen: string | null; minutesToOpen: number | null }

export type GateResult =
  | { ok: true; equity: number; buyingPower: number; accountNumber: string | null; clock: MarketClock }
  | { ok: false; reason: string }

/** Key + host checks only (no network). Enough to allow the safety flatten even if the account call fails. */
export function paperCredentialsCheck(env: Record<string, string | undefined> = process.env): { ok: true } | { ok: false; reason: string } {
  const key = env.ALPACA_API_KEY?.trim() ?? ''
  if (!key.startsWith('PK')) return { ok: false, reason: 'ALPACA_API_KEY is not a paper key (paper keys start with PK); no orders sent.' }
  if (!/^https:\/\/paper-api\.alpaca\.markets$/.test(tradingConfig.alpacaBaseUrl)) return { ok: false, reason: `ALPACA_BASE_URL must be https://paper-api.alpaca.markets (got ${tradingConfig.alpacaBaseUrl}); no orders sent.` }
  return { ok: true }
}

export function marketClock(clock: { is_open: boolean; next_close?: string | null; next_open?: string | null; timestamp?: string }, now: Date): MarketClock {
  const nextClose = clock.next_close ?? null
  const nextOpen = clock.next_open ?? null
  const closeAt = nextClose ? Date.parse(nextClose) : Number.NaN
  const openAt = nextOpen ? Date.parse(nextOpen) : Number.NaN
  return {
    isOpen: Boolean(clock.is_open),
    nextClose,
    minutesToClose: clock.is_open && Number.isFinite(closeAt) ? (closeAt - now.getTime()) / 60_000 : null,
    nextOpen,
    minutesToOpen: !clock.is_open && Number.isFinite(openAt) ? (openAt - now.getTime()) / 60_000 : null,
  }
}

/**
 * Refuses to trade unless every check proves this is the PAPER account:
 * paper key prefix (PK), paper API host, and an ACTIVE, unblocked account. Also returns the market
 * clock so holidays and early closes come from Alpaca, not a hard-coded schedule.
 */
export async function checkPaperGate(env: Record<string, string | undefined> = process.env, now = new Date()): Promise<GateResult> {
  const credentials = paperCredentialsCheck(env)
  if (!credentials.ok) return credentials
  try {
    const [account, clock] = await Promise.all([call<AlpacaAccount>('GET', '/v2/account'), getClock()])
    if (account.status !== 'ACTIVE') return { ok: false, reason: `Alpaca paper account status is ${account.status}; no orders sent.` }
    if (account.trading_blocked || account.account_blocked) return { ok: false, reason: 'Alpaca paper account is blocked from trading; no orders sent.' }
    const equity = Number(account.equity)
    if (!Number.isFinite(equity) || equity <= 0) return { ok: false, reason: 'Alpaca paper account equity is not valid; no orders sent.' }
    return { ok: true, equity, buyingPower: Number(account.buying_power) || 0, accountNumber: account.account_number ?? null, clock: marketClock(clock, now) }
  } catch (error) {
    return { ok: false, reason: `Alpaca account check failed: ${error instanceof Error ? error.message : 'unknown error'}` }
  }
}

/** Alpaca accepts 2 decimals at/above $1 and 4 decimals below $1. */
export function roundPrice(price: number, direction: 'up' | 'down' | 'nearest' = 'nearest') {
  const factor = price >= 1 ? 100 : 10_000
  const scaled = price * factor
  const rounded = direction === 'up' ? Math.ceil(scaled - 1e-9) : direction === 'down' ? Math.floor(scaled + 1e-9) : Math.round(scaled)
  return rounded / factor
}

/** Alpaca client_order_id max length is 128; keep ours short, unique and readable. */
export function clientOrderId(kind: 'e' | 'x' | 'p' | 't', parts: string[]) {
  return `ait-${kind}-${parts.join('-')}`.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
}

export function getAccount() {
  return call<AlpacaAccount>('GET', '/v2/account')
}

export function getClock() {
  return call<{ is_open: boolean; timestamp: string; next_open: string; next_close: string }>('GET', '/v2/clock')
}

export function submitOrder(order: Record<string, unknown>) {
  return call<AlpacaOrder>('POST', '/v2/orders', order)
}

export function getOrder(id: string) {
  return call<AlpacaOrder>('GET', `/v2/orders/${encodeURIComponent(id)}?nested=true`)
}

/** Finds an order by our client order id (used when a submit timed out). Null when Alpaca never received it. */
export async function getOrderByClientId(clientId: string) {
  try {
    return await call<AlpacaOrder>('GET', `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientId)}`)
  } catch (error) {
    if (error instanceof AlpacaError && error.status === 404) return null
    throw error
  }
}

/** Submits an order; if the request fails without a clear rejection, checks whether Alpaca accepted it anyway. */
export async function submitOrderSafely(order: Record<string, unknown> & { client_order_id: string }) {
  try {
    return await submitOrder(order)
  } catch (error) {
    // A 4xx with a body is a real rejection. Timeouts / 5xx may have been accepted: look it up.
    if (error instanceof AlpacaError && error.status >= 400 && error.status < 500) throw error
    const existing = await getOrderByClientId(order.client_order_id).catch(() => null)
    if (existing) return existing
    throw error
  }
}

export async function cancelOrder(id: string) {
  try {
    await call<null>('DELETE', `/v2/orders/${encodeURIComponent(id)}`)
    return true
  } catch (error) {
    // 422 = already filled/canceled; that is fine, the caller re-reads the order.
    if (error instanceof AlpacaError && (error.status === 422 || error.status === 404)) return false
    throw error
  }
}

export function listOrders(params: { status: 'open' | 'closed' | 'all'; symbols?: string[]; after?: string; limit?: number }) {
  const search = new URLSearchParams({ status: params.status, nested: 'true', direction: 'desc', limit: String(params.limit ?? 100) })
  if (params.symbols?.length) search.set('symbols', params.symbols.join(','))
  if (params.after) search.set('after', params.after)
  return call<AlpacaOrder[]>('GET', `/v2/orders?${search.toString()}`)
}

export function listPositions() {
  return call<AlpacaPosition[]>('GET', '/v2/positions')
}

/** Market-close every position and cancel every open order (used only by the 15:55 flatten). */
export function closeAllPositions() {
  return call<Array<{ symbol: string; status: number; body?: AlpacaOrder }>>('DELETE', '/v2/positions?cancel_orders=true', undefined, 15_000)
}

export function closePosition(symbol: string, qty?: number) {
  return call<AlpacaOrder>('DELETE', `/v2/positions/${encodeURIComponent(symbol)}${qty ? `?qty=${qty}` : ''}`)
}

const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'done_for_day', 'replaced', 'stopped', 'suspended'])
export function isTerminal(order: AlpacaOrder) {
  return TERMINAL.has(order.status)
}

type Sleep = (ms: number) => Promise<void>
let sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export function setBrokerSleep(fn: Sleep | null) {
  sleep = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
}

/** Poll an order until it is filled/terminal or the time budget runs out. */
export async function waitForOrder(id: string, budgetMs: number, intervalMs = 1_000) {
  let order = await getOrder(id)
  let waited = 0
  while (!isTerminal(order) && waited < budgetMs) {
    await sleep(intervalMs)
    waited += intervalMs
    order = await getOrder(id)
  }
  return order
}

/** Every filled order in an order tree (parent + nested legs). */
export function flattenOrderTree(order: AlpacaOrder): AlpacaOrder[] {
  return [order, ...(order.legs ?? []).flatMap(flattenOrderTree)]
}
