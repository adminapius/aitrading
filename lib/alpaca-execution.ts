// Routes the live strategy's entries to the Alpaca PAPER account and keeps the Supabase ledger in
// step with what Alpaca actually filled. Strategy decisions (what/when/how many) are made elsewhere
// and are not changed here.
//
// Lifecycle of one trade:
//   0. Pre-flight: the ledger's own rules (symbol already open, max positions, daily loss stop,
//      re-entry cooldown, exposure at the limit price) are checked BEFORE anything is sent.
//   1. Entry: marketable limit BUY (ask + 0.3%), wait up to 8s, cancel any remainder.
//   2. Ledger: record the position at Alpaca's real fill price/quantity (idempotency key = client order id).
//   3. Protection (regular hours): OCO SELL at Alpaca = stop + target resting at the broker.
//      Pre-market (Alpaca rejects stop orders outside regular hours): the app watches the price and
//      sends an extended-hours sell limit when the stop/target is crossed; the OCO goes on at the open.
//   4. Exit: whatever Alpaca fills (stop, target, flatten, manual) is read back each scan and closed
//      in the ledger at Alpaca's fill price.
//   5. Close-5min (15:55 normally, earlier on half days): cancel all orders, market-close everything.
// Anything the app cannot track or protect is closed rather than left open.

import {
  AlpacaError,
  cancelOrder,
  clientOrderId,
  closeAllPositions,
  closePosition,
  getOrder,
  flattenOrderTree,
  isTerminal,
  listOrders,
  listPositions,
  roundPrice,
  submitOrderSafely,
  waitForOrder,
  type AlpacaOrder,
  type AlpacaPosition,
  type MarketClock,
} from '@/lib/alpaca-broker'
import { sendTradingNotification } from '@/lib/notifications'
import { closePaperPosition, openPaperPosition, paperExitReason, paperExitLevels, type PaperMarketMark, type PaperPosition } from '@/lib/paper-trading'
import { easternSchedule } from '@/lib/strategy'
import { easternDayStart } from '@/lib/strategies/live-strategy'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export const ENTRY_LIMIT_BUFFER = 0.003
export const ENTRY_FILL_WAIT_MS = 8_000
export const CANCEL_CONFIRM_WAIT_MS = 6_000
export const PREMARKET_EXIT_LIMIT_BUFFER = 0.005
export const FLATTEN_WAIT_MS = 20_000
/** Flatten this many minutes before Alpaca's next close (15:55 on normal days, 12:55 on half days). */
export const FLATTEN_MINUTES_BEFORE_CLOSE = 5
/** Pre-market entries only when Alpaca's next open is within this window (blocks holidays/weekends). */
export const PREMARKET_MAX_MINUTES_TO_OPEN = 150
/** Stop starting new broker entries after this much of the 60s worker budget is used. */
export const ENTRY_DEADLINE_MS = 35_000
/** After the ledger refuses a filled broker entry, no new broker entries in that symbol for this long. */
export const LEDGER_REFUSAL_COOLDOWN_MINUTES = 15
/** The orphan sweep leaves test-harness shares alone this long (the harness closes its own). */
export const TEST_ORDER_GRACE_MS = 3 * 60_000
const FLATTEN_MINUTE = 15 * 60 + 55
const OUR_ORDER = /^ait-[epxt]-/

export const EXIT_REASONS = {
  stop: 'protective stop reached',
  target: 'profit target reached',
  flatten: 'scheduled session flatten',
  manual: 'closed in Alpaca outside the app',
} as const

export function isAlpacaPosition(position: Pick<PaperPosition, 'metadata'>) {
  return position.metadata?.broker === 'alpaca'
}

/** Regular session per Alpaca's clock (handles holidays and half days). */
export function isRegularSession(clock: MarketClock) {
  return clock.isOpen
}

/** Pre-market on a real trading day: market closed but Alpaca opens within the next 2.5 hours. */
export function isPremarketSession(clock: MarketClock) {
  return !clock.isOpen && clock.minutesToOpen != null && clock.minutesToOpen > 0 && clock.minutesToOpen <= PREMARKET_MAX_MINUTES_TO_OPEN
}

/** True in the last minutes before Alpaca's close (or the fixed 15:55 window from the schedule). */
export function isBrokerFlattenTime(clock: MarketClock | null, scheduleFlatten: boolean) {
  if (scheduleFlatten) return true
  return Boolean(clock?.isOpen && clock.minutesToClose != null && clock.minutesToClose <= FLATTEN_MINUTES_BEFORE_CLOSE)
}

type OrderEvent = {
  sessionId?: string | null
  scanId?: string | null
  positionId?: string | null
  symbol: string
  event: string
  side?: 'buy' | 'sell' | null
  qty?: number | null
  price?: number | null
  clientOrderId?: string | null
  brokerOrderId?: string | null
  brokerStatus?: string | null
  test?: boolean
  payload?: Record<string, unknown>
}

