import { scanConfig } from '../../lib/scan-config'
import { normalizeFloatShares, strategyRegime, type ScanCandidate } from '../../lib/strategy'
import type { ElliottBar } from '../../lib/elliott-wave'
import { getFifteenMinuteBars, getMinuteBarsForDay, getNewsForDay, type RawBar } from './data'
import { averageTrueRange, dailyIndex, floatOn, toEasternDay, type Universe } from './universe'

export const MINUTE = 60_000
export const DECISION_START_MINUTE = 7 * 60
export const FLATTEN_MINUTE = 15 * 60 + 55
export const TOP_GAINERS = Number(process.env.BACKTEST_TOP_GAINERS ?? 25)
export const POOL_MIN_DAILY_GAIN = 0.1
// Relative-volume baselines need 15-minute bars from before the first simulated day; the window was previously hard-coded to 2026-03-10..2026-10-08, which silently disabled the scanner for any earlier period.
let FIFTEEN_START = '2026-03-10T00:00:00Z'
let FIFTEEN_END = '2026-10-08T00:00:00Z'

export function setFifteenMinuteWindow(historyStart: string, periodEnd: string) {
  FIFTEEN_START = `${historyStart}T00:00:00Z`
  FIFTEEN_END = new Date(Date.parse(`${periodEnd}T00:00:00Z`) + 86_400_000).toISOString().replace('.000Z', 'Z')
  fifteenMemory.clear()
}

export type MinuteBar = { t: number; o: number; h: number; l: number; c: number; v: number; vw: number }

export type SymbolDay = {
  symbol: string
  name: string
  prevClose: number
  atr: number | null
  float: number | undefined
  bars: MinuteBar[]
  cumVolume: number[]
  cumPriceVolume: number[]
  elliottBars: ElliottBar[]
  baselineSessions: Map<number, number>[] | null
  news: Array<{ at: number; headline: string; summary: string }>
}

export type MinuteCandidate = ScanCandidate & { rank: number; scannerEligible: boolean; entryEligibleSymbol: boolean }

export type DayMarket = {
  day: string
  midnight: number
  symbols: Map<string, SymbolDay>
  candidatesAt: (minuteOfDay: number) => MinuteCandidate[]
  closedCount: (symbol: string, now: number) => number
  barAtOrAfter: (symbol: string, start: number) => MinuteBar | undefined
  barStarting: (symbol: string, start: number) => MinuteBar | undefined
  lastClosedBar: (symbol: string, now: number) => MinuteBar | undefined
}

const midnightCache = new Map<string, number>()

export function easternMidnight(day: string) {
  const cached = midnightCache.get(day)
  if (cached !== undefined) return cached
  for (const offset of ['-04:00', '-05:00']) {
    const value = Date.parse(`${day}T00:00:00${offset}`)
    if (toEasternDay(new Date(value).toISOString()) === day && toEasternDay(new Date(value - 1).toISOString()) !== day) {
      midnightCache.set(day, value)
      return value
    }
  }
  throw new Error(`Could not resolve Eastern midnight for ${day}`)
}

function catalystKind(headline: string) {
  if (/earnings|revenue|guidance|quarter/i.test(headline)) return 'earnings'
  if (/fda|clinical|trial|drug/i.test(headline)) return 'clinical'
  if (/merger|acquisition|acquire|buyout/i.test(headline)) return 'merger'
  if (/contract|award|partnership|agreement/i.test(headline)) return 'contract'
  if (/offering|dilut|shelf registration/i.test(headline)) return 'offering'
  if (/upgrade|downgrade|price target|analyst/i.test(headline)) return 'analyst'
  return 'news'
}

function upperBound(bars: MinuteBar[], start: number) {
  let low = 0
  let high = bars.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (bars[mid].t <= start) low = mid + 1
    else high = mid
  }
  return low
}

const fifteenMemory = new Map<string, Map<string, Map<number, number>>>()

async function fifteenMinuteSessions(symbol: string) {
  const cached = fifteenMemory.get(symbol)
  if (cached) return cached
  const bars = await getFifteenMinuteBars(symbol, FIFTEEN_START, FIFTEEN_END)
  const byDate = new Map<string, Map<number, number>>()
  for (const bar of bars) {
    const at = Date.parse(bar.t)
    const date = toEasternDay(bar.t)
    const minute = Math.round((at - easternMidnight(date)) / MINUTE)
    const bucket = Math.floor(minute / scanConfig.relativeVolumeBarMinutes) * scanConfig.relativeVolumeBarMinutes
    if (!byDate.has(date)) byDate.set(date, new Map())
    const buckets = byDate.get(date)!
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + Math.max(0, Number(bar.v ?? 0)))
  }
  fifteenMemory.set(symbol, byDate)
  return byDate
}

