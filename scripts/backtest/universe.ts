import { scanConfig } from '../../lib/scan-config'
import { getAssets, getCurrentFloats, getCurrentFreeFloatPercents, getDailyBars, getDailyMarketCaps, getShareCountHistory, type RawBar, type ShareCountPoint } from './data'

const SUPPORTED_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS'])
const EXCLUDED_NAME = /\b(?:warrants?|rights?|units?)\b/i
const EXCLUDED_SUFFIX = /(?:\.(?:WS|WT|U|R)|[-.]?(?:WS|WT)|\+)$/i
const VALID_SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/

export type DailyRow = { day: string; o: number; h: number; l: number; c: number; v: number }

export type Universe = {
  symbols: string[]
  names: Map<string, string>
  delisted: Set<string>
  daily: Map<string, DailyRow[]>
  floats: Record<string, number>
  tradingDays: string[]
  shareHistory?: Map<string, Array<{ date: string; shares: number }>>
  dailyShares?: Map<string, Array<{ date: string; shares: number }>>
  freeFloatPct?: Record<string, number>
}

export type FloatMode = 'current' | 'quarterly' | 'daily'

export function floatMode(): FloatMode {
  const value = process.env.BACKTEST_PIT_FLOAT?.trim()
  if (value === 'daily') return 'daily'
  if (value === 'true' || value === 'quarterly') return 'quarterly'
  return 'current'
}

export const floatLookups = { daily: 0, quarterly: 0, current: 0, missing: 0 }

// A daily point is only trusted if it is from a trading day strictly before the decision day (no same-day
// close lookahead) and no more than 7 calendar days old; otherwise fall back to quarterly, then current.
const DAILY_MAX_AGE_MS = 7 * 86_400_000

function dailyFloatOn(universe: Universe, symbol: string, day: string) {
  const points = universe.dailyShares?.get(symbol)
  const percent = universe.freeFloatPct?.[symbol]
  if (!points?.length || percent == null) return undefined
  let asOf: { date: string; shares: number } | undefined
  for (const point of points) {
    if (point.date >= day) break
    asOf = point
  }
  if (!asOf || Date.parse(day) - Date.parse(asOf.date) > DAILY_MAX_AGE_MS) return undefined
  return asOf.shares * (percent / 100)
}

export function floatOn(universe: Universe, symbol: string, day: string): number | undefined {
  if (universe.dailyShares) {
    const daily = dailyFloatOn(universe, symbol, day)
    if (daily != null) {
      floatLookups.daily += 1
      return daily
    }
  }
  const value = quarterlyFloatOn(universe, symbol, day)
  if (value == null) floatLookups.missing += 1
  return value
}

function quarterlyFloatOn(universe: Universe, symbol: string, day: string): number | undefined {
  const current = universe.floats[symbol]
  const history = universe.shareHistory?.get(symbol)
  if (current != null && history?.length) floatLookups.quarterly += 1
  else if (current != null) floatLookups.current += 1
  if (current == null || !history?.length) return current
  const latest = history.at(-1)!.shares
  let asOf: number | undefined
  for (const point of history) {
    if (point.date > day) break
    asOf = point.shares
  }
  return asOf == null ? current : current * (asOf / latest)
}

const easternDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

const easternDayCache = new Map<number, string>()

export function toEasternDay(iso: string) {
  const hour = Math.floor(Date.parse(iso) / 3_600_000)
  let day = easternDayCache.get(hour)
  if (day === undefined) {
    day = easternDate.format(new Date(hour * 3_600_000))
    easternDayCache.set(hour, day)
  }
  return day
}

export async function buildUniverse(input: { historyStart: string; end: string; periodStart: string; simFrom?: string; simTo?: string }): Promise<Universe> {
  const assets = await getAssets()
  const names = new Map<string, string>()
  const delisted = new Set<string>()
  for (const asset of assets) {
    if (asset.class && asset.class !== 'us_equity') continue
    if (!asset.exchange || !SUPPORTED_EXCHANGES.has(asset.exchange)) continue
    if (!VALID_SYMBOL.test(asset.symbol) || EXCLUDED_SUFFIX.test(asset.symbol) || EXCLUDED_NAME.test(asset.name ?? '')) continue
    if (names.has(asset.symbol)) continue
    names.set(asset.symbol, asset.name?.trim() ?? '')
    if (asset.status !== 'active') delisted.add(asset.symbol)
  }
  const symbols = [...names.keys()].sort()
  const [rawDaily, floats] = await Promise.all([getDailyBars(symbols, input.historyStart, input.end), getCurrentFloats()])
  const daily = new Map<string, DailyRow[]>()
  const daySet = new Set<string>()
  for (const [symbol, bars] of Object.entries(rawDaily)) {
    const rows = (bars as RawBar[]).map((bar) => ({ day: toEasternDay(bar.t), o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }))
    daily.set(symbol, rows)
    if (symbol === 'SPY') rows.forEach((row) => daySet.add(row.day))
  }
  const tradingDays = [...daySet].filter((day) => day >= input.periodStart && day <= input.end).sort()
  const universe: Universe = { symbols, names, delisted, daily, floats, tradingDays }
  const mode = floatMode()
  floatCoverage.mode = mode
  if (mode !== 'current') {
    const from = input.simFrom ?? input.periodStart
    const to = input.simTo ?? input.end
    const needed = floatCandidates(universe, from, to)
    floatCoverage.candidates = needed.length
    universe.shareHistory = await loadShareHistory(needed)
    if (mode === 'daily') {
      universe.freeFloatPct = await getCurrentFreeFloatPercents()
      universe.dailyShares = await loadDailyShares(universe, needed, input.historyStart, to)
    }
  }
  return universe
}