/** Append-only audit log of every broker interaction. Never throws. */
export async function logOrderEvent(event: OrderEvent) {
  try {
    const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_order_events`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        session_id: event.sessionId ?? null,
        scan_id: event.scanId ?? null,
        position_id: event.positionId ?? null,
        symbol: event.symbol,
        event: event.event,
        side: event.side ?? null,
        qty: event.qty ?? null,
        price: event.price ?? null,
        client_order_id: event.clientOrderId ?? null,
        broker_order_id: event.brokerOrderId ?? null,
        broker_status: event.brokerStatus ?? null,
        test: event.test ?? false,
        payload: event.payload ?? {},
      }),
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    })
    if (!response.ok) console.error('[alpaca] order event write failed', { status: response.status, event: event.event, symbol: event.symbol })
  } catch (error) {
    console.error('[alpaca] order event write failed', { event: event.event, symbol: event.symbol, error })
  }
}

async function alert(title: string, message: string) {
  await sendTradingNotification({ title, message }).catch((error) => console.error('[alpaca] alert failed', { title, error }))
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Stop below and target above the actual fill, same R-multiples the simulation uses. */
export function protectiveLevels(fillPrice: number, riskPerShare: number) {
  return {
    stopPrice: Math.max(0.01, roundPrice(fillPrice - riskPerShare, 'down')),
    targetPrice: roundPrice(fillPrice + riskPerShare * 1.5, 'up'),
  }
}

// ---------------------------------------------------------------------------------------------
// Pre-flight: the same rules the ledger RPC enforces, checked before a real order is sent.
// ---------------------------------------------------------------------------------------------

export type EntryPreflightState = {
  openSymbols: Set<string>
  openCount: number
  maxOpenPositions: number
  dailyLossStopped: boolean
  cooldownSymbols: Set<string>
}

export function entryBlockReason(state: EntryPreflightState, symbol: string): string | null {
  if (state.dailyLossStopped) return 'daily loss guardrail reached'
  if (state.openSymbols.has(symbol)) return 'position already open for symbol'
  if (state.openCount >= state.maxOpenPositions) return 'maximum open positions reached'
  if (state.cooldownSymbols.has(symbol)) return 're-entry cooldown after protective stop'
  return null
}

/** Reads session start equity and recent stop-outs; throws so callers fail closed. */
export async function loadEntryPreflightState(input: { sessionId: string; now: Date; equity: number; openSymbols: Iterable<string>; openCount: number; maxOpenPositions: number; maxDailyLossFraction: number; reentryCooldownMinutes: number }): Promise<EntryPreflightState> {
  const sessionUrl = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_sessions`)
  sessionUrl.search = new URLSearchParams({ select: 'starting_equity', id: `eq.${input.sessionId}`, limit: '1' }).toString()
  const stopsUrl = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_trades`)
  stopsUrl.search = new URLSearchParams({
    select: 'symbol',
    side: 'eq.sell',
    status: 'eq.filled',
    'metadata->>exitReason': `eq.${EXIT_REASONS.stop}`,
    filled_at: `gte.${new Date(input.now.getTime() - input.reentryCooldownMinutes * 60_000).toISOString()}`,
  }).toString()
  const refusedUrl = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_order_events`)
  refusedUrl.search = new URLSearchParams({
    select: 'symbol',
    event: 'eq.entry_ledger_blocked',
    created_at: `gte.${new Date(input.now.getTime() - LEDGER_REFUSAL_COOLDOWN_MINUTES * 60_000).toISOString()}`,
  }).toString()
  const [sessionResponse, stopsResponse, refusedResponse] = await Promise.all([
    fetch(sessionUrl, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5_000), cache: 'no-store' }),
    fetch(stopsUrl, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5_000), cache: 'no-store' }),
    fetch(refusedUrl, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5_000), cache: 'no-store' }),
  ])
  if (!sessionResponse.ok || !stopsResponse.ok || !refusedResponse.ok) throw new Error(`Entry pre-flight read failed (${sessionResponse.status}/${stopsResponse.status}/${refusedResponse.status})`)
  const [session] = await sessionResponse.json() as Array<{ starting_equity: number | string | null }>
  const startEquity = Number(session?.starting_equity)
  const stops = await stopsResponse.json() as Array<{ symbol: string }>
  const refused = await refusedResponse.json() as Array<{ symbol: string }>
  return {
    openSymbols: new Set(input.openSymbols),
    openCount: input.openCount,
    maxOpenPositions: input.maxOpenPositions,
    dailyLossStopped: Number.isFinite(startEquity) && startEquity > 0 && input.equity - startEquity <= -(startEquity * input.maxDailyLossFraction),
    cooldownSymbols: new Set([...stops, ...refused].map((row) => row.symbol)),
  }
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

export async function placeProtection(input: { symbol: string; qty: number; stopPrice: number; targetPrice: number; positionId?: string | null; sessionId?: string | null; scanId?: string | null; test?: boolean }) {
  const coid = clientOrderId('p', [(input.positionId ?? 'test').slice(0, 8), input.symbol, Date.now().toString(36)])
  const order = await submitOrderSafely({
    symbol: input.symbol,
    qty: String(input.qty),
    side: 'sell',
    type: 'limit',
    time_in_force: 'day',
    order_class: 'oco',
    take_profit: { limit_price: String(input.targetPrice) },
    stop_loss: { stop_price: String(input.stopPrice) },
    client_order_id: coid,
  })
  await logOrderEvent({ sessionId: input.sessionId, scanId: input.scanId, positionId: input.positionId, symbol: input.symbol, event: 'protection_placed', side: 'sell', qty: input.qty, price: input.stopPrice, clientOrderId: coid, brokerOrderId: order.id, brokerStatus: order.status, test: input.test, payload: { stopPrice: input.stopPrice, targetPrice: input.targetPrice } })
  return order
}

