import assert from 'node:assert/strict'
import test from 'node:test'

process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'
process.env.ALPACA_BASE_URL = 'https://paper-api.alpaca.markets'
process.env.ALPACA_API_KEY = 'PKTESTKEY'
process.env.ALPACA_API_SECRET = 'secret'

const broker = await import('../lib/alpaca-broker')
const exec = await import('../lib/alpaca-execution')

const REGULAR = new Date('2026-10-12T14:00:00Z') // Mon 10:00 ET
const PREMARKET = new Date('2026-10-12T11:30:00Z') // Mon 07:30 ET
const OPEN_CLOCK = { isOpen: true, nextClose: '2026-10-12T20:00:00Z', minutesToClose: 360, nextOpen: null, minutesToOpen: null }
const PRE_CLOCK = { isOpen: false, nextClose: null, minutesToClose: null, nextOpen: '2026-10-12T13:30:00Z', minutesToOpen: 120 }
const HOLIDAY_CLOCK = { isOpen: false, nextClose: null, minutesToClose: null, nextOpen: '2026-10-13T13:30:00Z', minutesToOpen: 1560 }
const guardrails = { maxPositionFraction: 0.25, maxAggregateExposureFraction: 0.75, riskPerTradeFraction: 0.01, maxDailyLossFraction: 0.04, maxOpenPositions: 3, minimumMarginEquity: 2000, reentryCooldownMinutes: 30 }