export function daySymbolSets(universe: Universe, day: string) {
  const pool: string[] = []
  const entryCandidates: string[] = []
  const prev = new Map<string, { prevClose: number; atr: number | null }>()
  for (const [symbol, rows] of universe.daily) {
    const index = dailyIndex(rows).get(day)
    if (index == null || index < 1) continue
    const row = rows[index]
    const prevClose = rows[index - 1].c
    if (!(prevClose > 0) || row.v < scanConfig.minVolume) continue
    const peak = Math.max(row.o, row.h)
    if (peak < scanConfig.minPrice) continue
    const gain = peak / prevClose - 1
    const float = normalizeFloatShares(floatOn(universe, symbol, day), 'fmp')
    const inPool = gain >= POOL_MIN_DAILY_GAIN
    const entryCandidate = gain > 0.02 && float != null && float <= 10_000_000
    if (!inPool && !entryCandidate) continue
    if (inPool) pool.push(symbol)
    if (entryCandidate) entryCandidates.push(symbol)
    prev.set(symbol, { prevClose, atr: averageTrueRange(rows, index) })
  }
  return { pool, entryCandidates, prev }
}

export async function prefetchDay(universe: Universe, day: string) {
  const { pool, entryCandidates } = daySymbolSets(universe, day)
  const midnight = easternMidnight(day)
  await getMinuteBarsForDay(day, [...pool, ...entryCandidates], new Date(midnight + 4 * 60 * MINUTE).toISOString(), new Date(midnight + 16 * 60 * MINUTE).toISOString())
}