/** Cancels open SELL orders for a symbol and waits until Alpaca confirms each, so the shares are free. */
export async function cancelOpenSellsConfirmed(symbol: string, only?: (order: AlpacaOrder) => boolean) {
  const open = await listOrders({ status: 'open', symbols: [symbol] })
  const sells = open.filter((order) => order.side === 'sell' && (!only || only(order)))
  for (const order of sells) await cancelOrder(order.id)
  for (const order of sells) {
    const final = await waitForOrder(order.id, 3_000).catch(() => null)
    if (!final || !isTerminal(final)) return false
  }
  return true
}

/** Current long quantity at Alpaca; flags a short so it is never treated as a long. */
async function heldAtBroker(symbol: string) {
  const position = (await listPositions()).find((item) => item.symbol === symbol)
  if (!position) return { qty: 0, short: false }
  const qty = Number(position.qty) || 0
  return { qty: Math.abs(qty), short: position.side === 'short' || qty < 0 }
}

export type AppExitCode = 'stop' | 'tgt' | 'unw' | 'orph' | 'excess'

/**
 * Sells up to `qty` shares now — never more than Alpaca currently holds long, so it cannot open a short.
 * Regular session: DELETE /v2/positions/{symbol}?qty= (a partial close can never flip the position).
 * Pre-market: extended-hours limit below the reference price, capped at the shares held.
 * The reason code is logged against the broker order id so the ledger records why it closed.
 */
export async function exitNow(input: { symbol: string; qty: number; regular: boolean; code: AppExitCode; refPrice: number | null; cancelSells: boolean; base?: Partial<OrderEvent>; test?: boolean }): Promise<AlpacaOrder | null> {
  if (input.cancelSells && !(await cancelOpenSellsConfirmed(input.symbol))) throw new Error('resting sell orders did not cancel in time')
  const held = await heldAtBroker(input.symbol)
  if (held.short) throw new Error(`${input.symbol} is SHORT at Alpaca`)
  const qty = Math.min(Math.floor(input.qty), held.qty)
  if (qty <= 0) return null
  let order: AlpacaOrder
  if (input.regular) {
    order = await closePosition(input.symbol, qty)
  } else {
    if (input.refPrice == null || !(input.refPrice > 0)) throw new Error(`No price to place a pre-market sell for ${input.symbol}`)
    const coid = clientOrderId('x', [input.code, input.symbol, Date.now().toString(36)])
    order = await submitOrderSafely({ symbol: input.symbol, qty: String(qty), side: 'sell', type: 'limit', time_in_force: 'day', extended_hours: true, limit_price: String(roundPrice(input.refPrice * (1 - PREMARKET_EXIT_LIMIT_BUFFER), 'down')), client_order_id: coid })
  }
  await logOrderEvent({ ...input.base, symbol: input.symbol, event: 'app_exit_sent', side: 'sell', qty, brokerOrderId: order.id, clientOrderId: order.client_order_id, brokerStatus: order.status, test: input.test, payload: { reason: input.code } })
  return order
}

/** Immediately exits shares the app cannot track or protect. */
async function unwind(input: { symbol: string; qty: number; refPrice: number; regular: boolean; base: Partial<OrderEvent>; why: string }) {
  try {
    const order = await exitNow({ symbol: input.symbol, qty: input.qty, refPrice: input.refPrice, regular: input.regular, code: 'unw', cancelSells: true, base: input.base })
    await logOrderEvent({ ...input.base, symbol: input.symbol, event: 'unwind_submitted', side: 'sell', qty: input.qty, brokerOrderId: order?.id ?? null, payload: { why: input.why } })
    await alert(`AItrading: ${input.symbol} unwound`, `Sold ${input.qty} ${input.symbol} at Alpaca immediately because the ${input.why}.`)
  } catch (error) {
    await logOrderEvent({ ...input.base, symbol: input.symbol, event: 'unwind_failed', payload: { why: input.why, error: errorText(error) } })
    await alert(`AItrading: ${input.symbol} NEEDS ATTENTION`, `Could not sell ${input.qty} ${input.symbol} at Alpaca automatically (${input.why}). Close it manually. ${errorText(error)}`)
  }
}

export type BrokerEntryInput = {
  sessionId: string
  scanId: string
  symbol: string
  quantity: number
  ask: number
  riskPerShare: number
  clock: MarketClock
  /** Most dollars this entry may use (position cap / exposure / buying power), checked at the LIMIT price. */
  maxNotional: number
  guardrails: {
    maxPositionFraction: number
    maxAggregateExposureFraction: number
    riskPerTradeFraction: number
    maxDailyLossFraction: number
    maxOpenPositions: number
    minimumMarginEquity: number
    reentryCooldownMinutes: number
  }
  entryMetadata: Record<string, unknown>
}

