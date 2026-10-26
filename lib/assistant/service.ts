// Assistant mode server logic: fill import, journal, scanner rows and alerts. READ-ONLY toward Alpaca.
import { loadEnrichedCandidates } from '@/lib/scan-data'
import { ASSISTANT } from '@/lib/assistant/config'
import { assertSeparateAccount, manualFillsSince, marketData, type ManualAccount } from '@/lib/assistant/alpaca-read'
import { edgarDaily, type EdgarDaily } from '@/lib/assistant/edgar'
import { dailyLimits, edgeReadout, etDay, etMinute, groupStats, journalTrades, priceBand, roundTrips, stats, timeBucket, type Fill, type Plan } from '@/lib/assistant/journal'
import { alertText, DEFAULT_FILTERS, failedFilters, haltStatus, inferHalt, shouldAlert, type Filters, type Halt, type ScannerRow } from '@/lib/assistant/scanner'
import { pushAll } from '@/lib/assistant/push'
import { insert, select, upsert } from '@/lib/assistant/store'

export type Settings = { filters: Filters; maxLossPct: number; maxTrades: number; setups: string[] }

export async function loadSettings(): Promise<Settings> {
  const [row] = await select<{ filters: Partial<Filters>; max_loss_pct: number; max_trades: number; setups: string[] }>('ait_assistant_settings', { select: '*', id: 'eq.1' })
  return { filters: { ...DEFAULT_FILTERS, ...(row?.filters ?? {}) }, maxLossPct: Number(row?.max_loss_pct ?? ASSISTANT.dailyMaxLossPct), maxTrades: Number(row?.max_trades ?? ASSISTANT.maxTrades), setups: row?.setups ?? [] }
}

// ---------------- journal ----------------

/** Imports new fills of the manual account (the guard runs first) and records today's starting equity once. */
export async function importFills(now = new Date()) {
  const account = await assertSeparateAccount()
  const day = etDay(now.toISOString())
  const [known] = await select<{ day: string }>('ait_assistant_days', { select: 'day', day: `eq.${day}` })
  if (!known) await upsert('ait_assistant_days', [{ day, start_equity: account.last_equity }], 'day')
  const [last] = await select<{ transaction_time: string }>('ait_manual_fills', { select: 'transaction_time', account_id: `eq.${account.id}`, order: 'transaction_time.desc', limit: '1' })
  const after = last?.transaction_time ?? new Date(now.getTime() - 90 * 86_400_000).toISOString()
  const fills = await manualFillsSince(new Date(Date.parse(after) - 60_000).toISOString())
  if (fills.length) await upsert('ait_manual_fills', fills.map((f) => ({ id: f.id, account_id: account.id, mode: account.mode, symbol: f.symbol, side: f.side, qty: Number(f.qty), price: Number(f.price), transaction_time: f.transaction_time, order_id: f.order_id })), 'id')
  return { account: { mode: account.mode, equity: account.equity }, imported: fills.length }
}

export async function loadJournal(account: ManualAccount, now = new Date()) {
  const settings = await loadSettings()
  const [fillRows, planRows, notes, days] = await Promise.all([
    select<{ id: string; symbol: string; side: Fill['side']; qty: number; price: number; transaction_time: string; order_id: string; mode: Fill['mode'] }>('ait_manual_fills', { select: '*', account_id: `eq.${account.id}`, order: 'transaction_time.asc', limit: '10000' }),
    select<{ id: string; symbol: string; entry: number; stop: number; setup: string | null; created_at: string }>('ait_trade_plans', { select: '*', order: 'created_at.asc', limit: '10000' }),
    select<{ trade_key: string; setup: string | null; notes: string | null; stop: number | null; screenshot_path: string | null }>('ait_manual_trade_notes', { select: '*', limit: '10000' }),
    select<{ day: string; start_equity: number }>('ait_assistant_days', { select: '*', limit: '10000' }),
  ])
  const fills: Fill[] = fillRows.map((f) => ({ id: f.id, symbol: f.symbol, side: f.side, qty: Number(f.qty), price: Number(f.price), at: f.transaction_time, orderId: f.order_id, mode: f.mode }))
  const plans: Plan[] = planRows.map((p) => ({ id: p.id, symbol: p.symbol, entry: Number(p.entry), stop: Number(p.stop), setup: p.setup ?? undefined, createdAt: p.created_at }))
  const trips = roundTrips(fills)
  const today = etDay(now.toISOString())
  const equityByDay = new Map(days.map((d) => [d.day, Number(d.start_equity)]))
  equityByDay.set(today, equityByDay.get(today) ?? account.last_equity)
  const after = new Set<string>()
  let todayLimits = null
  for (const day of new Set(trips.map((t) => t.day).concat(today))) {
    const r = dailyLimits(trips, day, equityByDay.get(day) ?? 0, settings.maxLossPct, settings.maxTrades)
    for (const k of r.afterLimit) after.add(k)
    if (day === today) todayLimits = r.limits
  }
  const edits = new Map(notes.map((n) => [n.trade_key, { setup: n.setup ?? undefined, notes: n.notes ?? undefined, stop: n.stop == null ? null : Number(n.stop), screenshot: n.screenshot_path }]))
  const trades = journalTrades(trips, plans, edits, after).sort((a, b) => b.entryAt.localeCompare(a.entryAt))
  const closed = trades.filter((t) => !t.open)
  return {
    account: { mode: account.mode, equity: account.equity, dayStartEquity: account.last_equity, buyingPower: account.buying_power },
    limits: todayLimits, trades,
    stats: {
      paper: stats(closed.filter((t) => t.mode === 'paper')), live: stats(closed.filter((t) => t.mode === 'live')),
      bySetup: groupStats(closed, (t) => `${t.mode} · ${t.setup}`), byTime: groupStats(closed, (t) => `${t.mode} · ${timeBucket(t.entryAt)}`), byPrice: groupStats(closed, (t) => `${t.mode} · ${priceBand(t.avgEntry)}`),
    },
    edge: edgeReadout(closed),
    settings,
  }
}

