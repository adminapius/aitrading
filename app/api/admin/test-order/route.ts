// Test harness for the Alpaca PAPER wiring. Never touches the trading ledger.
//   GET  -> read-only check: paper gate, market clock, open positions and orders.
//   POST {afterHours: true} -> outside regular hours: extended-hours limit BUY then SELL (no OCO; Alpaca
//           rejects stop orders outside regular hours). Proves connection, fills and logging only.
//   POST -> {symbol?: 'F', qty?: 1, closeAfter?: true}: buy a tiny position, place the OCO stop/target,
//           confirm it is resting at Alpaca, then (by default) cancel it and close the position.
// Auth: Authorization: Bearer <WORKER_RUN_SECRET>.

import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { cancelOrder, checkPaperGate, clientOrderId, listOrders, listPositions, roundPrice, submitOrder, waitForOrder } from '@/lib/alpaca-broker'
import { ENTRY_LIMIT_BUFFER, exitNow, logOrderEvent, placeProtection } from '@/lib/alpaca-execution'
import { loadOpenPaperPositions, loadPaperMarketMarksWithDiagnostics } from '@/lib/paper-trading'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_TEST_QTY = 5
const MAX_TEST_PRICE = 50

function isAuthorized(request: NextRequest) {
  const configured = process.env.WORKER_RUN_SECRET?.trim()
  const supplied = request.headers.get('authorization')?.trim().match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!configured || !supplied) return false
  const a = Buffer.from(configured)
  const b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await checkPaperGate()
  if (!gate.ok) return NextResponse.json({ gate })
  const [positions, openOrders] = await Promise.all([listPositions(), listOrders({ status: 'open', limit: 50 })])
  return NextResponse.json({
    gate,
    executionMode: process.env.EXECUTION_MODE ?? 'internal',
    tradingHalt: process.env.TRADING_HALT ?? 'false',
    positions: positions.map((position) => ({ symbol: position.symbol, qty: position.qty, avgEntry: position.avg_entry_price })),
    openOrders: openOrders.map((order) => ({ symbol: order.symbol, side: order.side, type: order.type, orderClass: order.order_class, status: order.status, qty: order.qty, clientOrderId: order.client_order_id })),
  })
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({})) as { symbol?: unknown; qty?: unknown; closeAfter?: unknown; afterHours?: unknown }
  const symbol = typeof body.symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,9}$/.test(body.symbol) ? body.symbol : 'F'
  const qty = Number.isInteger(body.qty) && Number(body.qty) >= 1 && Number(body.qty) <= MAX_TEST_QTY ? Number(body.qty) : 1
  const closeAfter = body.closeAfter !== false
  const steps: Array<Record<string, unknown>> = []

  const gate = await checkPaperGate()
  steps.push({ step: 'paper_gate', ...gate })
  if (!gate.ok) return NextResponse.json({ ok: false, steps }, { status: 412 })

  steps.push({ step: 'market_clock', ...gate.clock })
  if (body.afterHours === true) {
    if (gate.clock.isOpen) return NextResponse.json({ ok: false, reason: 'Market is open; run the full test instead (without afterHours).', steps }, { status: 409 })
    return NextResponse.json(await afterHoursTest(symbol, qty, steps))
  }
  if (!gate.clock.isOpen) return NextResponse.json({ ok: false, reason: 'Market is closed; the test needs regular hours.', steps }, { status: 409 })

  // Never touch a symbol the strategy holds or Alpaca already has.
  const [ledgerOpen, brokerOpen] = await Promise.all([loadOpenPaperPositions(), listPositions()])
  if (ledgerOpen.some((position) => position.symbol === symbol) || brokerOpen.some((position) => position.symbol === symbol)) {
    return NextResponse.json({ ok: false, reason: `${symbol} already has an open position; pick another test symbol.`, steps }, { status: 409 })
  }

  const { marks } = await loadPaperMarketMarksWithDiagnostics([symbol])
  const mark = marks.get(symbol)
  if (!mark || mark.source === 'trade') return NextResponse.json({ ok: false, reason: `No fresh quote for ${symbol}.`, steps }, { status: 409 })
  if (mark.ask > MAX_TEST_PRICE) return NextResponse.json({ ok: false, reason: `${symbol} ask $${mark.ask} is above the $${MAX_TEST_PRICE} test limit.`, steps }, { status: 400 })
  steps.push({ step: 'quote', bid: mark.bid, ask: mark.ask, at: mark.at })

  const coid = clientOrderId('t', [symbol, Date.now().toString(36)])
  const limitPrice = roundPrice(mark.ask * (1 + ENTRY_LIMIT_BUFFER), 'up')
  try {
    let order = await submitOrder({ symbol, qty: String(qty), side: 'buy', type: 'limit', time_in_force: 'day', limit_price: String(limitPrice), client_order_id: coid })
    await logOrderEvent({ symbol, event: 'test_entry_submitted', side: 'buy', qty, price: limitPrice, clientOrderId: coid, brokerOrderId: order.id, brokerStatus: order.status, test: true })
    order = await waitForOrder(order.id, 8_000)
    if (order.status !== 'filled') {
      await cancelOrder(order.id)
      order = await waitForOrder(order.id, 3_000)
    }
    const filledQty = Math.floor(Number(order.filled_qty) || 0)
    const fillPrice = Number(order.filled_avg_price)
    steps.push({ step: 'entry', orderId: order.id, status: order.status, filledQty, fillPrice })
    await logOrderEvent({ symbol, event: filledQty ? 'test_entry_filled' : 'test_entry_unfilled', side: 'buy', qty: filledQty, price: fillPrice || null, clientOrderId: coid, brokerOrderId: order.id, brokerStatus: order.status, test: true })
    if (!filledQty) return NextResponse.json({ ok: false, reason: 'Entry did not fill within 8s (canceled).', steps })

    const stopPrice = roundPrice(fillPrice * 0.98, 'down')
    const targetPrice = roundPrice(fillPrice * 1.03, 'up')
    const protection = await placeProtection({ symbol, qty: filledQty, stopPrice, targetPrice, test: true })
    steps.push({ step: 'protection', orderId: protection.id, orderClass: protection.order_class, status: protection.status, stopPrice, targetPrice, legs: (protection.legs ?? []).map((leg) => ({ type: leg.type, status: leg.status, stop: leg.stop_price, limit: leg.limit_price })) })

    const resting = await listOrders({ status: 'open', symbols: [symbol] })
    steps.push({ step: 'resting_orders', count: resting.length, orders: resting.map((item) => ({ type: item.type, orderClass: item.order_class, status: item.status, legs: (item.legs ?? []).map((leg) => leg.type) })) })

    if (closeAfter) {
      await cancelOrder(protection.id)
      await waitForOrder(protection.id, 3_000).catch(() => undefined)
      const close = await exitNow({ symbol, qty: filledQty, refPrice: mark.bid, regular: true, code: 'unw', cancelSells: false, test: true })
      if (!close) return NextResponse.json({ ok: false, reason: 'Test shares were already gone at Alpaca before closing.', steps })
      const closed = await waitForOrder(close.id, 8_000)
      steps.push({ step: 'close', orderId: closed.id, status: closed.status, filledQty: closed.filled_qty, fillPrice: closed.filled_avg_price })
      await logOrderEvent({ symbol, event: 'test_close', side: 'sell', qty: Number(closed.filled_qty) || null, price: Number(closed.filled_avg_price) || null, brokerOrderId: closed.id, brokerStatus: closed.status, test: true })
    }
    return NextResponse.json({ ok: true, steps })
  } catch (error) {
    steps.push({ step: 'error', error: message(error) })
    await logOrderEvent({ symbol, event: 'test_error', clientOrderId: coid, test: true, payload: { error: message(error) } })
    return NextResponse.json({ ok: false, steps }, { status: 500 })
  }
}