type FetchFailure = { symbol: string; error: string }

export const floatCoverage = {
  mode: 'current' as FloatMode,
  candidates: 0,
  quarterly: { withHistory: 0, empty: [] as string[], failedFirstPass: 0, failed: [] as FetchFailure[] },
  daily: { withData: 0, empty: [] as string[], noFreeFloatPct: [] as string[], failedFirstPass: 0, failed: [] as FetchFailure[], sanitySkipped: [] as string[] },
}

const RETRY_PASSES = 3

// fetchJson already retries 429/5xx/network errors six times with backoff; these extra passes re-run every
// symbol that still failed after a pause, so a burst of rate limiting cannot silently drop symbols.
async function fetchAllWithRetry<T>(symbols: string[], load: (symbol: string) => Promise<T>) {
  const results = new Map<string, T>()
  let pending = symbols
  let failures: FetchFailure[] = []
  let firstPassFailures = 0
  for (let pass = 0; pass <= RETRY_PASSES && pending.length; pass += 1) {
    if (pass > 0) await new Promise((resolve) => setTimeout(resolve, 15_000 * pass))
    failures = []
    await Promise.all(pending.map(async (symbol) => {
      try {
        results.set(symbol, await load(symbol))
      } catch (error) {
        failures.push({ symbol, error: error instanceof Error ? error.message.slice(0, 160) : String(error) })
      }
    }))
    if (pass === 0) firstPassFailures = failures.length
    pending = failures.map((failure) => failure.symbol)
  }
  return { results, failures: failures.sort((left, right) => left.symbol.localeCompare(right.symbol)), firstPassFailures }
}

async function loadDailyShares(universe: Universe, needed: string[], from: string, to: string) {
  const { results, failures, firstPassFailures } = await fetchAllWithRetry(needed, (symbol) => getDailyMarketCaps(symbol, from, to))
  const dailyShares = new Map<string, Array<{ date: string; shares: number }>>()
  for (const [symbol, points] of results) {
    if (!points.length) {
      floatCoverage.daily.empty.push(symbol)
      continue
    }
    if (universe.freeFloatPct?.[symbol] == null) floatCoverage.daily.noFreeFloatPct.push(symbol)
    const closes = new Map((universe.daily.get(symbol) ?? []).map((row) => [row.day, row.c]))
    const shares = points
      .map((point) => ({ date: point.date, shares: point.marketCap / (closes.get(point.date) ?? Number.NaN) }))
      .filter((point) => Number.isFinite(point.shares) && point.shares > 0)
    if (!shares.length) {
      floatCoverage.daily.sanitySkipped.push(symbol)
      continue
    }
    dailyShares.set(symbol, shares)
  }
  floatCoverage.daily.withData = dailyShares.size
  floatCoverage.daily.failed = failures
  floatCoverage.daily.failedFirstPass = firstPassFailures
  floatCoverage.daily.empty.sort()
  floatCoverage.daily.noFreeFloatPct.sort()
  console.log(`[backtest] daily float: ${dailyShares.size} with daily shares, ${floatCoverage.daily.empty.length} empty, ${floatCoverage.daily.noFreeFloatPct.length} without free-float %, ${firstPassFailures} failed first pass, ${failures.length} still failed`)
  return dailyShares
}

// Small caps mostly dilute over time, so a symbol above the 10M float cap today may have been under it
// earlier. Any candidate with a current float up to 10x the cap gets its share-count history loaded.
const PIT_FLOAT_CURRENT_CAP = 100_000_000

function floatCandidates(universe: Universe, from: string, to: string) {
  const needed = new Set<string>()
  for (const [symbol, rows] of universe.daily) {
    const current = universe.floats[symbol]
    if (current == null || current > PIT_FLOAT_CURRENT_CAP) continue
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index]
      if (row.day < from || row.day > to) continue
      const prevClose = rows[index - 1].c
      if (!(prevClose > 0) || row.v < scanConfig.minVolume || Math.max(row.o, row.h) < scanConfig.minPrice) continue
      if (Math.max(row.o, row.h) / prevClose - 1 > 0.02) {
        needed.add(symbol)
        break
      }
    }
  }
  return [...needed].sort()
}

async function loadShareHistory(needed: string[]) {
  console.log(`[backtest] point-in-time float: loading share-count history for ${needed.length} symbols`)
  const { results, failures, firstPassFailures } = await fetchAllWithRetry(needed, getShareCountHistory)
  const history = new Map<string, ShareCountPoint[]>()
  for (const [symbol, points] of results) {
    if (points.length) history.set(symbol, points)
    else floatCoverage.quarterly.empty.push(symbol)
  }
  floatCoverage.quarterly.withHistory = history.size
  floatCoverage.quarterly.failed = failures
  floatCoverage.quarterly.failedFirstPass = firstPassFailures
  floatCoverage.quarterly.empty.sort()
  console.log(`[backtest] point-in-time float: ${history.size} with history, ${floatCoverage.quarterly.empty.length} empty, ${firstPassFailures} failed first pass, ${failures.length} still failed`)
  return history
}

export function dailyIndex(rows: DailyRow[]) {
  return new Map(rows.map((row, index) => [row.day, index]))
}

export function averageTrueRange(rows: DailyRow[], beforeIndex: number) {
  const period = scanConfig.atrPeriod
  const history = rows.slice(0, beforeIndex).slice(-(period + 1))
  if (history.length < period + 1) return null
  let total = 0
  for (let index = 1; index < history.length; index += 1) {
    const bar = history[index]
    const previousClose = history[index - 1].c
    total += Math.max(bar.h - bar.l, Math.abs(bar.h - previousClose), Math.abs(bar.l - previousClose))
  }
  return total / period
}