export type BrokerEntryResult = {
  status: 'filled' | 'unfilled' | 'blocked' | 'rejected' | 'ledger_blocked' | 'protection_failed' | 'error'
  reason?: string
  positionId?: string
  fillPrice?: number
  quantity?: number
  stopPrice?: number
  targetPrice?: number
  brokerOrderId?: string
  clientOrderId?: string
}

/** Sends one entry to Alpaca and records it in the ledger only once Alpaca has filled it. */
export async function enterViaAlpaca(input: BrokerEntryInput): Promise<BrokerEntryResult> {
  const regular = isRegularSession(input.clock)
  if (!regular && !isPremarketSession(input.clock)) return { status: 'blocked', reason: 'Market is not in a regular or pre-market session per Alpaca clock.' }
  const limitPrice = roundPrice(input.ask * (1 + ENTRY_LIMIT_BUFFER), 'up')
  const quantity = Math.min(input.quantity, Math.floor(Math.max(0, input.maxNotional) / limitPrice))
  if (quantity < 1) return { status: 'blocked', reason: `No room for even 1 share at the $${limitPrice} limit within exposure/buying-power limits.` }
  const coid = clientOrderId('e', [input.scanId.slice(0, 8), input.symbol])
  const base = { sessionId: input.sessionId, scanId: input.scanId, symbol: input.symbol, clientOrderId: coid }

  let order: AlpacaOrder
  try {
    order = await submitOrderSafely({ symbol: input.symbol, qty: String(quantity), side: 'buy', type: 'limit', time_in_force: 'day', limit_price: String(limitPrice), extended_hours: !regular, client_order_id: coid })
  } catch (error) {
    await logOrderEvent({ ...base, event: 'entry_rejected', side: 'buy', qty: quantity, price: limitPrice, payload: { error: errorText(error), body: error instanceof AlpacaError ? error.body : null } })
    return { status: 'rejected', reason: errorText(error), clientOrderId: coid }
  }
  await logOrderEvent({ ...base, event: 'entry_submitted', side: 'buy', qty: quantity, price: limitPrice, brokerOrderId: order.id, brokerStatus: order.status, payload: { ask: input.ask, extendedHours: !regular, requestedQty: input.quantity } })

  try {
    order = await waitForOrder(order.id, ENTRY_FILL_WAIT_MS)
    if (order.status !== 'filled') {
      await cancelOrder(order.id)
      order = await waitForOrder(order.id, CANCEL_CONFIRM_WAIT_MS)
    }
  } catch (error) {
    await cancelOrder(order.id).catch(() => undefined)
    await logOrderEvent({ ...base, event: 'entry_status_error', brokerOrderId: order.id, payload: { error: errorText(error) } })
    await alert(`AItrading: ${input.symbol} entry status unknown`, `Could not confirm Alpaca order ${order.id}; cancel requested. Any shares it filled will be closed by the next scan. ${errorText(error)}`)
    return { status: 'error', reason: errorText(error), brokerOrderId: order.id, clientOrderId: coid }
  }
  if (!isTerminal(order)) {
    await logOrderEvent({ ...base, event: 'entry_cancel_unconfirmed', brokerOrderId: order.id, brokerStatus: order.status, payload: { filledQty: order.filled_qty } })
    return { status: 'error', reason: `Cancel not confirmed (status ${order.status}); next scan will close any filled shares.`, brokerOrderId: order.id, clientOrderId: coid }
  }

  const filledQty = Math.floor(Number(order.filled_qty) || 0)
  const fillPrice = Number(order.filled_avg_price)
  if (filledQty <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) {
    await logOrderEvent({ ...base, event: 'entry_unfilled', side: 'buy', qty: quantity, price: limitPrice, brokerOrderId: order.id, brokerStatus: order.status })
    return { status: 'unfilled', reason: `Limit $${limitPrice} not filled within ${ENTRY_FILL_WAIT_MS / 1000}s; order canceled.`, brokerOrderId: order.id, clientOrderId: coid }
  }
  await logOrderEvent({ ...base, event: 'entry_filled', side: 'buy', qty: filledQty, price: fillPrice, brokerOrderId: order.id, brokerStatus: order.status, payload: { requestedQty: quantity, limitPrice } })

  const { stopPrice, targetPrice } = protectiveLevels(fillPrice, input.riskPerShare)
  const ledger = await openPaperPosition({
    sessionId: input.sessionId,
    scanId: input.scanId,
    symbol: input.symbol,
    quantity: filledQty,
    requestedPrice: input.ask,
    fillPrice,
    stopPrice,
    targetPrice,
    riskPerShare: input.riskPerShare,
    idempotencyKey: coid,
    ...input.guardrails,
    entryMetadata: {
      ...input.entryMetadata,
      broker: 'alpaca',
      brokerOrderId: order.id,
      clientOrderId: coid,
      limitPrice,
      requestedQty: input.quantity,
      extendedHours: !regular,
      protection: regular ? 'alpaca-oco' : 'app-managed-until-open',
    },
  }).catch((error) => ({ status: 'error', reason: errorText(error) } as { status: string; reason?: string; positionId?: string }))

  if (ledger.status !== 'filled' && ledger.status !== 'already_executed') {
    // Recorded so the pre-flight blocks this symbol for a while (no buy-then-sell loop).
    await logOrderEvent({ ...base, event: 'entry_ledger_blocked', brokerOrderId: order.id, payload: { reason: ledger.reason ?? ledger.status } })
    await unwind({ symbol: input.symbol, qty: filledQty, refPrice: fillPrice, regular, base, why: `ledger refused the entry (${ledger.reason ?? ledger.status})` })
    return { status: 'ledger_blocked', reason: ledger.reason ?? ledger.status, brokerOrderId: order.id, clientOrderId: coid }
  }
  const positionId = ledger.positionId
  await logOrderEvent({ ...base, positionId, event: 'ledger_opened', side: 'buy', qty: filledQty, price: fillPrice, brokerOrderId: order.id })

  if (regular) {
    try {
      await placeProtection({ symbol: input.symbol, qty: filledQty, stopPrice, targetPrice, positionId, sessionId: input.sessionId, scanId: input.scanId })
    } catch (error) {
      await logOrderEvent({ ...base, positionId, event: 'protection_failed', payload: { error: errorText(error) } })
      await unwind({ symbol: input.symbol, qty: filledQty, refPrice: fillPrice, regular, base: { ...base, positionId }, why: `stop/target could not be placed (${errorText(error)})` })
      return { status: 'protection_failed', reason: errorText(error), positionId, fillPrice, quantity: filledQty, brokerOrderId: order.id, clientOrderId: coid }
    }
  }
  await alert(`AItrading: BUY ${input.symbol}`, `Alpaca paper filled ${filledQty} ${input.symbol} @ $${fillPrice.toFixed(2)} · stop $${stopPrice} · target $${targetPrice}${regular ? '' : ' (pre-market: app watches the stop until the open)'}`)
  return { status: 'filled', positionId, fillPrice, quantity: filledQty, stopPrice, targetPrice, brokerOrderId: order.id, clientOrderId: coid }
}