/** In-memory Alpaca paper account. */
function fakeAlpaca({ ask = 10, fillMode = 'full', account = { status: 'ACTIVE', equity: '2000', cash: '2000', buying_power: '4000' }, rejectOco = false, timeoutFirstSubmit = false } = {}) {
  let submits = 0
  const orders = new Map()
  const positions = new Map()
  const requests = []
  let seq = 0
  const json = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const now = () => new Date().toISOString()
  const fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url)
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ method, pathname, search: searchParams.toString(), body })
    if (pathname === '/v2/account') return json(account)
    if (pathname === '/v2/clock') return json({ is_open: true, next_close: '2026-10-12T20:00:00Z', next_open: '2026-10-13T13:30:00Z', timestamp: new Date().toISOString() })
    if (pathname === '/v2/orders:by_client_order_id') {
      const found = [...orders.values()].find((order) => order.client_order_id === searchParams.get('client_order_id'))
      return found ? json(found) : json({ message: 'not found' }, 404)
    }
    if (pathname === '/v2/positions' && method === 'GET') return json([...positions.values()])
    if (pathname === '/v2/positions' && method === 'DELETE') {
      const out = []
      for (const order of orders.values()) if (order.status === 'new') order.status = 'canceled'
      for (const position of positions.values()) {
        const id = `o${++seq}`
        const order = { id, client_order_id: `rand${seq}`, symbol: position.symbol, side: 'sell', type: 'market', status: 'filled', qty: position.qty, filled_qty: position.qty, filled_avg_price: '9.5', filled_at: '2026-10-12T19:55:05Z', legs: null }
        orders.set(id, order)
        out.push({ symbol: position.symbol, status: 200, body: order })
      }
      positions.clear()
      return json(out, 207)
    }
    if (pathname.startsWith('/v2/positions/') && method === 'DELETE') {
      const symbol = pathname.split('/').pop()
      const position = positions.get(symbol)
      if (!position) return json({ message: 'position not found' }, 404)
      const held = Number(position.qty)
      const qty = searchParams.get('qty') ? Number(searchParams.get('qty')) : held
      if (qty > held) return json({ message: 'insufficient qty' }, 403)
      if (qty === held) positions.delete(symbol)
      else position.qty = String(held - qty)
      const id = `o${++seq}`
      const order = { id, client_order_id: `rand${seq}`, symbol, side: 'sell', type: 'market', status: 'filled', qty: String(qty), filled_qty: String(qty), filled_avg_price: String(ask), filled_at: now(), legs: null }
      orders.set(id, order)
      return json(order)
    }
    if (pathname === '/v2/orders' && method === 'POST') {
      submits += 1
      const id = `o${++seq}`
      if (body.side === 'sell' && body.type === 'market') {
        const position = positions.get(body.symbol)
        const qty = Number(body.qty)
        const order = { id, client_order_id: body.client_order_id, symbol: body.symbol, side: 'sell', type: 'market', status: 'filled', qty: body.qty, filled_qty: body.qty, filled_avg_price: String(ask), filled_at: now(), legs: null }
        orders.set(id, order)
        if (position) {
          const left = Number(position.qty) - qty
          if (left > 0) position.qty = String(left)
          else positions.delete(body.symbol)
        }
        return json(order)
      }
      if (body.order_class === 'oco') {
        if (rejectOco) return json({ message: 'oco rejected' }, 422)
        const stopLeg = { id: `o${++seq}`, client_order_id: `leg${seq}`, symbol: body.symbol, side: 'sell', type: 'stop', status: 'held', qty: body.qty, filled_qty: '0', filled_avg_price: null, stop_price: body.stop_loss.stop_price, legs: null }
        const order = { id, client_order_id: body.client_order_id, symbol: body.symbol, side: 'sell', type: 'limit', order_class: 'oco', status: 'new', qty: body.qty, filled_qty: '0', filled_avg_price: null, limit_price: body.take_profit.limit_price, legs: [stopLeg] }
        orders.set(id, order)
        return json(order)
      }
      const qty = Number(body.qty)
      const fills = body.side === 'buy' && Number(body.limit_price) >= ask
      if (timeoutFirstSubmit && submits === 1) {
        // Alpaca accepts the order but the client times out.
        const order = { id, client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, type: body.type, status: 'filled', qty: body.qty, filled_qty: body.qty, filled_avg_price: String(ask), limit_price: body.limit_price, filled_at: now(), legs: null }
        orders.set(id, order)
        positions.set(body.symbol, { symbol: body.symbol, qty: body.qty, avg_entry_price: String(ask), side: 'long' })
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      }
      const filledQty = !fills ? 0 : fillMode === 'partial' ? Math.max(1, Math.floor(qty / 2)) : fillMode === 'none' ? 0 : qty
      const order = { id, client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, type: body.type, status: filledQty === qty ? 'filled' : filledQty ? 'partially_filled' : 'new', qty: body.qty, filled_qty: String(filledQty), filled_avg_price: filledQty ? String(ask) : null, limit_price: body.limit_price, extended_hours: body.extended_hours, submitted_at: now(), filled_at: filledQty ? now() : null, legs: null }
      orders.set(id, order)
      if (body.side === 'buy' && filledQty) positions.set(body.symbol, { symbol: body.symbol, qty: String(filledQty + Number(positions.get(body.symbol)?.qty ?? 0)), avg_entry_price: String(ask), side: 'long' })
      return json(order)
    }
    if (pathname === '/v2/orders' && method === 'GET') {
      const status = searchParams.get('status')
      const symbols = searchParams.get('symbols')?.split(',')
      const list = [...orders.values()].filter((order) => (!symbols || symbols.includes(order.symbol)) && (status === 'all' || (status === 'open' ? ['new', 'held', 'partially_filled', 'accepted'].includes(order.status) : ['filled', 'canceled', 'expired', 'rejected'].includes(order.status) || (order.legs ?? []).some((leg) => leg.status === 'filled'))))
      return json(list)
    }
    const orderMatch = pathname.match(/^\/v2\/orders\/(.+)$/)
    if (orderMatch) {
      const order = orders.get(decodeURIComponent(orderMatch[1]))
      if (!order) return json({ message: 'not found' }, 404)
      if (method === 'DELETE') {
        if (order.status === 'filled') return json({ message: 'already filled' }, 422)
        order.status = 'canceled'
        return json(null, 204)
      }
      return json(order)
    }
    return json({ message: `unhandled ${method} ${pathname}` }, 500)
  }
  return { fetch, orders, positions, requests }
}

/** Fake Supabase REST: records RPC calls and order events. */
function fakeSupabase({ openStatus = 'filled' } = {}) {
  const rpc = []
  const events = []
  globalThis.fetch = async (url, init = {}) => {
    const { pathname } = new URL(url)
    const body = init.body ? JSON.parse(init.body) : null
    if (pathname === '/rest/v1/rpc/open_ait_paper_position') {
      rpc.push({ name: 'open', body })
      return new Response(JSON.stringify(openStatus === 'filled' ? { status: 'filled', positionId: 'pos-11111111', quantity: body.p_quantity, fillPrice: body.p_fill_price } : { status: 'blocked', reason: 'maximum open positions reached' }), { status: 200 })
    }
    if (pathname === '/rest/v1/rpc/close_ait_paper_position') {
      rpc.push({ name: 'close', body })
      return new Response(JSON.stringify({ status: 'closed', realizedPnl: -12.5 }), { status: 200 })
    }
    if (pathname === '/rest/v1/ait_order_events' && init.method === 'POST') {
      events.push(body)
      return new Response('', { status: 201 })
    }
    return new Response('[]', { status: 200 })
  }
  return { rpc, events }
}