export async function loadDay(universe: Universe, day: string): Promise<DayMarket> {
  const { pool, entryCandidates, prev } = daySymbolSets(universe, day)
  const midnight = easternMidnight(day)
  const raw = await getMinuteBarsForDay(day, [...pool, ...entryCandidates], new Date(midnight + 4 * 60 * MINUTE).toISOString(), new Date(midnight + 16 * 60 * MINUTE).toISOString())
  const entrySet = new Set(entryCandidates)
  const symbols = new Map<string, SymbolDay>()
  for (const [symbol, list] of Object.entries(raw)) {
    const info = prev.get(symbol)
    if (!info || !list.length) continue
    const bars = (list as RawBar[]).map((bar) => ({ t: Date.parse(bar.t), o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, vw: bar.vw ?? bar.c }))
      .filter((bar) => bar.t >= midnight + 4 * 60 * MINUTE && bar.t < midnight + 16 * 60 * MINUTE)
      .sort((left, right) => left.t - right.t)
    if (!bars.length) continue
    const cumVolume: number[] = []
    const cumPriceVolume: number[] = []
    let volume = 0
    let priceVolume = 0
    for (const bar of bars) {
      volume += bar.v
      priceVolume += bar.vw * bar.v
      cumVolume.push(volume)
      cumPriceVolume.push(priceVolume)
    }
    symbols.set(symbol, {
      symbol,
      name: universe.names.get(symbol) ?? '',
      prevClose: info.prevClose,
      atr: info.atr,
      float: normalizeFloatShares(floatOn(universe, symbol, day), 'fmp'),
      bars,
      cumVolume,
      cumPriceVolume,
      elliottBars: bars.map((bar) => ({ t: new Date(bar.t).toISOString(), h: bar.h, l: bar.l, c: bar.c, v: bar.v, vw: bar.vw })),
      baselineSessions: null,
      news: [],
    })
  }

  const closedCount = (symbol: string, now: number) => {
    const data = symbols.get(symbol)
    return data ? upperBound(data.bars, now - MINUTE) : 0
  }
  const lastClosedBar = (symbol: string, now: number) => {
    const count = closedCount(symbol, now)
    return count ? symbols.get(symbol)!.bars[count - 1] : undefined
  }
  const barAtOrAfter = (symbol: string, start: number) => {
    const data = symbols.get(symbol)
    if (!data) return undefined
    return data.bars[upperBound(data.bars, start - 1)]
  }
  const barStarting = (symbol: string, start: number) => {
    const bar = barAtOrAfter(symbol, start)
    return bar?.t === start ? bar : undefined
  }

  const rankingSymbols = [...symbols.keys()]
  const ranked = new Map<number, Array<{ symbol: string; change: number; bar: MinuteBar; count: number }>>()
  const topSymbols = new Set<string>()
  for (let minute = DECISION_START_MINUTE; minute < FLATTEN_MINUTE; minute += 1) {
    const now = midnight + minute * MINUTE
    const rows: Array<{ symbol: string; change: number; bar: MinuteBar; count: number }> = []
    for (const symbol of rankingSymbols) {
      const count = closedCount(symbol, now)
      if (!count) continue
      const data = symbols.get(symbol)!
      const bar = data.bars[count - 1]
      if (now - (bar.t + MINUTE) > scanConfig.maxTradeAgeSeconds * 1_000) continue
      rows.push({ symbol, change: (bar.c / data.prevClose - 1) * 100, bar, count })
    }
    rows.sort((left, right) => right.change - left.change)
    const top = rows.filter((row) => row.change > 0).slice(0, TOP_GAINERS)
    top.forEach((row) => topSymbols.add(row.symbol))
    ranked.set(minute, top)
  }

  const topList = [...topSymbols]
  await Promise.all(topList.map(async (symbol) => {
    const sessions = await fifteenMinuteSessions(symbol)
    const windowStart = toEasternDay(new Date(midnight - 22 * 24 * 60 * MINUTE).toISOString())
    symbols.get(symbol)!.baselineSessions = [...sessions.entries()]
      .filter(([date]) => date < day && date >= windowStart)
      .sort(([left], [right]) => right.localeCompare(left))
      .slice(0, scanConfig.relativeVolumeLookbackSessions)
      .map(([, buckets]) => buckets)
  }))
  const stories = await getNewsForDay(day, topList, new Date(midnight - 24 * 60 * MINUTE * 2).toISOString(), new Date(midnight + 16 * 60 * MINUTE).toISOString())
  for (const story of stories) {
    const at = Date.parse(story.created_at ?? '')
    if (!Number.isFinite(at)) continue
    for (const symbol of story.symbols ?? []) {
      symbols.get(symbol)?.news.push({ at, headline: story.headline ?? '', summary: story.summary ?? '' })
    }
  }
  for (const data of symbols.values()) data.news.sort((left, right) => right.at - left.at)

  const memo = new Map<number, MinuteCandidate[]>()
  const candidatesAt = (minuteOfDay: number) => {
    const cached = memo.get(minuteOfDay)
    if (cached) return cached
    const now = midnight + minuteOfDay * MINUTE
    const regime = strategyRegime(new Date(now))
    const result: MinuteCandidate[] = []
    ;(ranked.get(minuteOfDay) ?? []).forEach((row, index) => {
      const data = symbols.get(row.symbol)!
      const volume = data.cumVolume[row.count - 1]
      const vwap = volume > 0 ? data.cumPriceVolume[row.count - 1] / volume : undefined
      const sessions = data.baselineSessions ?? []
      const averageVolume = sessions.length
        ? sessions.reduce((sum, buckets) => sum + [...buckets.entries()].reduce((total, [bucket, value]) => total + (bucket <= minuteOfDay ? value : 0), 0), 0) / sessions.length
        : undefined
      const reliable = averageVolume != null && averageVolume >= scanConfig.minimumRelativeVolumeBaselineVolume
      const story = data.news.find((item) => item.at <= now && item.at >= now - 24 * 60 * MINUTE)
      const price = row.bar.c
      const minVolume = Math.max(scanConfig.minVolume, regime.volume)
      const scannerEligible = price >= scanConfig.minPrice && row.change > scanConfig.minChangePercent
        && volume >= minVolume && volume * price >= regime.dollarVolume
      result.push({
        symbol: row.symbol,
        companyName: data.name || undefined,
        price,
        bid: price,
        ask: price,
        volume,
        averageVolume,
        relativeVolume: reliable && volume > 0 ? volume / averageVolume! : undefined,
        relativeVolumeReliable: reliable,
        relativeVolumeBaselineVolume: averageVolume,
        float: data.float,
        floatSource: data.float != null ? 'fmp' : undefined,
        changePercent: row.change,
        vwap,
        atr: data.atr ?? undefined,
        hasNews: Boolean(story),
        catalystType: story?.headline ? catalystKind(story.headline) : undefined,
        catalystSummary: story?.headline ? story.headline.slice(0, 300) : undefined,
        lastTradeAt: new Date(row.bar.t + MINUTE - 1).toISOString(),
        lastTradePrice: price,
        rank: index + 1,
        scannerEligible,
        entryEligibleSymbol: entrySet.has(row.symbol),
      })
    })
    memo.set(minuteOfDay, result)
    return result
  }

  return { day, midnight, symbols, candidatesAt, closedCount, barAtOrAfter, barStarting, lastClosedBar }
}
