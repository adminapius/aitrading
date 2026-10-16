// Fill audit - READ ONLY. Replays every real Strategy E round trip that went through Alpaca (paper) with the
// backtester's fill and cost model on 1-min SIP bars, and prints actual vs model, side by side.
//
//   npx tsx scripts/backtest/rulebook/audit.ts --out=backtests/fill-audit
//
// Reads: ait_trades (Supabase, GET only), Alpaca order details (GET), 1-min SIP bars and quotes (cached).
// Writes: <out>/audit.csv only. Never places, changes or cancels an order; never writes to Supabase.
//
// Entry - Strategy E sends marketable limit orders that fill at once, so the audit uses "instant" mode:
//  - fill at the SIP ask INSTANT_DELAY_MS (2 s) after the order was sent, + slippage;
//    no fill if that ask is above the order's real limit price (a marketable limit would not fill either).
//  - the 1-min bar containing that moment is the fill bar.
//  ("next-bar" mode, used by the rulebook backtests for resting orders placed at a bar close, is still in
//  modelTrade: active from the first full 1-min bar after sending, a bar reaching the trigger fills at
//  max(trigger, open) + slippage unless that is above the limit. The rulebook backtests are unchanged.)
// Exits (same rules as the rulebook backtest):
//  - after the fill bar: bar opens at/below the stop -> open - slippage; low touches the stop -> stop - slippage;
//    high trades a cent through the target -> max(target, open), no slippage; stop is checked before the target.
//    On the fill bar itself the stop counts only if the bar closes at/below it.
//  - session flatten at the minute the real flatten happened: that bar's open - slippage.
//  - stop and target are the real bracket prices the app placed at the broker.
//  - fees: SEC fee and FINRA TAF on sells (Alpaca paper charges none, so the actual side has none).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchJson, flushQuoteCache, getLatestQuote, getMinuteBarsForDay, type RawBar } from '../data'
import { toEasternDay } from '../universe'
import { easternMidnight } from '../market'
import { RULEBOOK } from './config'
import { MINUTE } from './data'

const TRADING_URL = (process.env.ALPACA_BASE_URL?.trim() || 'https://paper-api.alpaca.markets').replace(/\/+$/, '').replace(/\/v2$/, '')

export type AuditBar = { t: number; o: number; h: number; l: number; c: number }
export type AuditInput = {
  submitMs: number
  trigger: number
  limit: number
  stop: number
  target: number
  flattenMs: number | null // the real flatten time, when the real trade ended in a session flatten
  slippage: (minute: number) => number
  midnight: number
  /** Instant mode: the SIP ask shortly after sending (null when no quote was found) and when it was read. */
  instant?: { ask: number | null; at: number }
}

export const INSTANT_DELAY_MS = 2_000
export type ModelResult =
  | { filled: false; why: string }
  | { filled: true; entry: number; entryTime: number; exit: number; exitTime: number; reason: string }

// Pure model: no I/O, used by the tests.
export function modelTrade(bars: AuditBar[], input: AuditInput): ModelResult {
  const minute = (t: number) => Math.round((t - input.midnight) / MINUTE)
  if (input.instant) return instantTrade(bars, input, input.instant, minute)
  const firstActive = Math.ceil(input.submitMs / MINUTE) * MINUTE
  const expires = firstActive + RULEBOOK.fills.entryValidMinutes * MINUTE
  const start = bars.findIndex((bar) => bar.t >= firstActive)
  if (start < 0) return { filled: false, why: 'no bars after the order was sent' }
  let index = -1
  let entry = 0
  let why = 'price never reached the trigger within the valid window'
  for (let i = start; i < bars.length && bars[i].t < expires; i++) {
    const bar = bars[i]
    if (bar.h < input.trigger) continue
    const price = Math.max(input.trigger, bar.o)
    if (price > input.limit) { why = 'bar opened above the limit'; continue }
    entry = price * (1 + input.slippage(minute(bar.t)))
    index = i
    break
  }
  if (index < 0) return { filled: false, why }
  return manage(bars, index, entry, input, minute)
}