function setup(alpacaOptions, supabaseOptions) {
  const alpaca = fakeAlpaca(alpacaOptions)
  broker.setBrokerFetch(alpaca.fetch)
  broker.setBrokerSleep(async () => {})
  const supabase = fakeSupabase(supabaseOptions)
  return { alpaca, supabase }
}

const entry = (overrides = {}) => ({ sessionId: '11111111-1111-4111-8111-111111111111', scanId: '22222222-2222-4222-8222-222222222222', symbol: 'ABCD', quantity: 40, ask: 10, riskPerShare: 0.5, clock: OPEN_CLOCK, maxNotional: 500, guardrails, entryMetadata: { strategy: 'E' }, ...overrides })

test('execution mode and kill switch parse strictly', () => {
  assert.equal(broker.executionMode({ EXECUTION_MODE: 'alpaca' }), 'alpaca')
  assert.equal(broker.executionMode({ EXECUTION_MODE: ' ALPACA ' }), 'alpaca')
  assert.equal(broker.executionMode({ EXECUTION_MODE: 'live' }), 'internal')
  assert.equal(broker.executionMode({}), 'internal')
  assert.equal(broker.tradingHalted({ TRADING_HALT: 'true' }), true)
  assert.equal(broker.tradingHalted({ TRADING_HALT: 'false' }), false)
  assert.equal(broker.tradingHalted({}), false)
})

test('paper gate refuses a non-paper key and an inactive account', async () => {
  setup()
  const live = await broker.checkPaperGate({ ALPACA_API_KEY: 'AKLIVEKEY' })
  assert.equal(live.ok, false)
  assert.match(live.reason, /not a paper key/)
  setup({ account: { status: 'ACCOUNT_CLOSED', equity: '2000', cash: '0', buying_power: '0' } })
  const closed = await broker.checkPaperGate({ ALPACA_API_KEY: 'PKTEST' })
  assert.equal(closed.ok, false)
  setup()
  const ok = await broker.checkPaperGate({ ALPACA_API_KEY: 'PKTEST' })
  assert.deepEqual(ok.ok, true)
  assert.equal(ok.equity, 2000)
})

test('price rounding follows Alpaca tick rules', () => {
  assert.equal(broker.roundPrice(10.0301, 'up'), 10.04)
  assert.equal(broker.roundPrice(10.0399, 'down'), 10.03)
  assert.equal(broker.roundPrice(0.123456, 'nearest'), 0.1235)
})

test('regular-hours entry: limit buy fills, ledger records Alpaca fill, OCO stop/target placed at Alpaca', async () => {
  const { alpaca, supabase } = setup({ ask: 10 })
  const result = await exec.enterViaAlpaca(entry())
  assert.equal(result.status, 'filled')
  assert.equal(result.quantity, 40)
  assert.equal(result.fillPrice, 10)
  const buy = alpaca.requests.find((r) => r.method === 'POST' && r.body.side === 'buy')
  assert.equal(buy.body.type, 'limit')
  assert.equal(buy.body.limit_price, '10.03')
  assert.equal(buy.body.extended_hours, false)
  const open = supabase.rpc.find((r) => r.name === 'open')
  assert.equal(open.body.p_quantity, 40)
  assert.equal(open.body.p_fill_price, 10)
  assert.equal(open.body.p_stop_price, 9.5)
  assert.equal(open.body.p_target_price, 10.75)
  assert.equal(open.body.p_idempotency_key, buy.body.client_order_id)
  assert.equal(open.body.p_entry_metadata.broker, 'alpaca')
  const oco = alpaca.requests.find((r) => r.method === 'POST' && r.body.order_class === 'oco')
  assert.equal(oco.body.qty, '40')
  assert.equal(oco.body.stop_loss.stop_price, '9.5')
  assert.equal(oco.body.take_profit.limit_price, '10.75')
  assert.ok(supabase.events.some((e) => e.event === 'protection_placed'))
})

