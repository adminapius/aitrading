import { scanConfig } from '../../lib/scan-config'
import { getAssets, getCurrentFloats, getDailyBars, type RawBar } from './data'

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

export async function buildUniverse(input: { historyStart: string; end: string; periodStart: string }): Promise<Universe> {
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
  return { symbols, names, delisted, daily, floats, tradingDays }
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