/** Reason for a broker sell: the app's logged reason if we sent it, else our client order id or the order type. */
export function exitReasonForOrder(order: Pick<AlpacaOrder, 'client_order_id' | 'type' | 'order_class' | 'filled_at'>, appCode?: AppExitCode | null): string {
  if (appCode === 'stop') return EXIT_REASONS.stop
  if (appCode === 'tgt') return EXIT_REASONS.target
  if (appCode) return EXIT_REASONS.manual
  const coid = order.client_order_id ?? ''
  if (coid.startsWith('ait-x-stop-')) return EXIT_REASONS.stop
  if (coid.startsWith('ait-x-tgt-')) return EXIT_REASONS.target
  if (coid.startsWith('ait-x-')) return EXIT_REASONS.manual
  if (order.type === 'stop' || order.type === 'stop_limit' || order.type === 'trailing_stop') return EXIT_REASONS.stop
  if (order.type === 'limit' && (coid.startsWith('ait-p-') || order.order_class === 'oco')) return EXIT_REASONS.target
  if (order.filled_at) {
    // Market sells we did not tag come from the close flatten (15:55, or 12:55 on half days).
    const minute = easternSchedule(new Date(order.filled_at)).minuteOfDay
    if (minute >= FLATTEN_MINUTE || (minute >= 12 * 60 + 55 && minute < 13 * 60 + 5)) return EXIT_REASONS.flatten
  }
  return EXIT_REASONS.manual
}

/** All filled SELL orders (including OCO legs) for a symbol after a time, newest first. */
export function filledSells(orders: AlpacaOrder[], symbol: string, afterIso?: string) {
  const after = afterIso ? Date.parse(afterIso) : Number.NEGATIVE_INFINITY
  return orders
    .flatMap(flattenOrderTree)
    .filter((order) => order.symbol === symbol && order.side === 'sell' && Number(order.filled_qty) > 0 && order.filled_avg_price != null)
    .filter((order) => !order.filled_at || Date.parse(order.filled_at) >= after)
    .sort((a, b) => Date.parse(b.filled_at ?? '') - Date.parse(a.filled_at ?? ''))
}

/** Reason codes the app logged for its own exit orders, keyed by broker order id. */
async function loadAppExitCodes(orderIds: string[]) {
  const codes = new Map<string, AppExitCode>()
  if (!orderIds.length) return codes
  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_order_events`)
  url.search = new URLSearchParams({ select: 'broker_order_id,payload', event: 'eq.app_exit_sent', broker_order_id: `in.(${orderIds.map((id) => `"${id}"`).join(',')})` }).toString()
  try {
    const response = await fetch(url, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5_000), cache: 'no-store' })
    if (!response.ok) return codes
    for (const row of await response.json() as Array<{ broker_order_id: string; payload: { reason?: AppExitCode } }>) {
      if (row.payload?.reason) codes.set(row.broker_order_id, row.payload.reason)
    }
  } catch (error) {
    console.warn('[alpaca] exit-reason lookup failed; falling back to order types', error)
  }
  return codes
}

/** How many times an order event was logged for a position in the last N minutes (0 on read failure). */
async function recentEventCount(event: string, positionId: string, minutes: number) {
  try {
    const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_order_events`)
    url.search = new URLSearchParams({ select: 'id', event: `eq.${event}`, position_id: `eq.${positionId}`, created_at: `gte.${new Date(Date.now() - minutes * 60_000).toISOString()}` }).toString()
    const response = await fetch(url, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5_000), cache: 'no-store' })
    return response.ok ? ((await response.json()) as unknown[]).length : 0
  } catch {
    return 0
  }
}

