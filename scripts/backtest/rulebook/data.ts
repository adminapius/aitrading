// Data for the S & SP rulebook backtest. Reuses the shared cached Alpaca/FMP loaders (raw, unadjusted SIP bars;
// active AND delisted assets) and adds per-symbol-day minute caching, 15-minute volume baselines and daily lists.
import { getAssets, getFifteenMinuteBars, getNewsForDay, pagedMultiSymbolBars, readCache, writeCache, type RawBar } from '../data'
import { buildUniverse, floatOn, toEasternDay, type DailyRow, type Universe } from '../universe'
import { easternMidnight } from '../market'
import { RULEBOOK } from './config'
import { atr, ema, sma, type Bar } from './indicators'

export const MINUTE = 60_000

export function minuteOfDay(t: number) {
  return Math.round((t - easternMidnight(toEasternDay(new Date(t).toISOString()))) / MINUTE)
}

export function sessionOf(t: number) {
  return toEasternDay(new Date(t).toISOString())
}

const EXCLUDED_NAME = /\b(?:ETF|ETN|fund|trust|preferred|depositary|warrants?|rights?|units?|notes?|proshares|ishares|direxion|spdr|leveraged|2x|3x|-1x|-2x|-3x)\b/i
const EXCLUDED_SYMBOL = /(?:[.\-+]|(?:WS|WT)$)/i

// "Common stock only": no warrants, units, rights, preferreds, ETFs/ETNs/funds, symbols with a dot.
export function isCommonStock(symbol: string, name: string) {
  return !EXCLUDED_SYMBOL.test(symbol) && !EXCLUDED_NAME.test(name)
}

export type Reference = {
  universe: Universe
  exchanges: Map<string, string>
  allDays: string[] // every trading day in the loaded history (from SPY)
  periodDays: string[]
  dailyStats: Map<string, DailyStats>
}

export type DailyStats = {
  rows: DailyRow[]
  index: Map<string, number>
  emaFast: Array<number | null>
  smaMid: Array<number | null>
  smaSlow: Array<number | null>
  atr: Array<number | null>
  avgVolume: Array<number | null>
}

export async function loadReference(historyStart: string, start: string, end: string): Promise<Reference> {
  if (!process.env.BACKTEST_PIT_FLOAT) process.env.BACKTEST_PIT_FLOAT = 'quarterly' // float approximated from share-count history
  const universe = await buildUniverse({ historyStart, end, periodStart: start, simFrom: start, simTo: end })
  const exchanges = new Map<string, string>()
  for (const asset of await getAssets()) if (asset.exchange && !exchanges.has(asset.symbol)) exchanges.set(asset.symbol, asset.exchange)
  const allDays = (universe.daily.get('SPY') ?? []).map((row) => row.day)
  const U = RULEBOOK.S.universe
  const dailyStats = new Map<string, DailyStats>()
  for (const [symbol, rows] of universe.daily) {
    const closes = rows.map((row) => row.c)
    const bars: Bar[] = rows.map((row, index) => ({ t: index, o: row.o, h: row.h, l: row.l, c: row.c, v: row.v }))
    dailyStats.set(symbol, {
      rows,
      index: new Map(rows.map((row, index) => [row.day, index])),
      emaFast: ema(closes, U.dailyFast),
      smaMid: sma(closes, U.dailyMid),
      smaSlow: sma(closes, U.dailySlow),
      atr: atr(bars, U.atrDays),
      avgVolume: sma(rows.map((row) => row.v), U.avgVolumeDays),
    })
  }
  return { universe, exchanges, allDays, periodDays: allDays.filter((day) => day >= start && day <= end), dailyStats }
}

export function priorDays(ref: Reference, day: string, count: number) {
  const index = ref.allDays.indexOf(day)
  return index < 0 ? [] : ref.allDays.slice(Math.max(0, index - count), index)
}

// ---- Minute bars, cached one file per symbol per day (4:00-16:00 ET) ----
type Packed = Array<[number, number, number, number, number, number]>

export async function getDayBars(day: string, symbols: string[]): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>()
  const missing: string[] = []
  for (const symbol of [...new Set(symbols)]) {
    const hit = readCache<Packed>(`rulebook/m1/${day}/${symbol}`)
    if (hit) out.set(symbol, hit.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })))
    else missing.push(symbol)
  }
  const midnight = easternMidnight(day)
  const from = new Date(midnight + 4 * 60 * MINUTE).toISOString()
  const to = new Date(midnight + 16 * 60 * MINUTE).toISOString()
  for (let index = 0; index < missing.length; index += 100) {
    const batch = missing.slice(index, index + 100)
    const raw = await pagedMultiSymbolBars(batch, { timeframe: '1Min', start: from, end: to }, 'rulebook-minute-bars')
    for (const symbol of batch) {
      const bars = ((raw[symbol] ?? []) as RawBar[])
        .map((bar) => ({ t: Date.parse(bar.t), o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }))
        .filter((bar) => bar.t >= midnight + 4 * 60 * MINUTE && bar.t < midnight + 16 * 60 * MINUTE)
        .sort((left, right) => left.t - right.t)
      writeCache(`rulebook/m1/${day}/${symbol}`, bars.map((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v]))
      out.set(symbol, bars)
    }
  }
  return out
}