test('unfilled entry is canceled and never reaches the ledger', async () => {
  const { alpaca, supabase } = setup({ ask: 10, fillMode: 'none' })
  const result = await exec.enterViaAlpaca(entry())
  assert.equal(result.status, 'unfilled')
  assert.ok(alpaca.requests.some((r) => r.method === 'DELETE' && r.pathname.startsWith('/v2/orders/')))
  assert.equal(supabase.rpc.length, 0)
})

test('partial fill: remainder canceled, ledger and OCO use the filled quantity only', async () => {
  const { alpaca, supabase } = setup({ ask: 10, fillMode: 'partial' })
  const result = await exec.enterViaAlpaca(entry())
  assert.equal(result.status, 'filled')
  assert.equal(result.quantity, 20)
  assert.equal(supabase.rpc.find((r) => r.name === 'open').body.p_quantity, 20)
  assert.equal(alpaca.requests.find((r) => r.body?.order_class === 'oco').body.qty, '20')
})

test('ledger refusal sells exactly the filled shares (never the whole symbol)', async () => {
  const { alpaca } = setup({ ask: 10 }, { openStatus: 'blocked' })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '15', avg_entry_price: '9', side: 'long' })
  const result = await exec.enterViaAlpaca(entry())
  assert.equal(result.status, 'ledger_blocked')
  const closes = alpaca.requests.filter((r) => r.method === 'DELETE' && r.pathname === '/v2/positions/ABCD')
  assert.equal(closes.length, 1)
  assert.equal(closes[0].search, 'qty=40')
  assert.equal(alpaca.positions.get('ABCD').qty, '15')
})

test('entry quantity is capped so notional at the LIMIT price fits the allowed dollars', async () => {
  const { alpaca } = setup({ ask: 10 })
  const result = await exec.enterViaAlpaca(entry({ quantity: 100, maxNotional: 300 }))
  assert.equal(result.status, 'filled')
  assert.equal(alpaca.requests.find((r) => r.body?.side === 'buy').body.qty, '29') // 300 / 10.03
})

test('a submit that times out but was accepted by Alpaca is found by client order id, not duplicated', async () => {
  const { alpaca, supabase } = setup({ ask: 10, timeoutFirstSubmit: true })
  const result = await exec.enterViaAlpaca(entry())
  assert.equal(result.status, 'filled')
  assert.equal(alpaca.requests.filter((r) => r.method === 'POST' && r.body?.side === 'buy').length, 1)
  assert.ok(alpaca.requests.some((r) => r.pathname === '/v2/orders:by_client_order_id'))
  assert.equal(supabase.rpc.filter((r) => r.name === 'open').length, 1)
})

test('no entries on a holiday / outside sessions', async () => {
  const { alpaca } = setup({ ask: 10 })
  const result = await exec.enterViaAlpaca(entry({ clock: HOLIDAY_CLOCK }))
  assert.equal(result.status, 'blocked')
  assert.equal(alpaca.requests.length, 0)
})

test('pre-flight blocks what the ledger would refuse, before any order is sent', () => {
  const state = { openSymbols: new Set(['AAA']), openCount: 1, maxOpenPositions: 3, dailyLossStopped: false, cooldownSymbols: new Set(['CCC']) }
  assert.equal(exec.entryBlockReason(state, 'AAA'), 'position already open for symbol')
  assert.equal(exec.entryBlockReason(state, 'CCC'), 're-entry cooldown after protective stop')
  assert.equal(exec.entryBlockReason(state, 'BBB'), null)
  assert.equal(exec.entryBlockReason({ ...state, openCount: 3 }, 'BBB'), 'maximum open positions reached')
  assert.equal(exec.entryBlockReason({ ...state, dailyLossStopped: true }, 'BBB'), 'daily loss guardrail reached')
})

test('if the stop/target cannot be placed, the position is closed instead of left unprotected', async () => {
  const { alpaca } = setup({ ask: 10, rejectOco: true })
  const result = await exec.enterViaAlpaca(entry())
  assert.equal(result.status, 'protection_failed')
  assert.equal(alpaca.positions.size, 0)
  assert.equal(alpaca.requests.find((r) => r.method === 'DELETE' && r.pathname === '/v2/positions/ABCD').search, 'qty=40')
})

