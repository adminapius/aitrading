import { scoreCandidate, strategyRegime, type ScanCandidate } from '@/lib/strategy'
import { scanConfig } from '@/lib/scan-config'
import { alpacaHeaders, tradingConfig } from '@/lib/trading-config'

type Bar = { t: string; h?: number; l?: number; c?: number; v?: number; vw?: number }
type Asset = { symbol?: string; name?: string; class?: string; status?: string; tradable?: boolean; fractionable?: boolean; exchange?: string }
type Snapshot = {
  latestTrade?: { p?: number; t?: string }
  latestQuote?: { bp?: number; ap?: number; t?: string }
  dailyBar?: Pick<Bar, 'c'>
  prevDailyBar?: Pick<Bar, 'c'>
}
type NewsStory = { headline?: string; summary?: string; symbols?: string[]; created_at?: string }
type EnrichedCandidate = ScanCandidate & {
  lastTradeAt?: string
  lastTradePrice?: number
  spreadPct?: number
  enrichmentErrors: string[]
  score: number
}

type ScanFailure = { symbol: string; reason: string }

const validSymbol = /^[A-Z][A-Z0-9.-]{0,9}$/
const excludedSecurityName = /\b(warrants?|rights?|units?)\b/i
const supportedExchanges = new Set(['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'BATS', 'NYSEARCA', 'NYSEAMERICAN'])

function numberOrNull(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function easternParts(value: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value)
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === name)?.value ?? '00'
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minute: Number(part('hour')) * 60 + Number(part('minute')),
  }
}

function parseBarsBySymbol(payload: unknown): Record<string, Bar[]> {
  if (!payload || typeof payload !== 'object' || !('bars' in payload)) return {}
  const bars = (payload as { bars?: unknown }).bars
  return bars && typeof bars === 'object' ? bars as Record<string, Bar[]> : {}
}

function computeAtr(bars: Bar[], now: Date) {
  const today = easternParts(now).date
  const ordered = bars.filter((bar) => easternParts(new Date(bar.t)).date < today)
    .sort((left, right) => left.t.localeCompare(right.t))
  if (ordered.length < scanConfig.atrPeriod + 1) return null
  const ranges = ordered.slice(-scanConfig.atrPeriod).map((bar, index, recent) => {
    const previous = ordered[ordered.length - scanConfig.atrPeriod - 1 + index]
    const high = numberOrNull(bar.h)
    const low = numberOrNull(bar.l)
    const previousClose = numberOrNull(previous?.c)
    if (!high || !low || !previousClose) return null
    return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose))
  }).filter((range): range is number => range !== null)
  return ranges.length === scanConfig.atrPeriod ? ranges.reduce((sum, range) => sum + range, 0) / ranges.length : null
}

function computeIntradayMetrics(bars: Bar[], now: Date) {
  const today = easternParts(now)
  const dailyBuckets = new Map<string, Map<number, { volume: number; weightedVwap: number }>>()
  for (const bar of bars) {
    const timestamp = new Date(bar.t)
    if (!Number.isFinite(timestamp.getTime())) continue
    const { date, minute } = easternParts(timestamp)
    if (minute > today.minute) continue
    const bucket = Math.floor(minute / scanConfig.relativeVolumeBarMinutes) * scanConfig.relativeVolumeBarMinutes
    const volume = Math.max(0, Number(bar.v ?? 0))
    const vwap = numberOrNull(bar.vw) ?? numberOrNull(bar.c) ?? 0
    if (!dailyBuckets.has(date)) dailyBuckets.set(date, new Map())
    const bucketValues = dailyBuckets.get(date)!
    const current = bucketValues.get(bucket) ?? { volume: 0, weightedVwap: 0 }
    current.volume += volume
    current.weightedVwap += vwap * volume
    bucketValues.set(bucket, current)
  }

  const cumulativeByDate = [...dailyBuckets.entries()].map(([date, buckets]) => {
    let volume = 0
    let weightedVwap = 0
    for (const [minute, value] of [...buckets.entries()].sort(([left], [right]) => left - right)) {
      if (minute > today.minute) continue
      volume += value.volume
      weightedVwap += value.weightedVwap
    }
    return { date, volume, weightedVwap }
  })
  const current = cumulativeByDate.find((entry) => entry.date === today.date)
  const history = cumulativeByDate.filter((entry) => entry.date !== today.date && entry.volume > 0)
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, scanConfig.relativeVolumeLookbackSessions)
  const averageVolume = history.length ? history.reduce((sum, entry) => sum + entry.volume, 0) / history.length : null
  const volume = current?.volume ?? null
  return {
    volume,
    averageVolume,
    relativeVolume: volume != null && averageVolume != null && averageVolume > 0 ? volume / averageVolume : null,
    vwap: current && current.volume > 0 ? current.weightedVwap / current.volume : null,
  }
}

