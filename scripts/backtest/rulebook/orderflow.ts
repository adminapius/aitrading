// Order-flow diagnostic (Step A) - BACKTEST ONLY, NO TRADING RULES. Spec: docs/orderflow-step-a-spec.md
//
//   1) measure first:  npx tsx scripts/backtest/rulebook/orderflow.ts --probe=8
//   2) then, if approved: npx tsx scripts/backtest/rulebook/orderflow.ts --all
//
// For the 174 Step 2b setups (read from backtests/sp-runner-v3/trades.csv, run SPR2B) it downloads SIP trades + quotes
// 7:00-11:30 ET for the one stock of each day, classifies every trade (at/above ask = buy, at/below bid = sell, in
// between = tick rule; odd lots and flagged prints excluded), and keeps only per-minute buy/sell volume (cached per day,
// raw ticks are never stored). --all then prints the Step A report.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchJson, readCache, writeCache } from '../data'
import { easternMidnight } from '../market'
import { RULEBOOK } from './config'
import { minuteIn } from './common'
import { loadReference, setFifteenWindow, MINUTE } from './data'
import { addDays, loadDay, parseArgs, RUNNER, runnerSignal } from './runner'

const DATA_URL = 'https://data.alpaca.markets'
export const OF = {
  start: 7 * 60,
  end: 11 * 60 + 30,
  oddLot: 100, // prints under 100 shares are odd lots
  // SIP sale conditions excluded (not regular, current, two-sided prints). 'T' (extended hours) and 'F' (ISO) are kept.
  excluded: ['I', 'W', 'Z', 'U', '4', '7', '9', 'C', 'N', 'R', 'P', 'V', 'M', 'Q', 'O', '6', 'H', 'B', 'G', 'L'],
  parallelDays: 4,
  cacheKey: (day: string, symbol: string) => `orderflow/v1/${day}/${symbol}`,
} as const

type Quote = { t: number; bid: number; ask: number }
type Tick = { t: number; p: number; s: number; c: string[] }
export type FlowDay = {
  day: string
  symbol: string
  /** per-minute volumes, index = minute - OF.start (7:00 = 0) */
  buy: number[]
  sell: number[]
  unclassified: number[]
  counts: { trades: number; kept: number; oddLot: number; flagged: number; quotes: number; pages: number; atAsk: number; atBid: number; tick: number }
}

/** Classify trades in time order against the latest quote at or before each trade. Pure, used by the tests. */
export function classifyTrades(trades: Tick[], quotes: Quote[], midnight: number) {
  const slots = OF.end - OF.start
  const buy = new Array(slots).fill(0)
  const sell = new Array(slots).fill(0)
  const unclassified = new Array(slots).fill(0)
  const excluded = new Set<string>(OF.excluded)
  const counts = { trades: trades.length, kept: 0, oddLot: 0, flagged: 0, atAsk: 0, atBid: 0, tick: 0 }
  let q = -1
  let lastPrice = Number.NaN
  let lastDirection = 0
  for (const trade of trades) {
    if (trade.s < OF.oddLot) { counts.oddLot += 1; continue }
    if (trade.c.some((code) => excluded.has(code))) { counts.flagged += 1; continue }
    while (q + 1 < quotes.length && quotes[q + 1].t <= trade.t) q += 1
    const quote = q >= 0 ? quotes[q] : null
    // tick rule state uses every kept trade
    if (Number.isFinite(lastPrice) && trade.p !== lastPrice) lastDirection = trade.p > lastPrice ? 1 : -1
    lastPrice = trade.p
    let side = 0
    if (quote && trade.p >= quote.ask) { side = 1; counts.atAsk += 1 }
    else if (quote && trade.p <= quote.bid) { side = -1; counts.atBid += 1 }
    else { side = lastDirection; if (side !== 0) counts.tick += 1 }
    // trades carry exact timestamps: the minute they fall in (rounded down), not the nearest bar time
    const slot = Math.floor((trade.t - midnight) / MINUTE) - OF.start
    if (slot < 0 || slot >= slots) continue
    counts.kept += 1
    if (side > 0) buy[slot] += trade.s
    else if (side < 0) sell[slot] += trade.s
    else unclassified[slot] += trade.s
  }
  return { buy, sell, unclassified, counts }
}