function instantTrade(bars: AuditBar[], input: AuditInput, instant: { ask: number | null; at: number }, minute: (t: number) => number): ModelResult {
  if (instant.ask == null || !(instant.ask > 0)) return { filled: false, why: 'no SIP quote found right after sending' }
  if (instant.ask > input.limit) return { filled: false, why: `SIP ask ${instant.ask} 2 s after sending was above the limit ${input.limit}` }
  const barStart = Math.floor(instant.at / MINUTE) * MINUTE
  const index = bars.findIndex((bar) => bar.t >= barStart)
  if (index < 0) return { filled: false, why: 'no bars after the order was sent' }
  return manage(bars, index, instant.ask * (1 + input.slippage(minute(barStart))), input, minute)
}

// Exit management after the fill bar (shared by both entry modes).
function manage(bars: AuditBar[], index: number, entry: number, input: AuditInput, minute: (t: number) => number): ModelResult {
  const fillBar = bars[index]
  const slip = (bar: AuditBar) => input.slippage(minute(bar.t))
  if (fillBar.c <= input.stop) return { filled: true, entry, entryTime: fillBar.t, exit: input.stop * (1 - slip(fillBar)), exitTime: fillBar.t + MINUTE, reason: 'stop (fill bar)' }
  for (let i = index + 1; i < bars.length; i++) {
    const bar = bars[i]
    if (input.flattenMs != null && bar.t >= Math.floor(input.flattenMs / MINUTE) * MINUTE) return { filled: true, entry, entryTime: fillBar.t, exit: bar.o * (1 - slip(bar)), exitTime: bar.t, reason: 'flatten' }
    if (bar.o <= input.stop) return { filled: true, entry, entryTime: fillBar.t, exit: bar.o * (1 - slip(bar)), exitTime: bar.t, reason: 'gap-stop' }
    if (bar.l <= input.stop) return { filled: true, entry, entryTime: fillBar.t, exit: input.stop * (1 - slip(bar)), exitTime: bar.t + MINUTE, reason: 'stop' }
    if (bar.h >= input.target + RULEBOOK.fills.targetThroughTicks) return { filled: true, entry, entryTime: fillBar.t, exit: Math.max(input.target, bar.o), exitTime: bar.t + MINUTE, reason: 'target' }
  }
  const last = bars[bars.length - 1]
  return { filled: true, entry, entryTime: fillBar.t, exit: last.c * (1 - slip(last)), exitTime: last.t + MINUTE, reason: 'end of data' }
}

export function sellFees(shares: number, price: number) {
  const C = RULEBOOK.costs
  return shares * price * C.secFeePerDollar + Math.min(C.finraTafMaxPerTrade, shares * C.finraTafPerShare)
}

type Row = { id: string; position_id: string; symbol: string; side: string; quantity: string; requested_price: string; filled_price: string; submitted_at: string; filled_at: string; metadata: Record<string, any> }
type AlpacaOrder = { id: string; submitted_at?: string | null; filled_at: string | null; filled_avg_price: string | null; type: string; order_type?: string; limit_price: string | null; stop_price: string | null; status: string; legs?: AlpacaOrder[] }

async function supabaseRows(): Promise<Row[]> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  const url = (process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '').replace(/\/+$/, '')
  if (!key || !url) throw new Error('Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (read only here).')
  const response = await fetch(`${url}/rest/v1/ait_trades?select=*&order=submitted_at.asc`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  if (!response.ok) throw new Error(`Supabase GET ait_trades failed (${response.status}): ${await response.text()}`)
  return response.json() as Promise<Row[]>
}

async function alpacaOrder(id: string) {
  return fetchJson<AlpacaOrder>(`${TRADING_URL}/v2/orders/${encodeURIComponent(id)}?nested=true`, 'orders')
}

const fmt = (value: number | null | undefined, digits = 4) => (value == null || !Number.isFinite(value) ? '-' : value.toFixed(digits))
const etTime = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })

async function main() {
  const out = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? 'backtests/fill-audit'
  const rows = await supabaseRows()
  const entries = rows.filter((row) => row.side === 'buy' && row.metadata?.strategy === 'E' && row.metadata?.broker === 'alpaca')
  console.log(`[audit] ${entries.length} Strategy E entries sent through Alpaca (app-simulated paper rows are skipped: they never reached the broker)`)
  console.log('[audit] entry mode: instant - model fills at the SIP ask 2 s after the order was sent (+ slippage), no fill if above the real limit')
  const SP = RULEBOOK.SP
  const spSlip = (m: number) => (m < SP.regularOpenMinute ? SP.slippagePremarket : SP.slippage)
  const sSlip = () => RULEBOOK.S.slippage
  const csv: string[] = ['date,ticker,qty,sent_et,ask_at_send,sip_ask_at_send,sip_ask_2s_after,limit,stop,target,actual_entry,actual_entry_et,actual_exit,actual_exit_et,actual_exit_type,actual_r,actual_pnl,model_sp_entry,model_sp_entry_et,model_sp_exit,model_sp_exit_et,model_sp_reason,model_sp_r,model_sp_pnl,model_s_r,model_noslip_r,entry_diff_pct,exit_diff_pct,r_diff_sp']
  const totals = { actual: 0, sp: 0, s: 0, noSlip: 0, n: 0 }
  for (const buy of entries) {
    const sell = rows.find((row) => row.side === 'sell' && row.position_id === buy.position_id)
    const day = toEasternDay(buy.submitted_at)
    const midnight = easternMidnight(day)
    const qty = Number(buy.quantity)
    const label = `${day} ${buy.symbol}`
    if (!sell) { console.log(`[audit] ${label}: still open, skipped`); continue }
    const entryOrder = buy.metadata.brokerOrderId ? await alpacaOrder(buy.metadata.brokerOrderId) : null
    const exitIds: string[] = sell.metadata?.brokerOrderIds ?? []
    const exitOrders = await Promise.all(exitIds.map(alpacaOrder))
    const exitOrder = exitOrders.find((order) => order.status === 'filled') ?? exitOrders[0] ?? null
    const actualEntry = Number(entryOrder?.filled_avg_price ?? buy.filled_price)
    const actualEntryMs = Date.parse(entryOrder?.filled_at ?? buy.filled_at)
    const actualExit = Number(exitOrder?.filled_avg_price ?? sell.filled_price)
    const actualExitMs = Date.parse(exitOrder?.filled_at ?? sell.filled_at)
    const stop = Number(sell.metadata.stopPrice)
    const target = Number(sell.metadata.targetPrice)
    const reason = String(sell.metadata.exitReason ?? '')
    const actualType = exitOrder ? `${exitOrder.order_type ?? exitOrder.type}` : 'ledger'
    // Alpaca's own send time; fallback: the ledger row is written right after the fill, ~2-3 s after the order went out.
    const submitMs = entryOrder?.submitted_at ? Date.parse(entryOrder.submitted_at) : Date.parse(buy.submitted_at) - 3_000
    const trigger = Number(buy.metadata.observedAsk ?? buy.requested_price)
    const limit = Number(buy.metadata.limitPrice ?? trigger)
    const sip = await getLatestQuote(day, buy.symbol, new Date(submitMs), 60)
    const instantAt = submitMs + INSTANT_DELAY_MS
    const sipAfter = await getLatestQuote(day, buy.symbol, new Date(instantAt), 60)
    const raw: RawBar[] = (await getMinuteBarsForDay(`audit-${day}-${buy.symbol}`, [buy.symbol], new Date(midnight + 4 * 60 * MINUTE).toISOString(), new Date(midnight + 16 * 60 * MINUTE).toISOString()))[buy.symbol] ?? []
    const bars = raw.map((bar) => ({ t: Date.parse(bar.t), o: bar.o, h: bar.h, l: bar.l, c: bar.c })).sort((a, b) => a.t - b.t)
    const flattenMs = /flatten/i.test(reason) ? actualExitMs : null
    const base = { submitMs, trigger, limit, stop, target, flattenMs, midnight, instant: { ask: sipAfter?.ap ?? null, at: instantAt } }
    const sp = modelTrade(bars, { ...base, slippage: spSlip })
    const s = modelTrade(bars, { ...base, slippage: sSlip })
    const noSlip = modelTrade(bars, { ...base, slippage: () => 0 })
    const rOf = (entry: number, exit: number) => (exit - entry) / (entry - stop)
    const actualR = rOf(actualEntry, actualExit)
    const actualPnl = qty * (actualExit - actualEntry)
    console.log(`\n[audit] ${label} x${qty} · sent ${etTime(submitMs)} · app ask ${fmt(trigger)} (SIP ask at send ${fmt(sip?.ap)}, 2 s later ${fmt(sipAfter?.ap)}) · limit ${fmt(limit)} · stop ${fmt(stop)} · target ${fmt(target)}`)
    console.log(`  actual: in ${fmt(actualEntry)} @ ${etTime(actualEntryMs)} -> out ${fmt(actualExit)} @ ${etTime(actualExitMs)} (${reason}; ${actualType}) = ${fmt(actualR, 2)}R, $${actualPnl.toFixed(2)}`)
    const line = (name: string, result: ModelResult) => result.filled
      ? `  model ${name}: in ${fmt(result.entry)} @ ${etTime(result.entryTime)} -> out ${fmt(result.exit)} @ ${etTime(result.exitTime)} (${result.reason}) = ${fmt(rOf(result.entry, result.exit), 2)}R`
      : `  model ${name}: NOT FILLED (${result.why})`
    console.log(line('SP slippage', sp))
    console.log(line('S slippage ', s))
    console.log(line('no slippage', noSlip))
    const spR = sp.filled ? rOf(sp.entry, sp.exit) : null
    const spPnl = sp.filled ? qty * (sp.exit - sp.entry) - sellFees(qty, sp.exit) : null
    if (sp.filled && spR != null) {
      totals.n += 1
      totals.actual += actualR
      totals.sp += spR
      totals.s += s.filled ? rOf(s.entry, s.exit) : 0
      totals.noSlip += noSlip.filled ? rOf(noSlip.entry, noSlip.exit) : 0
      console.log(`  difference (model SP - actual): entry ${(100 * (sp.entry / actualEntry - 1)).toFixed(2)}%, exit ${(100 * (sp.exit / actualExit - 1)).toFixed(2)}%, ${fmt(spR - actualR, 2)}R; model fees $${sellFees(qty, sp.exit).toFixed(3)}`)
    }
    csv.push([day, buy.symbol, qty, etTime(submitMs), fmt(trigger), fmt(sip?.ap), fmt(sipAfter?.ap), fmt(limit), fmt(stop), fmt(target), fmt(actualEntry), etTime(actualEntryMs), fmt(actualExit), etTime(actualExitMs), `"${reason} (${actualType})"`, fmt(actualR, 3), actualPnl.toFixed(2),
      sp.filled ? fmt(sp.entry) : 'not filled', sp.filled ? etTime(sp.entryTime) : '', sp.filled ? fmt(sp.exit) : '', sp.filled ? etTime(sp.exitTime) : '', sp.filled ? sp.reason : `"${sp.why}"`, fmt(spR, 3), spPnl == null ? '' : spPnl.toFixed(2),
      s.filled ? fmt(rOf(s.entry, s.exit), 3) : '', noSlip.filled ? fmt(rOf(noSlip.entry, noSlip.exit), 3) : '',
      sp.filled ? (100 * (sp.entry / actualEntry - 1)).toFixed(3) : '', sp.filled ? (100 * (sp.exit / actualExit - 1)).toFixed(3) : '', spR == null ? '' : fmt(spR - actualR, 3)].join(','))
  }
  flushQuoteCache()
  if (totals.n) console.log(`\n[audit] ${totals.n} trades filled in both: actual ${totals.actual.toFixed(2)}R · model SP ${totals.sp.toFixed(2)}R · model S ${totals.s.toFixed(2)}R · model no-slip ${totals.noSlip.toFixed(2)}R · model SP - actual ${(totals.sp - totals.actual).toFixed(2)}R (${((totals.sp - totals.actual) / totals.n).toFixed(2)}R per trade)`)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'audit.csv'), csv.join('\n') + '\n')
  console.log(`[audit] wrote ${join(out, 'audit.csv')}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    flushQuoteCache()
    console.error(error)
    process.exit(1)
  })
}
