import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

export type RawBar = { t: string; o: number; h: number; l: number; c: number; v: number; vw?: number; n?: number }
export type Asset = { symbol: string; name?: string; class?: string; status?: string; exchange?: string }
export type NewsStory = { id: number; headline?: string; summary?: string; symbols?: string[]; created_at?: string }
export type HistoricalQuote = { t: string; bp: number; ap: number } | null

const DATA_URL = 'https://data.alpaca.markets'
const TRADING_URL = (process.env.ALPACA_BASE_URL?.trim() || 'https://paper-api.alpaca.markets').replace(/\/+$/, '').replace(/\/v2$/, '')
export const HISTORICAL_FEED = process.env.BACKTEST_FEED?.trim() || process.env.ALPACA_DATA_FEED?.trim() || 'sip'
export const CACHE_ROOT = join(process.cwd(), '.cache', 'backtest')

export const apiStats = { alpaca: 0, alpacaCached: 0, fmp: 0, fmpCached: 0, retries: 0, byKind: {} as Record<string, number> }

let cacheOnly = false
export function setCacheOnly(value: boolean) {
  cacheOnly = value
}

function cachePath(key: string) {
  return join(CACHE_ROOT, `${key}.json.gz`)
}

export function readCache<T>(key: string): T | undefined {
  const path = cachePath(key)
  if (!existsSync(path)) return undefined
  return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as T
}

export function writeCache(key: string, value: unknown) {
  const path = cachePath(key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(value))))
}

async function cached<T>(key: string, kind: 'alpaca' | 'fmp', load: () => Promise<T>): Promise<T> {
  const hit = readCache<T>(key)
  if (hit !== undefined) {
    if (kind === 'alpaca') apiStats.alpacaCached += 1
    else apiStats.fmpCached += 1
    return hit
  }
  if (cacheOnly) throw new Error(`Cache miss for ${key} in --cache-only mode`)
  const value = await load()
  writeCache(key, value)
  return value
}

export function hashKey(values: string[]) {
  return createHash('sha1').update(values.join(',')).digest('hex').slice(0, 16)
}

const MAX_CONCURRENCY = 16
let active = 0
const waiting: Array<() => void> = []

async function withSlot<T>(task: () => Promise<T>) {
  if (active >= MAX_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve))
  active += 1
  try {
    return await task()
  } finally {
    active -= 1
    waiting.shift()?.()
  }
}

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY ?? '',
    'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET?.trim() || process.env.ALPACA_SECRET?.trim() || '',
  }
}