// ---- 15-minute volume per session (for relative volume at the same time of day) ----
let fifteenStart = ''
let fifteenEnd = ''
const fifteenMemory = new Map<string, Map<string, number[]>>()
const FIFTEEN_MAX = 600
export const BUCKETS = 48 // 4:00-16:00 in 15-minute buckets

export function setFifteenWindow(historyStart: string, end: string) {
  fifteenStart = `${historyStart}T00:00:00Z`
  fifteenEnd = new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000).toISOString().replace('.000Z', 'Z')
}

// session → volume per 15-minute bucket from 4:00 ET (index 0 = 4:00-4:15).
export async function fifteenVolumes(symbol: string) {
  const cachedSymbol = fifteenMemory.get(symbol)
  if (cachedSymbol) {
    fifteenMemory.delete(symbol)
    fifteenMemory.set(symbol, cachedSymbol)
    return cachedSymbol
  }
  const bars = await getFifteenMinuteBars(symbol, fifteenStart, fifteenEnd)
  const byDay = new Map<string, number[]>()
  for (const bar of bars) {
    const t = Date.parse(bar.t)
    const day = toEasternDay(bar.t)
    const bucket = Math.floor((minuteOfDay(t) - 240) / 15)
    if (bucket < 0 || bucket >= BUCKETS) continue
    if (!byDay.has(day)) byDay.set(day, new Array(BUCKETS).fill(0))
    byDay.get(day)![bucket] += Math.max(0, Number(bar.v ?? 0))
  }
  fifteenMemory.set(symbol, byDay)
  while (fifteenMemory.size > FIFTEEN_MAX) fifteenMemory.delete(fifteenMemory.keys().next().value!)
  return byDay
}

// Average cumulative volume from 4:00 up to `minute` over the prior sessions (partial bucket prorated).
export function baselineCumulative(byDay: Map<string, number[]>, sessions: string[], minute: number) {
  if (!sessions.length) return 0
  const offset = minute - 240
  const full = Math.max(0, Math.min(BUCKETS, Math.floor(offset / 15)))
  const partial = full < BUCKETS ? (offset - full * 15) / 15 : 0
  let total = 0
  for (const session of sessions) {
    const buckets = byDay.get(session)
    if (!buckets) continue
    for (let index = 0; index < full; index += 1) total += buckets[index]
    if (partial > 0) total += buckets[full] * partial
  }
  return total / sessions.length
}

export type NewsHit = { at: number; headline: string }

export async function newsBetween(day: string, symbols: string[], startMs: number, endMs: number) {
  const out = new Map<string, NewsHit[]>()
  if (!symbols.length) return out
  const stories = await getNewsForDay(`rulebook-${day}`, symbols, new Date(startMs).toISOString(), new Date(endMs).toISOString())
  const wanted = new Set(symbols)
  for (const story of stories) {
    const at = Date.parse(story.created_at ?? '')
    if (!Number.isFinite(at) || at < startMs || at > endMs) continue
    for (const symbol of story.symbols ?? []) {
      if (!wanted.has(symbol)) continue
      if (!out.has(symbol)) out.set(symbol, [])
      out.get(symbol)!.push({ at, headline: story.headline ?? '' })
    }
  }
  for (const list of out.values()) list.sort((left, right) => left.at - right.at)
  return out
}

// ---- Strategy S daily list (built at 9:00 ET from prior-day data + premarket) ----
export type SListEntry = { symbol: string; prevClose: number; nearHigh: number; gap: number; premarketRvol: number | null; news: boolean }

