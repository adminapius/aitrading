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
const excludedSecuritySuffix = /^(?=.{5,}$)[A-Z0-9.-]+(?:WS|RT|W|R|U|Z)$/
const supportedExchanges = new Set(['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'BATS', 'NYSEARCA', 'NYSEAMERICAN'])
const dailyScanCache = new Map<string, Promise<unknown>>()
const dailyAtrCache = new Map<string, number | null>()
const dailyVolumeBaselineCache = new Map<string, Map<number, number>[]>()

type DailyCacheKind = 'asset' | 'float' | 'atr-bars' | 'historical-bars'

function cacheForTradingDay<T>(kind: DailyCacheKind, symbol: string, now: Date, load: () => Promise<T>) {
  const day = easternParts(now).date
  for (const key of dailyScanCache.keys()) if (!key.startsWith(`${day}:`)) dailyScanCache.delete(key)
  const key = `${day}:${kind}:${symbol}`
  const cached = dailyScanCache.get(key)
  if (cached) return cached as Promise<T>
  const promise = load().catch((error) => {
    dailyScanCache.delete(key)
    throw error
  })
  dailyScanCache.set(key, promise)
  return promise
}

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

function cachedDailyAtr(symbol: string, bars: Bar[], now: Date) {
  const day = easternParts(now).date
  const key = `${day}:${symbol}`
  if (dailyAtrCache.has(key)) return dailyAtrCache.get(key) ?? null
  for (const cachedKey of dailyAtrCache.keys()) if (!cachedKey.startsWith(`${day}:`)) dailyAtrCache.delete(cachedKey)
  const atr = computeAtr(bars, now)
  dailyAtrCache.set(key, atr)
  return atr
}

function historicalVolumeBuckets(symbol: string, bars: Bar[], today: string) {
  const key = `${today}:${symbol}`
  const cached = dailyVolumeBaselineCache.get(key)
  if (cached) return cached

  const byDate = new Map<string, Map<number, number>>()
  for (const bar of bars) {
    const timestamp = new Date(bar.t)
    if (!Number.isFinite(timestamp.getTime())) continue
    const { date, minute } = easternParts(timestamp)
    if (date >= today) continue
    const bucket = Math.floor(minute / scanConfig.relativeVolumeBarMinutes) * scanConfig.relativeVolumeBarMinutes
    const volume = Math.max(0, Number(bar.v ?? 0))
    if (!byDate.has(date)) byDate.set(date, new Map())
    const buckets = byDate.get(date)!
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + volume)
  }

  const sessions = [...byDate.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .slice(0, scanConfig.relativeVolumeLookbackSessions)
    .map(([, buckets]) => buckets)
  for (const cachedKey of dailyVolumeBaselineCache.keys()) if (!cachedKey.startsWith(`${today}:`)) dailyVolumeBaselineCache.delete(cachedKey)
  dailyVolumeBaselineCache.set(key, sessions)
  return sessions
}

function computeIntradayMetrics(symbol: string, historicalBars: Bar[], currentBars: Bar[], now: Date) {
  const today = easternParts(now)
  const historicalSessions = historicalVolumeBuckets(symbol, historicalBars, today.date)
  const currentBuckets = new Map<number, { volume: number; weightedVwap: number }>()
  for (const bar of currentBars) {
    const timestamp = new Date(bar.t)
    if (!Number.isFinite(timestamp.getTime())) continue
    const { date, minute } = easternParts(timestamp)
    if (date !== today.date || minute > today.minute) continue
    const bucket = Math.floor(minute / scanConfig.relativeVolumeBarMinutes) * scanConfig.relativeVolumeBarMinutes
    const volume = Math.max(0, Number(bar.v ?? 0))
    const vwap = numberOrNull(bar.vw) ?? numberOrNull(bar.c) ?? 0
    const current = currentBuckets.get(bucket) ?? { volume: 0, weightedVwap: 0 }
    current.volume += volume
    current.weightedVwap += vwap * volume
    currentBuckets.set(bucket, current)
  }

  let volume = 0
  let weightedVwap = 0
  for (const [minute, value] of [...currentBuckets.entries()].sort(([left], [right]) => left - right)) {
    if (minute > today.minute) continue
    volume += value.volume
    weightedVwap += value.weightedVwap
  }
  const averageVolume = historicalSessions.length
    ? historicalSessions.reduce((sum, buckets) => sum + [...buckets.entries()].reduce((total, [minute, bucketVolume]) => total + (minute <= today.minute ? bucketVolume : 0), 0), 0) / historicalSessions.length
    : null
  const relativeVolumeReliable = averageVolume != null && averageVolume >= scanConfig.minimumRelativeVolumeBaselineVolume
  return {
    volume: currentBuckets.size ? volume : null,
    averageVolume,
    relativeVolumeReliable,
    relativeVolume: volume > 0 && relativeVolumeReliable ? volume / averageVolume! : null,
    vwap: volume > 0 ? weightedVwap / volume : null,
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

function easternMidnight(now: Date) {
  const { date } = easternParts(now)
  const [year, month, day] = date.split('-').map(Number)
  const approximateNoon = new Date(Date.UTC(year, month - 1, day, 12))
  const localParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(approximateNoon)
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(localParts.find((item) => item.type === name)?.value ?? 0)
  const localAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
  return new Date(Date.UTC(year, month - 1, day) - (localAsUtc - approximateNoon.getTime()))
}

async function getAsset(symbol: string, now: Date): Promise<Asset> {
  return cacheForTradingDay('asset', symbol, now, () => fetchJson<Asset>(`${tradingConfig.alpacaBaseUrl}/v2/assets/${encodeURIComponent(symbol)}`, 86_400))
}

async function getFloat(symbol: string, now: Date) {
  return cacheForTradingDay('float', symbol, now, async () => {
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
    if (!value) return null
    if (value < 100_000 || value > 2_000_000_000) {
      console.warn('[scanner] float value outside sane share range; treating as missing for the trading day', { symbol, source: 'fmp', value })
      return null
    }
    return value
  })
}

async function getHistoricalIntradayBars(symbol: string, start: string, end: string, now: Date) {
  return cacheForTradingDay('historical-bars', symbol, now, async () => {
    const url = new URL(`${tradingConfig.alpacaDataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars`)
    url.search = new URLSearchParams({ timeframe: `${scanConfig.relativeVolumeBarMinutes}Min`, start, end, limit: '10000', feed: tradingConfig.alpacaDataFeed, sort: 'asc' }).toString()
    const payload = await fetchJson<{ bars?: Bar[] }>(url.toString(), 86_400)
    return Array.isArray(payload.bars) ? payload.bars : []
  })
}

async function getCurrentIntradayBars(symbols: string[], start: string) {
  const url = new URL(`${tradingConfig.alpacaDataUrl}/v2/stocks/bars`)
  url.search = new URLSearchParams({ symbols: symbols.join(','), timeframe: `${scanConfig.relativeVolumeBarMinutes}Min`, start, limit: '10000', feed: tradingConfig.alpacaDataFeed, sort: 'asc' }).toString()
  const response = await fetch(url, { headers: alpacaHeaders(), signal: AbortSignal.timeout(8_000), cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseBarsBySymbol(await response.json())
}

async function getDailyBars(symbol: string, start: string, end: string, now: Date) {
  return cacheForTradingDay('atr-bars', symbol, now, async () => {
    const url = new URL(`${tradingConfig.alpacaDataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars`)
    url.search = new URLSearchParams({ timeframe: '1Day', start, end, limit: '10000', feed: tradingConfig.alpacaDataFeed, sort: 'asc' }).toString()
    const payload = await fetchJson<{ bars?: Bar[] }>(url.toString(), 86_400)
    return Array.isArray(payload.bars) ? payload.bars : []
  })
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
  const requestedSymbols = [...new Set(symbols.filter((symbol) => validSymbol.test(symbol)))].slice(0, 50)
  const failures: ScanFailure[] = []
  const uniqueSymbols = requestedSymbols.filter((symbol) => {
    if (!excludedSecuritySuffix.test(symbol)) return true
    failures.push({ symbol, reason: 'symbol suffix matches the warrant, right, unit, or related security backstop' })
    return false
  })
  const assetResults = await mapLimit(uniqueSymbols, 5, async (symbol) => {
    try {
      const asset = await getAsset(symbol, now)
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

  const sessionStart = easternMidnight(now)
  const intradayStart = new Date(sessionStart.getTime() - 22 * 24 * 60 * 60 * 1000).toISOString()
  const dailyStart = new Date(sessionStart.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString()
  const [historicalIntradayResults, currentIntradayResult, dailyBarsResults, newsResult, floatResults] = await Promise.all([
    mapLimit(activeSymbols, 5, async (symbol) => {
      try { return { symbol, bars: await getHistoricalIntradayBars(symbol, intradayStart, sessionStart.toISOString(), now), error: null } }
      catch (error) { return { symbol, bars: [] as Bar[], error: error instanceof Error ? error.message : 'historical intraday bars unavailable' } }
    }),
    getCurrentIntradayBars(activeSymbols, sessionStart.toISOString())
      .then((bars) => ({ bars, error: null as string | null }))
      .catch((error) => ({ bars: {} as Record<string, Bar[]>, error: error instanceof Error ? error.message : 'current intraday bars unavailable' })),
    mapLimit(activeSymbols, 5, async (symbol) => {
      try { return { symbol, bars: await getDailyBars(symbol, dailyStart, sessionStart.toISOString(), now), error: null } }
      catch (error) { return { symbol, bars: [] as Bar[], error: error instanceof Error ? error.message : 'daily bars unavailable' } }
    }),
    getNews(activeSymbols, now).catch((error) => ({ error: error instanceof Error ? error.message : 'Alpaca news unavailable' })),
    mapLimit(activeSymbols, 5, async (symbol) => {
      try {
        const value = await getFloat(symbol, now)
        return { symbol, value, error: value == null ? 'FMP has no validated float value; missing result cached for this ET trading day' : null }
      } catch (error) {
        return { symbol, value: null, error: error instanceof Error ? error.message : 'float unavailable' }
      }
    }),
  ])

  const historicalIntradayBySymbol = new Map(historicalIntradayResults.map((result) => [result.symbol, result]))
  const currentIntradayBySymbol = currentIntradayResult.bars
  const dailyBarsBySymbol = new Map(dailyBarsResults.map((result) => [result.symbol, result]))
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

    const historicalIntraday = historicalIntradayBySymbol.get(symbol)
    const currentBars = currentIntradayBySymbol[symbol] ?? []
    const dailyBars = dailyBarsBySymbol.get(symbol)
    const metrics = computeIntradayMetrics(symbol, historicalIntraday?.bars ?? [], currentBars, now)
    const atr = dailyBars?.error ? null : cachedDailyAtr(symbol, dailyBars?.bars ?? [], now)
    const floatResult = floatBySymbol.get(symbol)
    const asset = assetBySymbol.get(symbol)!
    const story = news.filter((item) => item.symbols?.includes(symbol)).sort((left, right) => (right.created_at ?? '').localeCompare(left.created_at ?? ''))[0]
    const errors: string[] = []
    if (!asset.name?.trim()) errors.push('company_name: Alpaca asset metadata has no display name')
    if (historicalIntraday?.error) errors.push(`historical_intraday_bars: ${historicalIntraday.error}`)
    if (currentIntradayResult.error) errors.push(`current_intraday_bars: ${currentIntradayResult.error}`)
    if (dailyBars?.error) errors.push(`daily_bars: ${dailyBars.error}`)
    if (metrics.relativeVolume == null) errors.push(metrics.relativeVolumeReliable ? 'relative_volume: same-time-of-day 15-minute history is insufficient' : `relative_volume: same-time baseline ${Math.round(metrics.averageVolume ?? 0)} is below the ${scanConfig.minimumRelativeVolumeBaselineVolume} minimum; RVOL marked unreliable`)
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
      relativeVolumeReliable: metrics.relativeVolumeReliable,
      relativeVolumeBaselineVolume: metrics.averageVolume ?? undefined,
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