async function fetchJson<T>(url: string, kind: string, source: 'alpaca' | 'fmp' = 'alpaca'): Promise<T> {
  return withSlot(async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (source === 'alpaca') apiStats.alpaca += 1
      else apiStats.fmp += 1
      apiStats.byKind[kind] = (apiStats.byKind[kind] ?? 0) + 1
      try {
        const response = await fetch(url, { headers: source === 'alpaca' ? alpacaHeaders() : {}, signal: AbortSignal.timeout(60_000) })
        if (response.status === 429 || response.status >= 500) {
          apiStats.retries += 1
          await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt))
          continue
        }
        if (!response.ok) throw new Error(`${kind} HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
        return await response.json() as T
      } catch (error) {
        if (attempt === 5 || (error instanceof Error && error.message.startsWith(`${kind} HTTP`))) throw error
        apiStats.retries += 1
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt))
      }
    }
    throw new Error(`${kind} exhausted retries`)
  })
}

async function pagedBars(path: string, params: Record<string, string>, kind: string) {
  const out: Record<string, RawBar[]> = {}
  let token: string | undefined
  do {
    const search = new URLSearchParams({ ...params, limit: '10000', feed: HISTORICAL_FEED, adjustment: 'raw', sort: 'asc' })
    if (token) search.set('page_token', token)
    const payload = await fetchJson<{ bars?: Record<string, RawBar[]> | RawBar[]; symbol?: string; next_page_token?: string | null }>(`${DATA_URL}${path}?${search}`, kind)
    if (Array.isArray(payload.bars)) {
      const symbol = payload.symbol ?? '_'
      out[symbol] = (out[symbol] ?? []).concat(payload.bars)
    } else {
      for (const [symbol, bars] of Object.entries(payload.bars ?? {})) out[symbol] = (out[symbol] ?? []).concat(bars)
    }
    token = payload.next_page_token ?? undefined
  } while (token)
  return out
}

async function pagedMultiSymbolBars(symbols: string[], params: Record<string, string>, kind: string) {
  let remaining = [...symbols]
  while (remaining.length) {
    try {
      return await pagedBars('/v2/stocks/bars', { ...params, symbols: remaining.join(',') }, kind)
    } catch (error) {
      const invalid = error instanceof Error ? /invalid symbol: ([^"\s]+)/.exec(error.message)?.[1] : undefined
      if (!invalid || !remaining.includes(invalid)) throw error
      remaining = remaining.filter((symbol) => symbol !== invalid)
    }
  }
  return {} as Record<string, RawBar[]>
}

export async function getAssets(): Promise<Asset[]> {
  return cached('assets/us_equity_all', 'alpaca', async () => {
    const [activeAssets, inactiveAssets] = await Promise.all(['active', 'inactive'].map((status) =>
      fetchJson<Asset[]>(`${TRADING_URL}/v2/assets?status=${status}&asset_class=us_equity`, 'assets')))
    return [...activeAssets, ...inactiveAssets].map(({ symbol, name, class: assetClass, status, exchange }) => ({ symbol, name, class: assetClass, status, exchange }))
  })
}

export async function getDailyBars(symbols: string[], start: string, end: string) {
  const batches: string[][] = []
  for (let index = 0; index < symbols.length; index += 200) batches.push(symbols.slice(index, index + 200))
  const results = await Promise.all(batches.map((batch) =>
    cached(`daily/${start}_${end}_${hashKey(batch)}`, 'alpaca', () => pagedMultiSymbolBars(batch, { timeframe: '1Day', start, end }, 'daily-bars'))))
  return Object.assign({}, ...results) as Record<string, RawBar[]>
}

export async function getMinuteBarsForDay(day: string, symbols: string[], startIso: string, endIso: string) {
  const sorted = [...new Set(symbols)].sort()
  const batches: string[][] = []
  for (let index = 0; index < sorted.length; index += 100) batches.push(sorted.slice(index, index + 100))
  const results = await Promise.all(batches.map((batch) =>
    cached(`minute/${day}/${hashKey(batch)}`, 'alpaca', () => pagedMultiSymbolBars(batch, { timeframe: '1Min', start: startIso, end: endIso }, 'minute-bars'))))
  return Object.assign({}, ...results) as Record<string, RawBar[]>
}

export async function getFifteenMinuteBars(symbol: string, start: string, end: string) {
  return cached(`fifteen/${symbol.replace(/[^A-Z0-9]/g, '_')}_${start}_${end}`, 'alpaca', async () =>
    (await pagedBars(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, { timeframe: '15Min', start, end }, 'fifteen-minute-bars'))[symbol] ?? [])
}

export async function getNewsForDay(day: string, symbols: string[], startIso: string, endIso: string) {
  const sorted = [...new Set(symbols)].sort()
  const batches: string[][] = []
  for (let index = 0; index < sorted.length; index += 40) batches.push(sorted.slice(index, index + 40))
  const results = await Promise.all(batches.map((batch) => cached(`news/${day}/${hashKey(batch)}`, 'alpaca', async () => {
    const stories: NewsStory[] = []
    let token: string | undefined
    do {
      const search = new URLSearchParams({ symbols: batch.join(','), start: startIso, end: endIso, limit: '50', sort: 'asc', exclude_contentless: 'false' })
      if (token) search.set('page_token', token)
      const payload = await fetchJson<{ news?: NewsStory[]; next_page_token?: string | null }>(`${DATA_URL}/v1beta1/news?${search}`, 'news')
      for (const story of payload.news ?? []) stories.push({ id: story.id, headline: story.headline, summary: story.summary, symbols: story.symbols, created_at: story.created_at })
      token = payload.next_page_token ?? undefined
    } while (token)
    return stories
  })))
  const seen = new Set<number>()
  return results.flat().filter((story) => !seen.has(story.id) && Boolean(seen.add(story.id)))
}

const quoteMemory = new Map<string, Map<string, HistoricalQuote>>()
const dirtyQuoteDays = new Set<string>()

function quoteDay(day: string) {
  let entry = quoteMemory.get(day)
  if (!entry) {
    entry = new Map(Object.entries(readCache<Record<string, HistoricalQuote>>(`quotes/${day}`) ?? {}))
    quoteMemory.set(day, entry)
  }
  return entry
}

export async function getLatestQuote(day: string, symbol: string, at: Date, lookbackSeconds: number): Promise<HistoricalQuote> {
  const memory = quoteDay(day)
  const key = `${symbol}@${at.toISOString()}`
  if (memory.has(key)) {
    apiStats.alpacaCached += 1
    return memory.get(key)!
  }
  if (cacheOnly) throw new Error(`Cache miss for quote ${key} in --cache-only mode`)
  const search = new URLSearchParams({
    start: new Date(at.getTime() - lookbackSeconds * 1_000).toISOString(),
    end: at.toISOString(),
    limit: '1',
    sort: 'desc',
    feed: HISTORICAL_FEED,
  })
  const payload = await fetchJson<{ quotes?: Array<{ t: string; bp: number; ap: number }> }>(`${DATA_URL}/v2/stocks/${encodeURIComponent(symbol)}/quotes?${search}`, 'quotes')
  const quote = payload.quotes?.[0]
  const value = quote ? { t: quote.t, bp: quote.bp, ap: quote.ap } : null
  memory.set(key, value)
  dirtyQuoteDays.add(day)
  return value
}

export function flushQuoteCache() {
  for (const day of dirtyQuoteDays) writeCache(`quotes/${day}`, Object.fromEntries(quoteMemory.get(day) ?? []))
  dirtyQuoteDays.clear()
}

export type ShareCountPoint = { date: string; shares: number }

// FMP's stable API has no historical float endpoint (the v4 one is legacy-only), so quarterly share counts
// from enterprise-values are used to scale the current float back in time.
export async function getShareCountHistory(symbol: string): Promise<ShareCountPoint[]> {
  return cached(`fmp/share-count-history/${symbol}`, 'fmp', async () => {
    const apiKey = process.env.FMP_API_KEY?.trim()
    if (!apiKey) throw new Error('FMP_API_KEY is required for share-count history')
    const rows = await fetchJson<Array<{ date?: string; numberOfShares?: number }>>(`https://financialmodelingprep.com/stable/enterprise-values?symbol=${encodeURIComponent(symbol)}&period=quarter&limit=12&apikey=${apiKey}`, 'fmp-share-history', 'fmp')
    return (Array.isArray(rows) ? rows : [])
      .map((row) => ({ date: String(row.date ?? ''), shares: Number(row.numberOfShares) }))
      .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.shares) && row.shares > 0)
      .sort((left, right) => left.date.localeCompare(right.date))
  })
}