async function paged<T>(path: string, field: 'trades' | 'quotes', start: string, end: string, onPage: (items: T[]) => void) {
  let token: string | undefined
  let pages = 0
  do {
    const search = new URLSearchParams({ start, end, limit: '10000', feed: 'sip', sort: 'asc' })
    if (token) search.set('page_token', token)
    const payload = await fetchJson<Record<string, unknown> & { next_page_token?: string | null }>(`${DATA_URL}${path}?${search}`, `orderflow-${field}`)
    onPage((payload[field] as T[] | null) ?? [])
    token = payload.next_page_token ?? undefined
    pages += 1
  } while (token)
  return pages
}

export async function loadFlowDay(day: string, symbol: string): Promise<FlowDay & { cached: boolean }> {
  const hit = readCache<FlowDay>(OF.cacheKey(day, symbol))
  if (hit) return { ...hit, cached: true }
  const midnight = easternMidnight(day)
  const start = new Date(midnight + OF.start * MINUTE).toISOString()
  const end = new Date(midnight + OF.end * MINUTE).toISOString()
  const sym = encodeURIComponent(symbol)
  const quotes: Quote[] = []
  const trades: Tick[] = []
  const [quotePages, tradePages] = await Promise.all([
    paged<{ t: string; bp: number; ap: number }>(`/v2/stocks/${sym}/quotes`, 'quotes', start, end, (items) => {
      for (const item of items) if (item.bp > 0 && item.ap > 0 && item.ap >= item.bp) quotes.push({ t: Date.parse(item.t), bid: item.bp, ask: item.ap })
    }),
    paged<{ t: string; p: number; s: number; c?: string[] }>(`/v2/stocks/${sym}/trades`, 'trades', start, end, (items) => {
      for (const item of items) trades.push({ t: Date.parse(item.t), p: item.p, s: item.s, c: item.c ?? [] })
    }),
  ])
  const result = classifyTrades(trades, quotes, midnight)
  const flow: FlowDay = { day, symbol, buy: result.buy, sell: result.sell, unclassified: result.unclassified, counts: { ...result.counts, quotes: quotes.length, pages: quotePages + tradePages } }
  writeCache(OF.cacheKey(day, symbol), flow)
  return { ...flow, cached: false }
}

// ---------------- setups (the 174 Step 2b trades) ----------------
type Setup = { day: string; symbol: string; catchMinute: number; signalMinute: number; entryMinute: number; exitMinute: number; r: number; mfe: number
  close: number[]; high: number[] } // per-minute close/high 7:00-11:30 (NaN when no bar)

export function readStep2b(path: string) {
  if (!existsSync(path)) throw new Error(`Missing ${path}. It comes from the v3 sanity run (backtests/sp-runner-v3).`)
  const [head, ...lines] = readFileSync(path, 'utf8').trim().split(/\r?\n/)
  const cols = head.split(',')
  const at = (name: string) => cols.indexOf(name)
  return lines.map((line) => line.split(',')).filter((row) => row[at('run')] === 'SPR2B').map((row) => ({
    day: row[at('date')], symbol: row[at('ticker')], entry: row[at('entry_time')], exit: row[at('exit_time')], r: Number(row[at('r_result')]), mfe: Number(row[at('mfe_r')]),
  }))
}
const hhmmToMinute = (stamp: string) => { const [h, m] = stamp.slice(11, 16).split(':').map(Number); return h * 60 + m }