test('pre-market entry uses an extended-hours limit and no OCO (Alpaca rejects stops pre-market)', async () => {
  const { alpaca } = setup({ ask: 10 })
  const result = await exec.enterViaAlpaca(entry({ clock: PRE_CLOCK }))
  assert.equal(result.status, 'filled')
  assert.equal(alpaca.requests.find((r) => r.body?.side === 'buy').body.extended_hours, true)
  assert.equal(alpaca.requests.some((r) => r.body?.order_class === 'oco'), false)
})

const ledgerPosition = (overrides = {}) => ({ id: 'pos-11111111', symbol: 'ABCD', opened_at: '2026-10-12T13:59:00Z', quantity: 40, entry_price: 10, stop_price: 9.5, target_price: 10.75, metadata: { broker: 'alpaca', riskPerShare: 0.5 }, ...overrides })
const reconcileInput = (overrides = {}) => ({ sessionId: '11111111-1111-4111-8111-111111111111', scanId: '33333333-3333-4333-8333-333333333333', now: REGULAR, clock: OPEN_CLOCK, positions: [ledgerPosition()], marks: new Map(), flatten: false, ...overrides })

test('reconcile closes the ledger at Alpaca stop fill price when the stop leg filled', async () => {
  const { alpaca, supabase } = setup({ ask: 10 })
  alpaca.orders.set('oco1', { id: 'oco1', client_order_id: 'ait-p-x', symbol: 'ABCD', side: 'sell', type: 'limit', order_class: 'oco', status: 'canceled', qty: '40', filled_qty: '0', filled_avg_price: null, legs: [
    { id: 'leg1', client_order_id: 'leg1', symbol: 'ABCD', side: 'sell', type: 'stop', status: 'filled', qty: '40', filled_qty: '40', filled_avg_price: '9.46', filled_at: '2026-10-12T14:20:00Z', legs: null },
  ] })
  const result = await exec.reconcileAlpaca(reconcileInput())
  assert.equal(result.closes.length, 1)
  assert.equal(result.closes[0].exitReason, 'protective stop reached')
  assert.equal(result.closes[0].fillPrice, 9.46)
  const close = supabase.rpc.find((r) => r.name === 'close')
  assert.equal(close.body.p_fill_price, 9.46)
  assert.equal(close.body.p_idempotency_key, 'close:pos-11111111')
})

test('reconcile places the OCO when Alpaca holds the position without a stop (regular hours)', async () => {
  const { alpaca } = setup({ ask: 10 })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '40', avg_entry_price: '10', side: 'long' })
  const result = await exec.reconcileAlpaca(reconcileInput())
  assert.deepEqual(result.protectionPlaced, ['ABCD'])
  const oco = alpaca.requests.find((r) => r.body?.order_class === 'oco')
  assert.equal(oco.body.stop_loss.stop_price, '9.5')
})

test('reconcile does not duplicate protection when the OCO is already resting', async () => {
  const { alpaca } = setup({ ask: 10 })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '40', avg_entry_price: '10', side: 'long' })
  await exec.reconcileAlpaca(reconcileInput())
  const result = await exec.reconcileAlpaca(reconcileInput())
  assert.deepEqual(result.protectionPlaced, [])
  assert.equal(alpaca.requests.filter((r) => r.body?.order_class === 'oco').length, 1)
})

test('pre-market: app sends an extended-hours sell when the stop is crossed', async () => {
  const { alpaca } = setup({ ask: 10 })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '40', avg_entry_price: '10', side: 'long' })
  const marks = new Map([['ABCD', { symbol: 'ABCD', price: 9.4, bid: 9.38, ask: 9.42, at: PREMARKET.toISOString() }]])
  const result = await exec.reconcileAlpaca(reconcileInput({ now: PREMARKET, clock: PRE_CLOCK, marks }))
  assert.deepEqual(result.exitsSent, ['ABCD'])
  const sell = alpaca.requests.find((r) => r.body?.side === 'sell')
  assert.equal(sell.body.extended_hours, true)
  assert.match(sell.body.client_order_id, /^ait-x-stop-/)
  assert.equal(sell.body.limit_price, '9.33')
})