function isRetryableBrokerError(error: unknown) {
  return error instanceof AlpacaError ? error.status === 429 || error.status >= 500 : true
}

export type ReconcileClose = { position: PaperPosition; fillPrice: number; exitReason: string; realizedPnl: number; quantity: number }
export type ReconcileResult = {
  closes: ReconcileClose[]
  protectionPlaced: string[]
  exitsSent: string[]
  orphansClosed: string[]
  warnings: string[]
  /** Symbols Alpaca holds (long or short) — the pre-flight treats them as open. */
  brokerSymbols: Set<string>
  /** Symbols with an app entry order still open at Alpaca — also treated as open. */
  pendingEntrySymbols: Set<string>
}

/**
 * Brings the ledger in line with Alpaca:
 *  - ledger position gone at Alpaca   -> close it in the ledger at Alpaca's sell fill price
 *  - regular session, no stop resting -> place the OCO; if the price is already through the stop/target,
 *                                        or the OCO is refused twice, sell now (never left unprotected)
 *  - more shares at Alpaca than ledger -> sell only the extra shares
 *  - pre-market                        -> app-managed stop/target via extended-hours sell limits (repriced)
 *  - shares the app bought but has no ledger row for -> sell them; a short is covered and alerted
 * Every app sell is capped at the shares Alpaca holds long at that moment.
 */