async function loadSetups(): Promise<Setup[]> {
  const rows = readStep2b(join(process.cwd(), 'backtests/sp-runner-v3/trades.csv'))
  const P = RULEBOOK.period
  setFifteenWindow(addDays(P.start, -45), P.end)
  const ref = await loadReference(addDays(P.start, -420), P.start, P.end)
  const setups: Setup[] = []
  for (const row of rows) {
    const midnight = easternMidnight(row.day)
    const input = (await loadDay(ref, row.day)).find((item) => item.symbol === row.symbol)
    if (!input) throw new Error(`setup ${row.day} ${row.symbol} not found in the scanner data`)
    let catchMinute = -1
    for (let m = RUNNER.scanStart; m <= RUNNER.scanEnd; m += 1) if (input.eligible[m] === 1) { catchMinute = m; break }
    const signal = runnerSignal(input, row.day, midnight, { entryEnd: RUNNER.bracket.entryEnd, structuralStop: false })
    const close = new Array(OF.end - OF.start).fill(Number.NaN)
    const high = new Array(OF.end - OF.start).fill(Number.NaN)
    for (const bar of input.bars) { const slot = minuteIn(midnight, bar.t) - OF.start; if (slot >= 0 && slot < close.length) { close[slot] = bar.c; high[slot] = bar.h } }
    setups.push({ day: row.day, symbol: row.symbol, catchMinute, signalMinute: signal?.minute ?? hhmmToMinute(row.entry), entryMinute: hhmmToMinute(row.entry), exitMinute: hhmmToMinute(row.exit), r: row.r, mfe: row.mfe, close, high })
  }
  return setups
}

// ---------------- report ----------------
const sum = (xs: number[], from: number, to: number) => { let s = 0; for (let i = Math.max(0, from); i <= Math.min(xs.length - 1, to); i += 1) s += xs[i]; return s }
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a')
const median = (xs: number[]) => { if (!xs.length) return Number.NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)] }
const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

function quintileTable(title: string, rows: Array<{ x: number; setup: Setup }>) {
  const valid = rows.filter((row) => Number.isFinite(row.x)).sort((a, b) => a.x - b.x)
  console.log(`\n[of] ${title} (${valid.length} setups; Q1 = lowest)`)
  console.log('      group   n   range                     avg R   win %   avg MFE   total R')
  for (let q = 0; q < 5; q += 1) {
    const part = valid.slice(Math.floor((q * valid.length) / 5), Math.floor(((q + 1) * valid.length) / 5))
    if (!part.length) continue
    const rs = part.map((row) => row.setup.r)
    const wins = rs.filter((r) => r > 0).length
    console.log(`      Q${q + 1}   ${String(part.length).padStart(3)}   ${fmt(part[0].x, 3).padStart(8)} to ${fmt(part.at(-1)!.x, 3).padStart(8)}   ${fmt(rs.reduce((a, b) => a + b, 0) / rs.length).padStart(6)}  ${String(Math.round((100 * wins) / rs.length)).padStart(5)}%   ${fmt(part.reduce((a, row) => a + row.setup.mfe, 0) / part.length).padStart(7)}   ${fmt(rs.reduce((a, b) => a + b, 0), 1).padStart(7)}`)
  }
}