test('flatten market-closes Alpaca and the ledger is closed as a session flatten', async () => {
  const { alpaca, supabase } = setup({ ask: 10 })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '40', avg_entry_price: '10', side: 'long' })
  await exec.flattenAlpaca({ sessionId: 's', scanId: 'x' })
  assert.equal(alpaca.positions.size, 0)
  const result = await exec.reconcileAlpaca(reconcileInput({ flatten: true }))
  assert.equal(result.closes[0].exitReason, 'scheduled session flatten')
  assert.equal(supabase.rpc.find((r) => r.name === 'close').body.p_fill_price, 9.5)
})

test('exit reasons are read from order type / our client order ids', () => {
  assert.equal(exec.exitReasonForOrder({ client_order_id: 'ait-x-tgt-abc', type: 'limit' }), 'profit target reached')
  assert.equal(exec.exitReasonForOrder({ client_order_id: 'zzz', type: 'stop' }), 'protective stop reached')
  assert.equal(exec.exitReasonForOrder({ client_order_id: 'ait-p-abc', type: 'limit', order_class: 'oco' }), 'profit target reached')
  assert.equal(exec.exitReasonForOrder({ client_order_id: 'zzz', type: 'market', filled_at: '2026-10-12T19:55:10Z' }), 'scheduled session flatten')
  assert.equal(exec.exitReasonForOrder({ client_order_id: 'zzz', type: 'market', filled_at: '2026-10-12T15:00:00Z' }), 'closed in Alpaca outside the app')
})

test('regular hours: price already through the stop -> sell now instead of placing an OCO', async () => {
  const { alpaca, supabase } = setup({ ask: 9.3 })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '40', avg_entry_price: '10', side: 'long' })
  const marks = new Map([['ABCD', { symbol: 'ABCD', price: 9.3, bid: 9.29, ask: 9.31, at: REGULAR.toISOString() }]])
  const result = await exec.reconcileAlpaca(reconcileInput({ marks }))
  assert.deepEqual(result.exitsSent, ['ABCD'])
  assert.equal(alpaca.requests.some((r) => r.body?.order_class === 'oco'), false)
  assert.ok(alpaca.requests.some((r) => r.method === 'DELETE' && r.pathname === '/v2/positions/ABCD' && r.search === 'qty=40'))
  assert.equal(supabase.events.find((e) => e.event === 'app_exit_sent').payload.reason, 'stop')
})

test('regular hours: OCO refused -> position sold, not left unprotected', async () => {
  const { alpaca } = setup({ ask: 10, rejectOco: true })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '40', avg_entry_price: '10', side: 'long' })
  const result = await exec.reconcileAlpaca(reconcileInput())
  assert.deepEqual(result.exitsSent, ['ABCD'])
  assert.equal(alpaca.positions.size, 0)
})

test('pre-market: a resting exit above the falling bid is repriced', async () => {
  const { alpaca } = setup({ ask: 10 })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '40', avg_entry_price: '10', side: 'long' })
  const first = new Map([['ABCD', { symbol: 'ABCD', price: 9.4, bid: 9.38, ask: 9.42, at: PREMARKET.toISOString() }]])
  await exec.reconcileAlpaca(reconcileInput({ now: PREMARKET, clock: PRE_CLOCK, marks: first }))
  // pretend the resting sell did not fill and the price dropped further
  for (const order of alpaca.orders.values()) if (order.side === 'sell') order.status = 'new'
  const lower = new Map([['ABCD', { symbol: 'ABCD', price: 9.0, bid: 8.98, ask: 9.02, at: PREMARKET.toISOString() }]])
  await exec.reconcileAlpaca(reconcileInput({ now: PREMARKET, clock: PRE_CLOCK, marks: lower }))
  const sells = alpaca.requests.filter((r) => r.method === 'POST' && r.body?.side === 'sell')
  assert.equal(sells.length, 2)
  assert.equal(sells[1].body.limit_price, '8.93')
})

