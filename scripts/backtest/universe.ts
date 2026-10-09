import { scanConfig } from '../../lib/scan-config'
import { getAssets, getCurrentFloats, getDailyBars, getShareCountHistory, type RawBar, type ShareCountPoint } from './data'

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
}

export function floatOn(universe: Universe, symbol: string, day: string): number | undefined {
  const current = universe.floats[symbol]
  const history = universe.shareHistory?.get(symbol)
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
  if (process.env.BACKTEST_PIT_FLOAT === 'true') universe.shareHistory = await loadShareHistory(universe, input.simFrom ?? input.periodStart, input.simTo ?? input.end)
  return universe
}

// Small caps mostly dilute over time, so a symbol above the 10M float cap today may have been under it
// earlier. Any candidate with a current float up to 10x the cap gets its share-count history loaded.
const PIT_FLOAT_CURRENT_CAP = 100_000_000

async function loadShareHistory(universe: Universe, from: string, to: string) {
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
  console.log(`[backtest] point-in-time float: loading share-count history for ${needed.size} symbols`)
  const history = new Map<string, ShareCountPoint[]>()
  let failures = 0
  await Promise.all([...needed].map(async (symbol) => {
    try {
      const points = await getShareCountHistory(symbol)
      if (points.length) history.set(symbol, points)
    } catch {
      failures += 1
    }
  }))
  console.log(`[backtest] point-in-time float: ${history.size} with history, ${needed.size - history.size - failures} empty, ${failures} failed`)
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