function report(pairs: Array<{ setup: Setup; flow: FlowDay }>, out: string) {
  const deltaAt = (flow: FlowDay) => flow.buy.map((b, i) => b - flow.sell[i])
  const volAt = (flow: FlowDay) => flow.buy.map((b, i) => b + flow.sell[i])
  const totals = pairs.reduce((acc, { flow }) => { for (const k of Object.keys(acc) as Array<keyof typeof acc>) acc[k] += flow.counts[k]; return acc }, { trades: 0, kept: 0, oddLot: 0, flagged: 0, atAsk: 0, atBid: 0, tick: 0, quotes: 0 })
  console.log(`\n[of] ===== ORDER-FLOW DIAGNOSTIC (Step A, information only) - ${pairs.length} Step 2b setups =====`)
  console.log(`[of] prints: ${totals.trades} trades, ${totals.oddLot} odd lots and ${totals.flagged} flagged excluded, ${totals.kept} kept: at/above ask ${totals.atAsk}, at/below bid ${totals.atBid}, tick rule ${totals.tick}; ${totals.quotes} quotes`)

  // 1) cumulative delta from the scanner catch to the entry signal (closed bars only), as a share of classified volume
  const rows1: Array<{ x: number; setup: Setup }> = []
  const rows1raw: Array<{ x: number; setup: Setup }> = []
  const rows2: Array<{ x: number; setup: Setup }> = []
  const csv = ['date,ticker,catch,signal,r_2b,mfe_2b,cum_delta,cum_volume,cum_delta_pct,delta5_before,volume5_before,delta5_pct']
  for (const { setup, flow } of pairs) {
    const d = deltaAt(flow)
    const v = volAt(flow)
    const from = setup.catchMinute - OF.start
    const to = setup.signalMinute - 1 - OF.start // the signal bar closed at signalMinute
    const cum = sum(d, from, to)
    const cumVol = sum(v, from, to)
    const d5 = sum(d, to - 4, to)
    const v5 = sum(v, to - 4, to)
    rows1.push({ x: cumVol > 0 ? cum / cumVol : Number.NaN, setup })
    rows1raw.push({ x: cum, setup })
    rows2.push({ x: v5 > 0 ? d5 / v5 : Number.NaN, setup })
    csv.push([setup.day, setup.symbol, hhmm(setup.catchMinute), hhmm(setup.signalMinute), setup.r.toFixed(3), setup.mfe.toFixed(2), cum, cumVol, cumVol > 0 ? (cum / cumVol).toFixed(4) : '', d5, v5, v5 > 0 ? (d5 / v5).toFixed(4) : ''].join(','))
  }
  quintileTable('1) cumulative delta from the scanner catch to entry, as % of classified volume (primary)', rows1)
  quintileTable('1b) cumulative delta from the scanner catch to entry, raw shares', rows1raw)
  quintileTable('2) delta over the 5 minutes before entry, as % of their classified volume', rows2)

  // 3) big red 1-minute bars: delta <= -50% of that minute's classified volume AND volume >= 3x the median minute since the catch
  const events: number[][] = [] // [ret15, ret30]
  const base: number[][] = []
  for (const { setup, flow } of pairs) {
    const d = deltaAt(flow)
    const v = volAt(flow)
    const from = Math.max(0, setup.catchMinute - OF.start)
    const lastStart = (11 * 60) - OF.start // events up to 11:00 so +30 stays inside 11:30
    for (let i = from; i < lastStart; i += 1) {
      const c0 = setup.close[i]
      const c15 = setup.close.slice(i + 15, i + 16)[0]
      const c30 = setup.close.slice(i + 30, i + 31)[0]
      if (!Number.isFinite(c0) || !Number.isFinite(c15) || !Number.isFinite(c30) || v[i] <= 0) continue
      const pair = [c15 / c0 - 1, c30 / c0 - 1]
      base.push(pair)
      const med = median(v.slice(from, i + 1).filter((x) => x > 0))
      if (d[i] <= -0.5 * v[i] && v[i] >= 3 * med) events.push(pair)
    }
  }
  const describe = (list: number[][], k: number) => `mean ${fmt(100 * list.reduce((a, x) => a + x[k], 0) / Math.max(1, list.length))}%, median ${fmt(100 * median(list.map((x) => x[k])))}%, lower ${Math.round((100 * list.filter((x) => x[k] < 0).length) / Math.max(1, list.length))}%`
  console.log(`\n[of] 3) big red 1-min bars (delta <= -50% of the minute's volume, volume >= 3x the median minute since the catch), catch to 11:00`)
  console.log(`      events ${events.length}: next 15 min ${describe(events, 0)} | next 30 min ${describe(events, 1)}`)
  console.log(`      all minutes ${base.length} (baseline): next 15 min ${describe(base, 0)} | next 30 min ${describe(base, 1)}`)

  // 4) trades still open at 9:30: does a 5-min delta flip (positive -> negative) come before the 9:30-11:30 high?
  let survived = 0
  let flipBefore = 0
  let flipAfterOrNone = 0
  let topAt930 = 0
  const leads: number[] = []
  const falseFlips: number[] = []
  for (const { setup, flow } of pairs) {
    if (setup.exitMinute <= RULEBOOK.SP.regularOpenMinute) continue
    survived += 1
    const d = deltaAt(flow)
    const open = RULEBOOK.SP.regularOpenMinute - OF.start
    let top = -1
    for (let i = open; i < setup.high.length; i += 1) if (Number.isFinite(setup.high[i]) && (top < 0 || setup.high[i] > setup.high[top])) top = i
    if (top <= open) { topAt930 += 1; continue }
    const flips: number[] = []
    for (let i = open; i <= top; i += 1) if (sum(d, i - 5, i - 1) > 0 && sum(d, i - 4, i) < 0) flips.push(i)
    if (flips.length) { flipBefore += 1; leads.push(top - flips.at(-1)!); falseFlips.push(flips.length - 1) }
    else flipAfterOrNone += 1
  }
  console.log(`\n[of] 4) setups still open at 9:30 (Step 2b): ${survived}; high of 9:30-11:30 made in the 9:30 minute: ${topAt930}`)
  console.log(`      a 5-min delta flip (+ to -) came before the high: ${flipBefore}; no flip before the high: ${flipAfterOrNone}`)
  console.log(`      minutes from the last flip to the high: median ${fmt(median(leads), 0)}; earlier flips that were NOT the top (false alarms) per setup: median ${fmt(median(falseFlips), 0)}, total ${falseFlips.reduce((a, b) => a + b, 0)}`)
  console.log('\n[of] Reading rule (locked in the spec): see docs/orderflow-step-a-spec.md. No fitting.')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'setups.csv'), csv.join('\n') + '\n')
  console.log(`[of] wrote ${join(out, 'setups.csv')}`)
}