// ---------------- scanner ----------------

type Snap = { latestTrade?: { p?: number; t?: string }; latestQuote?: { bp?: number; ap?: number; t?: string }; dailyBar?: { c?: number; v?: number }; prevDailyBar?: { c?: number } }

async function edgarFor(symbols: string[], day: string, budget = 8) {
  const cached = symbols.length ? await select<{ symbol: string; payload: EdgarDaily }>('ait_edgar_daily', { select: 'symbol,payload', day: `eq.${day}`, symbol: `in.(${symbols.map((s) => `"${s}"`).join(',')})` }) : []
  const out = new Map(cached.map((c) => [c.symbol, c.payload]))
  // only a few new companies per request, so the panel stays fast; the rest fill in on the next refresh
  for (const symbol of symbols.filter((s) => !out.has(s)).slice(0, budget)) {
    try {
      const e = await edgarDaily(symbol, day)
      out.set(symbol, e)
      await upsert('ait_edgar_daily', [{ symbol, day, payload: e }], 'symbol,day')
    } catch (error) { console.warn('[assistant] EDGAR lookup failed', { symbol, error: error instanceof Error ? error.message : error }) }
  }
  return out
}

async function streamHalts(symbols: string[], since: Date): Promise<Map<string, Halt>> {
  if (!symbols.length) return new Map()
  const rows = await select<{ symbol: string; status: Halt['status']; reason: string | null; at: string }>('ait_assistant_halts', { select: 'symbol,status,reason,at', symbol: `in.(${symbols.map((s) => `"${s}"`).join(',')})`, at: `gte.${since.toISOString()}`, order: 'at.desc', limit: '500' })
  const out = new Map<string, Halt>()
  for (const r of rows) if (!out.has(r.symbol)) out.set(r.symbol, { status: r.status, at: r.at, reason: r.reason })
  return out
}