/** Extended-hours round trip: limit buy at ask+0.3%, then limit sell at bid-0.5%. Never touches the ledger. */
async function afterHoursTest(symbol: string, qty: number, steps: Array<Record<string, unknown>>) {
  const [ledgerOpen, brokerOpen] = await Promise.all([loadOpenPaperPositions(), listPositions()])
  if (ledgerOpen.some((position) => position.symbol === symbol) || brokerOpen.some((position) => position.symbol === symbol)) {
    return { ok: false, reason: `${symbol} already has an open position; pick another test symbol.`, steps }
  }
  const { marks } = await loadPaperMarketMarksWithDiagnostics([symbol])
  const mark = marks.get(symbol)
  if (!mark || mark.source === 'trade') return { ok: false, reason: `No fresh after-hours quote for ${symbol}; try a more active symbol.`, steps }
  if (mark.ask > MAX_TEST_PRICE) return { ok: false, reason: `${symbol} ask $${mark.ask} is above the $${MAX_TEST_PRICE} test limit.`, steps }
  steps.push({ step: 'quote', bid: mark.bid, ask: mark.ask, at: mark.at })
  const coid = clientOrderId('t', [symbol, 'ah', Date.now().toString(36)])
  const limitPrice = roundPrice(mark.ask * (1 + ENTRY_LIMIT_BUFFER), 'up')
  try {
    let order = await submitOrder({ symbol, qty: String(qty), side: 'buy', type: 'limit', time_in_force: 'day', extended_hours: true, limit_price: String(limitPrice), client_order_id: coid })
    await logOrderEvent({ symbol, event: 'test_ah_entry_submitted', side: 'buy', qty, price: limitPrice, clientOrderId: coid, brokerOrderId: order.id, brokerStatus: order.status, test: true })
    order = await waitForOrder(order.id, 8_000)
    if (order.status !== 'filled') {
      await cancelOrder(order.id)
      order = await waitForOrder(order.id, 3_000)
    }
    const filledQty = Math.floor(Number(order.filled_qty) || 0)
    const fillPrice = Number(order.filled_avg_price)
    steps.push({ step: 'entry', orderId: order.id, status: order.status, filledQty, fillPrice, limitPrice })
    await logOrderEvent({ symbol, event: filledQty ? 'test_ah_entry_filled' : 'test_ah_entry_unfilled', side: 'buy', qty: filledQty, price: fillPrice || null, clientOrderId: coid, brokerOrderId: order.id, brokerStatus: order.status, test: true })
    if (!filledQty) return { ok: false, reason: 'After-hours buy did not fill within 8s (canceled). Thin after-hours liquidity; try again or use a more active symbol.', steps }

    const { marks: exitMarks } = await loadPaperMarketMarksWithDiagnostics([symbol])
    const bid = exitMarks.get(symbol)?.bid ?? mark.bid
    const close = await exitNow({ symbol, qty: filledQty, refPrice: bid, regular: false, code: 'unw', cancelSells: false, test: true })
    if (!close) return { ok: false, reason: 'Test shares were already gone at Alpaca before closing.', steps }
    const closed = await waitForOrder(close.id, 10_000)
    steps.push({ step: 'close', orderId: closed.id, status: closed.status, filledQty: closed.filled_qty, fillPrice: closed.filled_avg_price, limitPrice: closed.limit_price })
    await logOrderEvent({ symbol, event: 'test_ah_close', side: 'sell', qty: Number(closed.filled_qty) || null, price: Number(closed.filled_avg_price) || null, brokerOrderId: closed.id, brokerStatus: closed.status, test: true })
    if (closed.status !== 'filled') {
      await cancelOrder(closed.id).catch(() => undefined)
      return { ok: false, reason: `Sell did not fill within 10s (canceled). You still hold ${filledQty} ${symbol} at Alpaca; the 15:55 flatten Monday or a manual close in Alpaca will clear it.`, steps }
    }
    return { ok: true, note: 'After-hours round trip worked. The stop/target (OCO) part can only be tested in regular hours (Monday).', steps }
  } catch (error) {
    steps.push({ step: 'error', error: message(error) })
    await logOrderEvent({ symbol, event: 'test_error', clientOrderId: coid, test: true, payload: { error: message(error), afterHours: true } })
    return { ok: false, steps }
  }
}