async function main() {
  const args = parseArgs()
  const out = join(process.cwd(), args.get('out') ?? 'backtests/orderflow')
  const probe = args.has('probe') ? Number(args.get('probe') === 'true' ? 8 : args.get('probe')) : 0
  if (!probe && args.get('all') !== 'true') throw new Error('Run --probe=8 first to measure the download, then --all.')
  const setups = await loadSetups()
  console.log(`[of] ${setups.length} Step 2b setups loaded`)
  const chosen = probe ? Array.from({ length: Math.min(probe, setups.length) }, (_, k) => setups[Math.floor((k * setups.length) / Math.min(probe, setups.length))]) : setups
  const pairs: Array<{ setup: Setup; flow: FlowDay }> = []
  const started = Date.now()
  let downloaded = 0
  for (let i = 0; i < chosen.length; i += OF.parallelDays) {
    const batch = chosen.slice(i, i + OF.parallelDays)
    const results = await Promise.all(batch.map(async (setup) => {
      const t0 = Date.now()
      const flow = await loadFlowDay(setup.day, setup.symbol)
      if (!flow.cached) downloaded += 1
      if (probe) console.log(`[of] probe ${setup.day} ${setup.symbol}: ${flow.counts.trades} trades, ${flow.counts.quotes} quotes, ${flow.counts.pages} pages, ${((Date.now() - t0) / 1000).toFixed(0)}s${flow.cached ? ' (cached)' : ''}`)
      return { setup, flow }
    }))
    pairs.push(...results)
    if (!probe) console.log(`[of] ${Math.min(i + OF.parallelDays, chosen.length)}/${chosen.length} days, ${((Date.now() - started) / 60000).toFixed(1)} min`)
  }
  if (probe) {
    const n = pairs.length
    const trades = pairs.reduce((a, p) => a + p.flow.counts.trades, 0) / n
    const quotes = pairs.reduce((a, p) => a + p.flow.counts.quotes, 0) / n
    const pages = pairs.reduce((a, p) => a + p.flow.counts.pages, 0) / n
    const minutes = (Date.now() - started) / 60000
    const perDay = downloaded ? minutes / downloaded : Number.NaN
    // JSON size per print as returned by Alpaca (about 120 bytes per trade, 110 per quote, uncompressed)
    const gb = ((trades * 120 + quotes * 110) * setups.length) / 1e9
    console.log(`\n[of] PROBE: ${n} days. Per day: ${Math.round(trades)} trades, ${Math.round(quotes)} quotes, ${pages.toFixed(1)} pages.`)
    console.log(`[of] Estimate for all ${setups.length} days: ${Math.round(pages * setups.length)} requests, about ${gb.toFixed(1)} GB of JSON from Alpaca (uncompressed; less over the wire),`)
    console.log(`[of] about ${Number.isFinite(perDay) ? (perDay * (setups.length - n)).toFixed(0) : 'n/a'} more minutes at this speed (${OF.parallelDays} days in parallel). Disk use: only per-minute totals, under 5 MB.`)
    console.log('[of] Probe days are cached and will not be downloaded again by --all.')
    return
  }
  report(pairs, out)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[of] failed', error)
    process.exitCode = 1
  })
}