export async function scannerRows(now = new Date()): Promise<ScannerRow[]> {
  const day = etDay(now.toISOString())
  const minute = etMinute(now.toISOString())
  const movers = await marketData<{ gainers?: Array<{ symbol?: string; percent_change?: number; price?: number }> }>(`/v1beta1/screener/stocks/movers?top=${ASSISTANT.scannerTop}`)
  const symbols = [...new Set((movers.gainers ?? []).filter((g) => (g.percent_change ?? 0) >= ASSISTANT.scannerMinGain && (g.price ?? 0) >= ASSISTANT.scannerMinPrice).map((g) => g.symbol!.toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.]{0,9}$/.test(s)))]
  if (!symbols.length) return []
  const snaps = await marketData<Record<string, Snap>>(`/v2/stocks/snapshots?symbols=${symbols.join(',')}&feed=sip`)
  const [enriched, news, edgar, halts] = await Promise.all([
    loadEnrichedCandidates(symbols, snaps, now).catch(() => ({ candidates: [], failures: [] })),
    marketData<{ news?: Array<{ headline?: string; symbols?: string[]; created_at?: string }> }>(`/v1beta1/news?symbols=${symbols.join(',')}&start=${new Date(now.getTime() - 24 * 3_600_000).toISOString()}&limit=50&sort=desc`).catch(() => ({ news: [] })),
    edgarFor(symbols, day),
    streamHalts(symbols, new Date(now.getTime() - (minute + 1) * 60_000)).catch(() => new Map<string, Halt>()),
  ])
  const bySymbol = new Map(enriched.candidates.map((c) => [c.symbol, c]))
  return symbols.map((symbol): ScannerRow => {
    const s = snaps[symbol] ?? {}
    const c = bySymbol.get(symbol)
    const story = (news.news ?? []).filter((n) => n.symbols?.includes(symbol)).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0]
    const e = edgar.get(symbol)
    const price = Number(s.latestTrade?.p ?? s.dailyBar?.c ?? 0)
    const prev = Number(s.prevDailyBar?.c ?? 0)
    const bid = Number(s.latestQuote?.bp ?? 0), ask = Number(s.latestQuote?.ap ?? 0)
    return {
      symbol, name: e?.name ?? c?.companyName ?? null, price, gainPct: price > 0 && prev > 0 ? (price / prev - 1) * 100 : null, volume: c?.volume ?? (s.dailyBar?.v ?? null),
      relativeVolume: c?.relativeVolume ?? null, relativeVolumeReliable: Boolean(c?.relativeVolumeReliable), spreadPct: bid > 0 && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null,
      float: e?.filer === 'foreign' ? null : e?.float?.shares ?? null, floatSource: e?.float && e.filer !== 'foreign' ? 'edgar' : null,
      floatMiss: e ? (e.filer === 'foreign' ? 'foreign filer (20-F / 40-F)' : e.floatMiss) : 'EDGAR loading', floatAsOf: e?.float?.asOf ?? null, fmpFloat: c?.float ?? null, filer: e?.filer ?? 'unknown',
      headline: story?.headline ?? null, headlineAt: story?.created_at ?? null, headlineAgeMin: story?.created_at ? Math.max(0, Math.round((now.getTime() - Date.parse(story.created_at)) / 60_000)) : null,
      halt: haltStatus(halts.get(symbol) ?? null, inferHalt(s.latestTrade?.t ?? null, now, minute)),
      dilution: { flagged: Boolean(e?.dilution.flagged), forms: [...(e?.dilution.filings ?? []), ...(e?.dilution.atm ?? [])].map((f) => `${f.form} ${f.filed}`), links: [...(e?.dilution.filings ?? []), ...(e?.dilution.atm ?? [])].map((f) => f.url) },
      lastTradeAt: s.latestTrade?.t ?? null,
    }
  }).sort((a, b) => (b.gainPct ?? -1) - (a.gainPct ?? -1))
}

// ---------------- alerts ----------------

/** Called by the assistant service every 15 s, 07:00-11:00 ET. Sends pushes; never an order. */
export async function runAlerts(now = new Date()) {
  const settings = await loadSettings()
  const minute = etMinute(now.toISOString())
  if (minute < settings.filters.windowStart || minute >= settings.filters.windowEnd) return { skipped: 'outside the alert window' }
  const day = etDay(now.toISOString())
  const rows = await scannerRows(now)
  const matches = rows.filter((r) => failedFilters(r, settings.filters, minute).length === 0)
  const sent: string[] = []
  for (const row of matches) {
    const [prev] = await select<{ price: number }>('ait_assistant_alerts', { select: 'price', day: `eq.${day}`, symbol: `eq.${row.symbol}`, order: 'sent_at.desc', limit: '1' })
    if (!shouldAlert(prev ? { price: Number(prev.price) } : null, row, settings.filters)) continue
    await pushAll(alertText(row))
    await insert('ait_assistant_alerts', [{ day, symbol: row.symbol, price: row.price, payload: row }])
    sent.push(row.symbol)
  }
  return { rows: rows.length, matches: matches.length, sent }
}

/** Once per day when a limit is first hit: one push. */
export async function limitPush(limits: { lossHit: boolean; tradesHit: boolean; day: string } | null) {
  if (!limits || (!limits.lossHit && !limits.tradesHit)) return null
  const symbol = limits.lossHit ? 'LIMIT:LOSS' : 'LIMIT:TRADES'
  const [prev] = await select<{ id: number }>('ait_assistant_alerts', { select: 'id', day: `eq.${limits.day}`, symbol: `eq.${symbol}`, limit: '1' })
  if (prev) return null
  await pushAll({ title: limits.lossHit ? 'Daily max loss hit' : 'Max trades hit', body: 'Your daily limit for manual trades is reached. Assistant only; no order was sent.' })
  await insert('ait_assistant_alerts', [{ day: limits.day, symbol, price: 0, payload: limits }])
  return symbol
}