export type MarketCapPoint = { date: string; marketCap: number }

// The brief named /stable/historical-market-cap, which returns HTTP 404; FMP's stable path is historical-market-capitalization.
export async function getDailyMarketCaps(symbol: string, from: string, to: string): Promise<MarketCapPoint[]> {
  return cached(`fmp/market-cap-daily/${symbol}_${from}_${to}`, 'fmp', async () => {
    const apiKey = process.env.FMP_API_KEY?.trim()
    if (!apiKey) throw new Error('FMP_API_KEY is required for daily market cap')
    const rows = await fetchJson<Array<{ date?: string; marketCap?: number }>>(`https://financialmodelingprep.com/stable/historical-market-capitalization?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&limit=5000&apikey=${apiKey}`, 'fmp-market-cap-daily', 'fmp')
    return (Array.isArray(rows) ? rows : [])
      .map((row) => ({ date: String(row.date ?? '').slice(0, 10), marketCap: Number(row.marketCap) }))
      .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.marketCap) && row.marketCap > 0)
      .sort((left, right) => left.date.localeCompare(right.date))
  })
}

export async function getCurrentFreeFloatPercents(): Promise<Record<string, number>> {
  return cached('fmp/shares-float-all-freefloat', 'fmp', async () => {
    const apiKey = process.env.FMP_API_KEY?.trim()
    if (!apiKey) throw new Error('FMP_API_KEY is required for the free-float snapshot')
    const percents: Record<string, number> = {}
    for (let page = 0; page < 200; page += 1) {
      const rows = await fetchJson<Array<{ symbol?: string; freeFloat?: number }>>(`https://financialmodelingprep.com/stable/shares-float-all?page=${page}&limit=5000&apikey=${apiKey}`, 'fmp-float', 'fmp')
      if (!Array.isArray(rows) || !rows.length) break
      for (const row of rows) {
        const value = Number(row.freeFloat)
        if (row.symbol && Number.isFinite(value) && value > 0 && value <= 100 && !/\./.test(row.symbol)) percents[row.symbol] = value
      }
    }
    return percents
  })
}

export async function getCurrentFloats(): Promise<Record<string, number>> {
  return cached('fmp/shares-float-all', 'fmp', async () => {
    const apiKey = process.env.FMP_API_KEY?.trim()
    if (!apiKey) throw new Error('FMP_API_KEY is required for the float snapshot')
    const floats: Record<string, number> = {}
    for (let page = 0; page < 200; page += 1) {
      const rows = await fetchJson<Array<{ symbol?: string; floatShares?: number }>>(`https://financialmodelingprep.com/stable/shares-float-all?page=${page}&limit=5000&apikey=${apiKey}`, 'fmp-float', 'fmp')
      if (!Array.isArray(rows) || !rows.length) break
      for (const row of rows) {
        const value = Number(row.floatShares)
        if (row.symbol && Number.isFinite(value) && value > 0 && !/\./.test(row.symbol)) floats[row.symbol] = value
      }
    }
    return floats
  })
}