export async function strategySList(ref: Reference, day: string): Promise<SListEntry[]> {
  const U = RULEBOOK.S.universe
  const ranked: Array<{ symbol: string; prevClose: number; nearHigh: number }> = []
  for (const [symbol, stats] of ref.dailyStats) {
    if (!U.exchanges.includes(ref.exchanges.get(symbol) ?? '')) continue
    if (!isCommonStock(symbol, ref.universe.names.get(symbol) ?? '')) continue
    const index = stats.index.get(day)
    if (index == null || index < 1) continue
    const p = index - 1 // everything as of the prior close: no same-day look-ahead
    const prevClose = stats.rows[p].c
    const fast = stats.emaFast[p]
    const mid = stats.smaMid[p]
    const slow = stats.smaSlow[p]
    const range = stats.atr[p]
    const volume = stats.avgVolume[p]
    if (!(prevClose >= U.minPrice) || fast == null || mid == null || slow == null || range == null || volume == null) continue
    if (volume < U.minAvgVolume || range / prevClose < U.minAtrPct) continue
    if (!(fast > mid && mid > slow)) continue // long list only (S shorts are off)
    let high = 0
    for (let k = Math.max(0, index - U.rankLookbackDays); k < index; k += 1) high = Math.max(high, stats.rows[k].h)
    if (!(high > 0)) continue
    ranked.push({ symbol, prevClose, nearHigh: prevClose / high })
  }
  ranked.sort((left, right) => right.nearHigh - left.nearHigh || left.symbol.localeCompare(right.symbol))
  const prev = priorDays(ref, day, U.rvolSessions)
  const prevDay = prev.at(-1)
  const midnight = easternMidnight(day)
  const listTime = midnight + U.premarketEndMinute * MINUTE
  const newsStart = prevDay ? easternMidnight(prevDay) + 16 * 60 * MINUTE : listTime - 86_400_000
  const out: SListEntry[] = []
  const premarketBuckets = (U.premarketEndMinute - 240) / 15
  for (let offset = 0; offset < ranked.length && out.length < U.keepTop && offset < U.newsScanTop * 5; offset += U.newsScanTop) {
    const batch = ranked.slice(offset, offset + U.newsScanTop)
    const news = await newsBetween(day, batch.map((entry) => entry.symbol), newsStart, listTime)
    for (const entry of batch) {
      if (out.length >= U.keepTop) break
      const byDay = await fifteenVolumes(entry.symbol)
      const today = byDay.get(day)
      let gap = 0
      let premarketVolume = 0
      if (today) {
        for (let bucket = 0; bucket < premarketBuckets; bucket += 1) premarketVolume += today[bucket]
      }
      const lastPremarket = await lastPremarketPrice(entry.symbol, day, U.premarketEndMinute)
      if (lastPremarket != null) gap = lastPremarket / entry.prevClose - 1
      const baseline = baselineCumulative(byDay, prev, U.premarketEndMinute)
      const premarketRvol = baseline > 0 ? premarketVolume / baseline : null
      const hasNews = (news.get(entry.symbol)?.length ?? 0) > 0
      if (gap >= U.inPlayMinGap || hasNews || (premarketRvol != null && premarketRvol >= U.inPlayMinPremarketRvol)) {
        out.push({ ...entry, gap, premarketRvol, news: hasNews })
      }
    }
  }
  return out
}

// Last 15-minute close before the list time (the 8:45 bar closes at 9:00).
const fifteenCloseMemory = new Map<string, Map<string, Array<{ minute: number; c: number }>>>()
async function lastPremarketPrice(symbol: string, day: string, beforeMinute: number) {
  let byDay = fifteenCloseMemory.get(symbol)
  if (!byDay) {
    byDay = new Map()
    for (const bar of await getFifteenMinuteBars(symbol, fifteenStart, fifteenEnd)) {
      const t = Date.parse(bar.t)
      const session = toEasternDay(bar.t)
      if (!byDay.has(session)) byDay.set(session, [])
      byDay.get(session)!.push({ minute: minuteOfDay(t), c: bar.c })
    }
    fifteenCloseMemory.set(symbol, byDay)
    while (fifteenCloseMemory.size > FIFTEEN_MAX) fifteenCloseMemory.delete(fifteenCloseMemory.keys().next().value!)
  }
  let price: number | null = null
  for (const bar of byDay.get(day) ?? []) if (bar.minute >= 240 && bar.minute + 15 <= beforeMinute) price = bar.c
  return price
}

// ---- Strategy SP daily superset (only decides which symbols to download; every rule is applied minute by minute) ----
export function strategySPCandidates(ref: Reference, day: string) {
  const S = RULEBOOK.SP.scanner
  const out: Array<{ symbol: string; prevClose: number; float: number }> = []
  for (const [symbol, stats] of ref.dailyStats) {
    if (!isCommonStock(symbol, ref.universe.names.get(symbol) ?? '')) continue
    const index = stats.index.get(day)
    if (index == null || index < 1) continue
    const row = stats.rows[index]
    const prevClose = stats.rows[index - 1].c
    if (!(prevClose > 0)) continue
    // Loose superset of the minute rules (margins absorb daily-vs-minute volume differences).
    if (row.h < prevClose * (1 + S.minGap * 0.75) || row.l > S.maxPrice || row.h < S.minPrice || row.v < S.minVolumeEarly * 0.5) continue
    const float = floatOn(ref.universe, symbol, day)
    if (float == null || float >= S.maxFloat) continue
    out.push({ symbol, prevClose, float })
  }
  return out
}

export function dailyPivotHighs(ref: Reference, symbol: string, day: string) {
  const stats = ref.dailyStats.get(symbol)
  const index = stats?.index.get(day)
  if (!stats || index == null) return []
  const out: number[] = []
  const from = Math.max(1, index - RULEBOOK.resistance.dailyPivotLookbackDays)
  // A daily pivot at k needs bar k+1, so only pivots with k+1 < index (before today) count.
  for (let k = from; k < index - 1; k += 1) {
    if (stats.rows[k].h > stats.rows[k - 1].h && stats.rows[k].h > stats.rows[k + 1].h) out.push(stats.rows[k].h)
  }
  return out
}