export async function reconcileAlpaca(input: { sessionId: string; scanId: string; now: Date; clock: MarketClock; positions: PaperPosition[]; marks: Map<string, PaperMarketMark>; flatten: boolean }): Promise<ReconcileResult> {
  const result: ReconcileResult = { closes: [], protectionPlaced: [], exitsSent: [], orphansClosed: [], warnings: [], brokerSymbols: new Set(), pendingEntrySymbols: new Set() }
  const tracked = input.positions.filter(isAlpacaPosition)
  const trackedSymbols = new Set(tracked.map((position) => position.symbol))
  const brokerPositions: AlpacaPosition[] = await listPositions()
  const longQty = new Map<string, number>()
  const shorts: AlpacaPosition[] = []
  for (const position of brokerPositions) {
    result.brokerSymbols.add(position.symbol)
    const qty = Number(position.qty) || 0
    if (position.side === 'short' || qty < 0) shorts.push(position)
    else longQty.set(position.symbol, qty)
  }
  const regular = isRegularSession(input.clock)
  const dayStart = easternDayStart(input.now)

  const allOpen = await listOrders({ status: 'open', limit: 500 })
  for (const order of allOpen) {
    if (order.side !== 'buy' || !order.client_order_id?.startsWith('ait-e-')) continue
    if (order.submitted_at && input.now.getTime() - Date.parse(order.submitted_at) > 30_000) {
      // Our entry order still open long after it should have been canceled: cancel it.
      await cancelOrder(order.id).catch(() => undefined)
      await logOrderEvent({ sessionId: input.sessionId, scanId: input.scanId, symbol: order.symbol, event: 'stale_entry_canceled', brokerOrderId: order.id, clientOrderId: order.client_order_id })
    }
    result.pendingEntrySymbols.add(order.symbol)
  }

  const relevantSymbols = [...new Set([...trackedSymbols, ...result.brokerSymbols])]
  const earliest = [dayStart.toISOString(), ...tracked.map((position) => position.opened_at).filter((value): value is string => Boolean(value))].sort()[0]
  const closedOrders = relevantSymbols.length ? await listOrders({ status: 'closed', symbols: relevantSymbols, after: new Date(Date.parse(earliest) - 60_000).toISOString(), limit: 500 }) : []
  const sellIds = closedOrders.flatMap(flattenOrderTree).filter((order) => order.side === 'sell' && Number(order.filled_qty) > 0).map((order) => order.id)
  const appCodes = await loadAppExitCodes(sellIds)

  // A short should never exist: cover it and alert.
  for (const position of shorts) {
    const base = { sessionId: input.sessionId, scanId: input.scanId, symbol: position.symbol }
    result.warnings.push(`${position.symbol}: Alpaca shows a SHORT of ${position.qty}`)
    if (!regular || input.flatten) continue
    try {
      await cancelOpenSellsConfirmed(position.symbol)
      const order = await closePosition(position.symbol)
      await logOrderEvent({ ...base, event: 'short_covered', side: 'buy', qty: Math.abs(Number(position.qty)), brokerOrderId: order.id })
      await alert(`AItrading: ${position.symbol} short covered`, `Alpaca showed an unexpected short of ${position.qty} ${position.symbol}; it was bought back.`)
    } catch (error) {
      await alert(`AItrading: ${position.symbol} SHORT NEEDS ATTENTION`, `Alpaca shows a short of ${position.qty} ${position.symbol} that could not be covered automatically: ${errorText(error)}`)
    }
  }

  for (const position of tracked) {
    const ledgerQty = Math.abs(Number(position.quantity) || 0)
    const heldQty = longQty.get(position.symbol) ?? 0
    const base = { sessionId: input.sessionId, scanId: input.scanId, positionId: position.id, symbol: position.symbol }

    if (heldQty === 0) {
      if (shorts.some((short) => short.symbol === position.symbol)) continue
      const sells = filledSells(closedOrders, position.symbol, position.opened_at).filter((order) => appCodes.get(order.id) !== 'excess')
      const soldQty = sells.reduce((sum, order) => sum + Number(order.filled_qty), 0)
      if (!sells.length || soldQty <= 0) {
        result.warnings.push(`${position.symbol}: ledger shows open but Alpaca has no position and no sell fill was found`)
        await logOrderEvent({ ...base, event: 'reconcile_missing_exit', payload: { ledgerQty } })
        continue
      }
      const fillPrice = sells.reduce((sum, order) => sum + Number(order.filled_qty) * Number(order.filled_avg_price), 0) / soldQty
      const exitReason = exitReasonForOrder(sells[0], appCodes.get(sells[0].id) ?? null)
      const close = await closePaperPosition({
        sessionId: input.sessionId,
        positionId: position.id,
        fillPrice,
        exitReason,
        idempotencyKey: `close:${position.id}`,
        exitMetadata: { broker: 'alpaca', brokerOrderIds: sells.map((order) => order.id), soldQty, ledgerQty, ...paperExitLevels(position), markSource: 'alpaca-fill', scanId: input.scanId },
      })
      if (close.status === 'closed' || close.status === 'already_executed') {
        const realizedPnl = close.realizedPnl ?? (fillPrice - Number(position.entry_price)) * ledgerQty
        if (close.status === 'closed') result.closes.push({ position, fillPrice, exitReason, realizedPnl, quantity: ledgerQty })
        await logOrderEvent({ ...base, event: 'ledger_closed', side: 'sell', qty: soldQty, price: fillPrice, brokerOrderId: sells[0].id, payload: { exitReason, realizedPnl } })
        if (soldQty !== ledgerQty) result.warnings.push(`${position.symbol}: Alpaca sold ${soldQty} but ledger held ${ledgerQty}`)
      } else {
        result.warnings.push(`${position.symbol}: ledger close returned ${close.status}`)
      }
      continue
    }

    if (input.flatten) continue
    const mark = input.marks.get(position.symbol) ?? null
    const levels = paperExitLevels(position)
    const openSells = allOpen.flatMap(flattenOrderTree).filter((order) => order.symbol === position.symbol && order.side === 'sell' && !isTerminal(order))

    if (heldQty > ledgerQty && regular) {
      // Extra untracked shares (e.g. a late fill after cancel): sell only the extra, keep the OCO.
      try {
        await exitNow({ symbol: position.symbol, qty: heldQty - ledgerQty, refPrice: mark?.bid ?? null, regular, code: 'excess', cancelSells: false, base })
        result.warnings.push(`${position.symbol}: sold ${heldQty - ledgerQty} extra shares Alpaca held beyond the ledger`)
      } catch (error) {
        result.warnings.push(`${position.symbol}: Alpaca holds ${heldQty} but ledger ${ledgerQty}; extra could not be sold (${errorText(error)})`)
      }
      continue
    }

    if (regular) {
      const hasStop = openSells.some((order) => order.type === 'stop' || order.type === 'stop_limit' || order.order_class === 'oco')
      if (hasStop) continue
      const crossed = mark ? paperExitReason(position, mark, false) : null
      if (!crossed && levels.stopPrice != null && levels.targetPrice != null) {
        let placed = false
        let lastError: unknown = null
        for (let attempt = 0; attempt < 2 && !placed; attempt += 1) {
          try {
            if (!(await cancelOpenSellsConfirmed(position.symbol))) throw new Error('resting sell orders did not cancel in time')
            const held = await heldAtBroker(position.symbol)
            if (held.short || held.qty <= 0) throw new Error(`no long shares to protect (${held.short ? 'short' : 'flat'})`)
            await placeProtection({ symbol: position.symbol, qty: held.qty, stopPrice: roundPrice(levels.stopPrice, 'down'), targetPrice: roundPrice(levels.targetPrice, 'up'), positionId: position.id, sessionId: input.sessionId, scanId: input.scanId })
            placed = true
          } catch (error) {
            lastError = error
            if (isRetryableBrokerError(error)) break
          }
        }
        if (placed) {
          result.protectionPlaced.push(position.symbol)
          continue
        }
        if (isRetryableBrokerError(lastError)) {
          // Rate limit / Alpaca hiccup: try again next scan rather than dumping a healthy position.
          result.warnings.push(`${position.symbol}: stop/target not placed yet (${errorText(lastError)}); retrying next scan`)
          const pendingBefore = await recentEventCount('protection_pending', position.id, 3)
          await logOrderEvent({ ...base, event: 'protection_pending', payload: { error: errorText(lastError) } })
          if (pendingBefore >= 1 && (await recentEventCount('protection_alerted', position.id, 15)) === 0) {
            await logOrderEvent({ ...base, event: 'protection_alerted' })
            await alert(`AItrading: ${position.symbol} has NO STOP at Alpaca`, `Stop/target could not be placed for 2+ scans (${errorText(lastError)}). The app keeps retrying; check Alpaca or set TRADING_HALT.`)
          }
          continue
        }
        result.warnings.push(`${position.symbol}: Alpaca refused the stop/target twice (${errorText(lastError)}); selling`)
      }
      // Price already through the stop/target, or protection refused twice: sell now.
      try {
        const order = await exitNow({ symbol: position.symbol, qty: heldQty, refPrice: mark?.bid ?? null, regular, code: crossed === EXIT_REASONS.stop ? 'stop' : crossed === EXIT_REASONS.target ? 'tgt' : 'unw', cancelSells: true, base })
        if (order) result.exitsSent.push(position.symbol)
      } catch (error) {
        result.warnings.push(`${position.symbol}: unprotected and exit failed (${errorText(error)})`)
        await logOrderEvent({ ...base, event: 'protective_exit_failed', payload: { error: errorText(error) } })
        await alert(`AItrading: ${position.symbol} UNPROTECTED`, `No stop at Alpaca and the exit failed: ${errorText(error)}. Close it manually.`)
      }
      continue
    }

    // Pre-market: Alpaca will not hold a stop order, so the app watches the price itself.
    if (!mark) continue
    const ours = openSells.filter((order) => OUR_ORDER.test(order.client_order_id ?? ''))
    if (openSells.length && ours.length !== openSells.length) continue
    const reason = paperExitReason(position, mark, false)
    if (!reason) continue
    const wantLimit = roundPrice(mark.bid * (1 - PREMARKET_EXIT_LIMIT_BUFFER), 'down')
    if (ours.length && ours.every((order) => Number(order.limit_price) <= wantLimit + 1e-9)) continue
    try {
      // exitNow cancels the stale resting exit, confirms it, re-reads the shares, then resends.
      const order = await exitNow({ symbol: position.symbol, qty: heldQty, refPrice: mark.bid, regular: false, code: reason === EXIT_REASONS.stop ? 'stop' : 'tgt', cancelSells: true, base })
      if (order) result.exitsSent.push(position.symbol)
    } catch (error) {
      result.warnings.push(`${position.symbol}: pre-market exit could not be sent (${errorText(error)})`)
      await logOrderEvent({ ...base, event: 'premarket_exit_failed', payload: { reason, error: errorText(error) } })
    }
  }

  // Orphans: long shares at Alpaca with no ledger row. Sell them only if this app bought them today.
  if (!input.flatten) {
    for (const [symbol, qty] of longQty) {
      if (trackedSymbols.has(symbol) || qty <= 0) continue
      const appBuys = closedOrders.flatMap(flattenOrderTree).filter((order) => order.symbol === symbol && order.side === 'buy' && Number(order.filled_qty) > 0)
      const boughtByApp = appBuys.some((order) => {
        const coid = order.client_order_id ?? ''
        if (coid.startsWith('ait-e-')) return true
        // Test-harness shares: the harness closes its own; only sweep if they were left behind.
        return coid.startsWith('ait-t-') && order.filled_at != null && input.now.getTime() - Date.parse(order.filled_at) > TEST_ORDER_GRACE_MS
      })
      const base = { sessionId: input.sessionId, scanId: input.scanId, symbol }
      if (!boughtByApp) {
        result.warnings.push(`${symbol}: Alpaca holds ${qty} shares the app did not buy today; left untouched`)
        continue
      }
      const refPrice = input.marks.get(symbol)?.bid ?? null
      if (!regular && refPrice == null) {
        result.warnings.push(`${symbol}: untracked ${qty} shares; no pre-market price to sell yet`)
        continue
      }
      try {
        const order = await exitNow({ symbol, qty, refPrice, regular, code: 'orph', cancelSells: true, base })
        if (order) {
          result.orphansClosed.push(symbol)
          await alert(`AItrading: ${symbol} untracked shares closed`, `Alpaca held ${qty} ${symbol} the ledger did not track (e.g. a late fill). They were sold.`)
        }
      } catch (error) {
        result.warnings.push(`${symbol}: untracked ${qty} shares could not be sold (${errorText(error)})`)
        await logOrderEvent({ ...base, event: 'orphan_close_failed', payload: { error: errorText(error) } })
      }
    }
  }
  return result
}

/** Close-time: cancel every open order, market-close every position, then wait briefly for the fills. */
export async function flattenAlpaca(input: { sessionId: string; scanId: string }) {
  const responses = await closeAllPositions()
  await logOrderEvent({ sessionId: input.sessionId, scanId: input.scanId, symbol: '*', event: 'flatten_submitted', payload: { responses: responses.map((item) => ({ symbol: item.symbol, status: item.status, orderId: item.body?.id ?? null })) } })
  const started = Date.now()
  let remaining = await listPositions()
  while (remaining.length && Date.now() - started < FLATTEN_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    remaining = await listPositions()
  }
  if (remaining.length) {
    await logOrderEvent({ sessionId: input.sessionId, scanId: input.scanId, symbol: '*', event: 'flatten_incomplete', payload: { remaining: remaining.map((position) => ({ symbol: position.symbol, qty: position.qty })) } })
    await alert('AItrading: flatten incomplete', `Still open at Alpaca after the close flatten: ${remaining.map((position) => `${position.symbol} ${position.qty}`).join(', ')}. Close them manually in Alpaca.`)
  }
  return { remaining: remaining.map((position) => position.symbol) }
}

export { getOrder }