test('orphan shares the app bought (no ledger row) are sold; foreign shares are left alone', async () => {
  const { alpaca } = setup({ ask: 10 })
  alpaca.orders.set('b1', { id: 'b1', client_order_id: 'ait-e-abc-XYZ', symbol: 'XYZ', side: 'buy', type: 'limit', status: 'filled', qty: '10', filled_qty: '10', filled_avg_price: '5', filled_at: REGULAR.toISOString(), legs: null })
  alpaca.positions.set('XYZ', { symbol: 'XYZ', qty: '10', avg_entry_price: '5', side: 'long' })
  alpaca.positions.set('NVDA', { symbol: 'NVDA', qty: '1', avg_entry_price: '100', side: 'long' })
  const result = await exec.reconcileAlpaca(reconcileInput({ positions: [] }))
  assert.deepEqual(result.orphansClosed, ['XYZ'])
  assert.ok(alpaca.positions.has('NVDA'))
  assert.ok(result.warnings.some((w) => w.startsWith('NVDA')))
})

test('excess shares beyond the ledger are sold, tracked shares kept', async () => {
  const { alpaca } = setup({ ask: 10 })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '45', avg_entry_price: '10', side: 'long' })
  await exec.reconcileAlpaca(reconcileInput())
  assert.equal(alpaca.positions.get('ABCD').qty, '40')
})

test('flatten time uses Alpaca clock (half days) as well as the 15:55 schedule', () => {
  assert.equal(exec.isBrokerFlattenTime({ ...OPEN_CLOCK, minutesToClose: 4 }, false), true)
  assert.equal(exec.isBrokerFlattenTime({ ...OPEN_CLOCK, minutesToClose: 30 }, false), false)
  assert.equal(exec.isBrokerFlattenTime(null, true), true)
  assert.equal(exec.isPremarketSession(PRE_CLOCK), true)
  assert.equal(exec.isPremarketSession(HOLIDAY_CLOCK), false)
})

test('app exits never sell more than Alpaca holds (no accidental short)', async () => {
  const { alpaca } = setup({ ask: 10 })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '10', avg_entry_price: '10', side: 'long' })
  const order = await exec.exitNow({ symbol: 'ABCD', qty: 40, regular: true, code: 'stop', refPrice: 10, cancelSells: true })
  assert.equal(order.filled_qty, '10')
  assert.equal(alpaca.positions.size, 0)
  const none = await exec.exitNow({ symbol: 'ABCD', qty: 40, regular: true, code: 'stop', refPrice: 10, cancelSells: true })
  assert.equal(none, null)
})

test('a short at Alpaca is never treated as a long position', async () => {
  const { alpaca } = setup({ ask: 10 })
  alpaca.positions.set('ABCD', { symbol: 'ABCD', qty: '-40', avg_entry_price: '10', side: 'short' })
  await assert.rejects(exec.exitNow({ symbol: 'ABCD', qty: 40, regular: true, code: 'stop', refPrice: 10, cancelSells: false }), /SHORT/)
  const result = await exec.reconcileAlpaca(reconcileInput())
  assert.ok(result.warnings.some((w) => w.includes('SHORT')))
  assert.equal(alpaca.requests.some((r) => r.body?.order_class === 'oco'), false)
})

test('a pending app entry order makes the symbol count as open for the pre-flight', async () => {
  const { alpaca } = setup({ ask: 10 })
  alpaca.orders.set('p1', { id: 'p1', client_order_id: 'ait-e-zz-QQQQ', symbol: 'QQQQ', side: 'buy', type: 'limit', status: 'new', qty: '5', filled_qty: '0', filled_avg_price: null, submitted_at: REGULAR.toISOString(), legs: null })
  const result = await exec.reconcileAlpaca(reconcileInput({ positions: [] }))
  assert.ok(result.pendingEntrySymbols.has('QQQQ'))
})

test('fresh test-harness shares are left for the harness to close', async () => {
  const { alpaca } = setup({ ask: 10 })
  alpaca.orders.set('t1', { id: 't1', client_order_id: 'ait-t-F-abc', symbol: 'F', side: 'buy', type: 'limit', status: 'filled', qty: '1', filled_qty: '1', filled_avg_price: '12', filled_at: new Date(REGULAR.getTime() - 30_000).toISOString(), legs: null })
  alpaca.positions.set('F', { symbol: 'F', qty: '1', avg_entry_price: '12', side: 'long' })
  const result = await exec.reconcileAlpaca(reconcileInput({ positions: [] }))
  assert.deepEqual(result.orphansClosed, [])
  assert.ok(alpaca.positions.has('F'))
})
