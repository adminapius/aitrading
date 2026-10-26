// Scanner rows and alert filters (spec sections 1-2). Pure functions; the route and the alert runner fetch the data.
import { ASSISTANT } from '@/lib/assistant/config'

export type Halt = { status: 'halted' | 'resumed' | 'luld' | 'inferred' | 'none'; at: string | null; reason: string | null }
export type ScannerRow = {
  symbol: string; name: string | null; price: number; gainPct: number | null; volume: number | null
  relativeVolume: number | null; relativeVolumeReliable: boolean; spreadPct: number | null
  float: number | null; floatSource: 'edgar' | null; floatMiss: string | null; floatAsOf: string | null; fmpFloat: number | null; filer: 'domestic' | 'foreign' | 'unknown'
  headline: string | null; headlineAt: string | null; headlineAgeMin: number | null
  halt: Halt; dilution: { flagged: boolean; forms: string[]; links: string[] }; lastTradeAt: string | null
}

export type Filters = {
  floatMax: number | null; priceMin: number | null; priceMax: number | null; gainMin: number | null; rvolMin: number | null
  newsMinutes: number | null; excludeDilution: boolean; excludeHalted: boolean; windowStart: number; windowEnd: number; reAlertNewHigh: boolean
}
/** Defaults = the Ross-type filters (float <= 5M, $2-20, gain >= 20%, news within 120 min), all editable. */
export const DEFAULT_FILTERS: Filters = { floatMax: 5_000_000, priceMin: 2, priceMax: 20, gainMin: 20, rvolMin: null, newsMinutes: 120, excludeDilution: false, excludeHalted: true, windowStart: ASSISTANT.scannerWindow[0], windowEnd: ASSISTANT.scannerWindow[1], reAlertNewHigh: false }

/** A6 fallback: no trade for 5+ minutes during regular hours = "inferred" halt. Pure. */
export function inferHalt(lastTradeAt: string | null, now: Date, etMinuteNow: number): Halt {
  if (!lastTradeAt || etMinuteNow < 9 * 60 + 30 || etMinuteNow >= 16 * 60) return { status: 'none', at: null, reason: null }
  const age = (now.getTime() - Date.parse(lastTradeAt)) / 60_000
  return age >= ASSISTANT.haltInferMinutes ? { status: 'inferred', at: lastTradeAt, reason: `no trade for ${Math.floor(age)} min` } : { status: 'none', at: null, reason: null }
}

/** The stream's latest status for the symbol today wins over the inferred one. Pure. */
export function haltStatus(stream: Halt | null, inferred: Halt): Halt {
  if (stream && stream.status !== 'none') return stream
  return inferred
}

/** Which filters a row fails ([] = it matches). A missing value fails a filter that needs it. Pure. */
export function failedFilters(row: ScannerRow, f: Filters, etMinuteNow: number): string[] {
  const out: string[] = []
  if (etMinuteNow < f.windowStart || etMinuteNow >= f.windowEnd) out.push('outside the time window')
  if (f.floatMax != null && !(row.float != null && row.float <= f.floatMax)) out.push(row.float == null ? 'no EDGAR float' : 'float above max')
  if (f.priceMin != null && row.price < f.priceMin) out.push('price below min')
  if (f.priceMax != null && row.price > f.priceMax) out.push('price above max')
  if (f.gainMin != null && !(row.gainPct != null && row.gainPct >= f.gainMin)) out.push('gain below min')
  if (f.rvolMin != null && !(row.relativeVolume != null && row.relativeVolumeReliable && row.relativeVolume >= f.rvolMin)) out.push('relative volume below min')
  if (f.newsMinutes != null && !(row.headlineAgeMin != null && row.headlineAgeMin <= f.newsMinutes)) out.push('no news in the window')
  if (f.excludeDilution && row.dilution.flagged) out.push('dilution flag')
  if (f.excludeHalted && (row.halt.status === 'halted' || row.halt.status === 'luld' || row.halt.status === 'inferred')) out.push('halted')
  return out
}

/** One alert per symbol per day; again only after a new high above the alerted price when reAlertNewHigh is on. Pure. */
export function shouldAlert(previous: { price: number } | null, row: ScannerRow, f: Filters) {
  if (!previous) return true
  return f.reAlertNewHigh && row.price > previous.price
}

/** The push text: facts only, and that no order was sent. Pure. */
export function alertText(row: ScannerRow) {
  const parts = [
    row.gainPct != null ? `+${row.gainPct.toFixed(0)}%` : null,
    `$${row.price.toFixed(2)}`,
    row.float != null ? `float ${(row.float / 1e6).toFixed(1)}M` : 'float n/a',
    row.relativeVolume != null ? `RVOL ${row.relativeVolume.toFixed(1)}` : null,
    row.headlineAgeMin != null ? `news ${row.headlineAgeMin} min ago` : 'no news',
    row.dilution.flagged ? 'DILUTION FLAG' : null,
    row.halt.status !== 'none' ? `halt: ${row.halt.status}` : null,
  ].filter(Boolean)
  return { title: `${row.symbol} matches your filters`, body: `${parts.join(' · ')}. Assistant only; no order was sent.` }
}