function catalystKind(headline: string) {
  if (/earnings|revenue|guidance|quarter/i.test(headline)) return 'earnings'
  if (/fda|clinical|trial|drug/i.test(headline)) return 'clinical'
  if (/merger|acquisition|acquire|buyout/i.test(headline)) return 'merger'
  if (/contract|award|partnership|agreement/i.test(headline)) return 'contract'
  if (/offering|offering|dilut|shelf registration/i.test(headline)) return 'offering'
  if (/upgrade|downgrade|price target|analyst/i.test(headline)) return 'analyst'
  return 'news'
}

async function fetchJson<T>(url: string, revalidate: number, timeoutMs = 8_000): Promise<T> {
  const response = await fetch(url, {
    headers: alpacaHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
    next: { revalidate },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

async function mapLimit<T, U>(items: T[], limit: number, callback: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await callback(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

function assetEligibility(asset: Asset | null) {
  if (!asset) return 'Alpaca asset metadata unavailable'
  if (asset.class !== 'us_equity') return `asset class ${asset.class ?? 'missing'} is not us_equity`
  if (asset.status !== 'active' || asset.tradable !== true) return 'asset is not active and tradable'
  if (!asset.exchange || !supportedExchanges.has(asset.exchange.toUpperCase())) return `unsupported exchange ${asset.exchange ?? 'missing'}`
  if (excludedSecurityName.test(asset.name ?? '')) return 'asset name identifies a warrant, right, or unit'
  return null
}

async function getAsset(symbol: string): Promise<Asset> {
  return fetchJson<Asset>(`${tradingConfig.alpacaBaseUrl}/v2/assets/${encodeURIComponent(symbol)}`, 21_600)
}

async function getFloat(symbol: string) {
  const apiKey = process.env.FMP_API_KEY?.trim()
  if (!apiKey) throw new Error('FMP_API_KEY is not configured')
  const url = new URL('https://financialmodelingprep.com/stable/shares-float')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('apikey', apiKey)
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000), next: { revalidate: 86_400 } })
  if (!response.ok) throw new Error(`FMP HTTP ${response.status}`)
  const payload = await response.json() as Array<Record<string, unknown>>
  const row = Array.isArray(payload) ? payload[0] : undefined
  const value = numberOrNull(row?.floatShares ?? row?.float_shares ?? row?.freeFloat)
  if (!value) throw new Error('FMP returned no positive float-shares value')
  return value
}

async function getIntradayBars(symbol: string, start: string) {
  const url = new URL(`${tradingConfig.alpacaDataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars`)
  url.search = new URLSearchParams({ timeframe: `${scanConfig.relativeVolumeBarMinutes}Min`, start, limit: '10000', feed: tradingConfig.alpacaDataFeed, sort: 'asc' }).toString()
  const payload = await fetchJson<{ bars?: Bar[] }>(url.toString(), 30)
  return Array.isArray(payload.bars) ? payload.bars : []
}

async function getDailyBars(symbols: string[], start: string) {
  const url = new URL(`${tradingConfig.alpacaDataUrl}/v2/stocks/bars`)
  url.search = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', start, limit: '10000', feed: tradingConfig.alpacaDataFeed, sort: 'asc' }).toString()
  return parseBarsBySymbol(await fetchJson<unknown>(url.toString(), 3_600))
}

async function getNews(symbols: string[], now: Date) {
  if (!symbols.length) return []
  const url = new URL(`${tradingConfig.alpacaDataUrl}/v1beta1/news`)
  const utcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
  url.search = new URLSearchParams({ symbols: symbols.join(','), start: utcStart.toISOString(), limit: '50', sort: 'desc' }).toString()
  const payload = await fetchJson<{ news?: NewsStory[] }>(url.toString(), 30)
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000
  return (payload.news ?? []).filter((story) => {
    const published = new Date(story.created_at ?? '').getTime()
    return Number.isFinite(published) && published >= cutoff && published <= now.getTime()
  })
}

export async function loadEnrichedCandidates(symbols: string[], snapshots: Record<string, Snapshot>, now: Date) {
  const uniqueSymbols = [...new Set(symbols.filter((symbol) => validSymbol.test(symbol)))].slice(0, 50)
  const failures: ScanFailure[] = []
  const assetResults = await mapLimit(uniqueSymbols, 5, async (symbol) => {
    try {
      const asset = await getAsset(symbol)
      const reason = assetEligibility(asset)
      if (reason) failures.push({ symbol, reason })
      return { symbol, asset: reason ? null : asset }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Alpaca asset lookup failed'
      failures.push({ symbol, reason })
      return { symbol, asset: null }
    }
  })
  const eligible = assetResults.filter((entry): entry is { symbol: string; asset: Asset } => entry.asset !== null)
  const activeSymbols = eligible.map(({ symbol }) => symbol)
  if (!activeSymbols.length) return { candidates: [] as EnrichedCandidate[], failures }

  const utcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const intradayStart = new Date(utcDay.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString()
  const dailyStart = new Date(utcDay.getTime() - 35 * 24 * 60 * 60 * 1000).toISOString()
  const [intradayResults, dailyBarsResult, newsResult, floatResults] = await Promise.all([
    mapLimit(activeSymbols, 5, async (symbol) => {
      try { return { symbol, bars: await getIntradayBars(symbol, intradayStart), error: null } }
      catch (error) { return { symbol, bars: [] as Bar[], error: error instanceof Error ? error.message : 'intraday bars unavailable' } }
    }),
    getDailyBars(activeSymbols, dailyStart).catch((error) => ({ error: error instanceof Error ? error.message : 'daily bars unavailable' })),
    getNews(activeSymbols, now).catch((error) => ({ error: error instanceof Error ? error.message : 'Alpaca news unavailable' })),
    mapLimit(activeSymbols, 5, async (symbol) => {
      try { return { symbol, value: await getFloat(symbol), error: null } }
      catch (error) { return { symbol, value: null, error: error instanceof Error ? error.message : 'float unavailable' } }
    }),
  ])

  const intradayBySymbol = new Map(intradayResults.map((result) => [result.symbol, result]))
  const dailyBars = 'error' in dailyBarsResult ? {} : dailyBarsResult
  const news = Array.isArray(newsResult) ? newsResult : []
  const newsError = Array.isArray(newsResult) ? null : newsResult.error
  const floatBySymbol = new Map(floatResults.map((result) => [result.symbol, result]))
  const assetBySymbol = new Map(eligible.map(({ symbol, asset }) => [symbol, asset]))

  const candidates = activeSymbols.flatMap((symbol) => {
    const snapshot = snapshots[symbol]
    const trade = snapshot?.latestTrade
    const quote = snapshot?.latestQuote
    const tradeAt = trade?.t ? new Date(trade.t) : null
    const quoteAt = quote?.t ? new Date(quote.t) : null
    const tradeAge = tradeAt && Number.isFinite(tradeAt.getTime()) ? (now.getTime() - tradeAt.getTime()) / 1000 : Infinity
    const quoteAge = quoteAt && Number.isFinite(quoteAt.getTime()) ? (now.getTime() - quoteAt.getTime()) / 1000 : Infinity
    if (!Number.isFinite(tradeAge) || tradeAge < 0 || tradeAge > scanConfig.maxTradeAgeSeconds) {
      failures.push({ symbol, reason: `last trade is stale or missing (${Math.round(tradeAge)}s; limit ${scanConfig.maxTradeAgeSeconds}s)` })
      return []
    }
    if (!Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > scanConfig.maxQuoteAgeSeconds) {
      failures.push({ symbol, reason: `quote is stale or missing (${Math.round(quoteAge)}s; limit ${scanConfig.maxQuoteAgeSeconds}s)` })
      return []
    }

    const bid = numberOrNull(quote?.bp)
    const ask = numberOrNull(quote?.ap)
    if (!bid || !ask || ask < bid) {
      failures.push({ symbol, reason: 'valid two-sided quote unavailable' })
      return []
    }
    const midpoint = (bid + ask) / 2
    const spreadPct = ((ask - bid) / midpoint) * 100
    const lastTradePrice = numberOrNull(trade?.p)
    const tolerance = midpoint * 0.005
    if (!lastTradePrice || lastTradePrice < bid - tolerance || lastTradePrice > ask + tolerance) {
      failures.push({ symbol, reason: 'latest trade is outside the current quote by more than 0.5% of midpoint' })
      return []
    }

    const intraday = intradayBySymbol.get(symbol)
    const metrics = computeIntradayMetrics(intraday?.bars ?? [], now)
    const atr = computeAtr(dailyBars[symbol] ?? [], now)
    const floatResult = floatBySymbol.get(symbol)
    const asset = assetBySymbol.get(symbol)!
    const story = news.filter((item) => item.symbols?.includes(symbol)).sort((left, right) => (right.created_at ?? '').localeCompare(left.created_at ?? ''))[0]
    const errors: string[] = []
    if (!asset.name?.trim()) errors.push('company_name: Alpaca asset metadata has no display name')
    if (intraday?.error) errors.push(`intraday_bars: ${intraday.error}`)
    if (metrics.relativeVolume == null) errors.push('relative_volume: same-time-of-day 15-minute history is insufficient')
    if (floatResult?.error) errors.push(`float_shares: ${floatResult.error}`)
    if (atr == null) errors.push(`atr: fewer than ${scanConfig.atrPeriod + 1} daily bars available`)
    if (metrics.vwap == null) errors.push('vwap: current-session intraday volume is unavailable')
    if (newsError) errors.push(`catalyst: ${newsError}`)
    else if (!story) errors.push('catalyst: no Alpaca news published within the last 24 hours')

    const currentClose = numberOrNull(snapshot?.dailyBar?.c)
    const previousClose = numberOrNull(snapshot?.prevDailyBar?.c)
    const candidate: EnrichedCandidate = {
      symbol,
      companyName: asset.name?.trim() || undefined,
      price: midpoint,
      bid,
      ask,
      volume: metrics.volume ?? undefined,
      averageVolume: metrics.averageVolume ?? undefined,
      relativeVolume: metrics.relativeVolume ?? undefined,
      float: floatResult?.value ?? undefined,
      floatSource: floatResult?.value != null ? 'fmp' : undefined,
      changePercent: currentClose && previousClose ? ((currentClose - previousClose) / previousClose) * 100 : undefined,
      vwap: metrics.vwap ?? undefined,
      atr: atr ?? undefined,
      hasNews: Boolean(story),
      catalystType: story?.headline ? catalystKind(story.headline) : undefined,
      catalystSummary: story?.headline ? `${story.headline}${story.summary ? ` — ${story.summary}` : ''}`.slice(0, 500) : undefined,
      lastTradeAt: tradeAt!.toISOString(),
      lastTradePrice: lastTradePrice!,
      spreadPct,
      enrichmentErrors: errors,
      score: 0,
    }
    const missing = [
      !candidate.companyName && 'company_name',
      candidate.relativeVolume == null && 'relative_volume',
      candidate.float == null && 'float_shares',
      candidate.atr == null && 'atr',
      candidate.vwap == null && 'vwap',
      !candidate.catalystType && 'catalyst_type',
      !candidate.catalystSummary && 'catalyst_summary',
    ].filter((field): field is string => Boolean(field))
    if (missing.length) console.warn('[scanner] enrichment incomplete', { symbol, missing, reasons: errors })

    const regime = strategyRegime(now)
    const minVolume = Math.max(scanConfig.minVolume, regime.volume)
    const maxSpread = Math.min(scanConfig.maxSpreadPercent, regime.spread * 100)
    const changePercent = candidate.changePercent ?? Number.NEGATIVE_INFINITY
    const reasons = [
      midpoint < scanConfig.minPrice && `price below $${scanConfig.minPrice}`,
      changePercent <= scanConfig.minChangePercent && `change is not above ${scanConfig.minChangePercent}%`,
      (candidate.volume ?? 0) < minVolume && `volume below ${minVolume}`,
      (candidate.volume ?? 0) * midpoint < regime.dollarVolume && `dollar volume below ${regime.dollarVolume}`,
      spreadPct > maxSpread && `spread exceeds ${maxSpread}%`,
    ].filter((reason): reason is string => Boolean(reason))
    if (reasons.length) {
      failures.push({ symbol, reason: reasons.join('; ') })
      return []
    }
    candidate.score = scoreCandidate(candidate, now)
    return [candidate]
  })

  return { candidates, failures }
}
