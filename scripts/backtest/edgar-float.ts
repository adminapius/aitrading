// Point-in-time shares outstanding from SEC EDGAR, used as the float for E-J $3-10 and the D12 E-current read.
// BACKTEST ONLY. Spec: docs/strategy-ej-310-spec.md (D1, D2). Tagged [approximate]: shares outstanding >= float.
//
// - Value on a trade day = the most current cover-page share count among those FILED strictly before that day (by
//   filing date: no look-ahead; an amendment re-reporting an older count does not override a newer one), at most MAX_AGE_DAYS old by filing date, adjusted for splits between the count's
//   as-of date and the trade day (from Alpaca raw vs split-adjusted daily closes).
// - Sources in order: dei:EntityCommonStockSharesOutstanding (10-K/10-Q/20-F/40-F cover pages), then
//   us-gaap:CommonStockSharesOutstanding, then ifrs-full:NumberOfSharesOutstanding (balance-sheet counts).
//   Several values in one filing (share classes) are summed.
// - Foreign filers (latest annual report a 20-F or 40-F): annual cover values only (6-K has no XBRL share count).
// - No CIK, a company name that does not match the ticker's name (reused tickers), no value, or a stale value ->
//   no float -> not enterable, and counted by reason.
import { readCache, writeCache, type RawBar } from './data'
import { cikFor, isForeignFiler, sec, secCompany } from './rulebook/edgar-earnings'

export const EDGAR_FLOAT = {
  maxAgeDays: 400, // by filing date; lets an annual 20-F value through, not one a year late
  tags: [['dei', 'EntityCommonStockSharesOutstanding'], ['us-gaap', 'CommonStockSharesOutstanding'], ['ifrs-full', 'NumberOfSharesOutstanding']] as const,
} as const

export type SharePoint = { filed: string; end: string; shares: number; form: string; accn: string }
export type SharesRecord = { cik: string; entityName: string | null; source: string | null; points: SharePoint[] }
export type FilerType = 'domestic' | 'foreign' | 'unknown'
export type FloatMiss = 'sec-error' | 'no-cik' | 'name-mismatch' | 'no-value' | 'none-filed-before' | 'stale' | 'no-split-data'
export type FloatResult = { shares: number; filed: string; ageDays: number; source: string; filer: FilerType } | { miss: FloatMiss; filer: FilerType }

/** One company's SEC data could not be read (bad response, parse failure, request failure): not cached, retried next run. */
export class SecDataError extends Error {}
export const edgarIssues = { noSharesShape: 0, errors: 0 }
const LOG_FIRST = 5

/** Facts from one companyconcept response -> one point per filing (classes summed, duplicates dropped). A missing or
 *  non-array value is no data. Pure. */
export function sharePoints(units: unknown): SharePoint[] {
  if (!Array.isArray(units)) return []
  const byFiling = new Map<string, { filed: string; end: string; form: string; values: Map<string, number> }>()
  for (const u of units as Array<{ end?: string; val?: number; accn?: string; form?: string; filed?: string } | null>) {
    if (!u || typeof u !== 'object') continue
    if (!u.accn || !u.filed || !u.end || !(Number(u.val) > 0)) continue
    const row = byFiling.get(u.accn) ?? { filed: u.filed, end: u.end, form: u.form ?? '', values: new Map<string, number>() }
    if (u.end > row.end) { row.end = u.end; row.values.clear() } // keep the latest as-of date in that filing
    if (u.end === row.end) row.values.set(`${u.end}:${u.val}`, Number(u.val))
    byFiling.set(u.accn, row)
  }
  return [...byFiling.entries()].map(([accn, r]) => ({ accn, filed: r.filed, end: r.end, form: r.form, shares: [...r.values.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => a.filed.localeCompare(b.filed) || a.accn.localeCompare(b.accn))
}

/**
 * The most current share count available on `day`: among points FILED strictly before the day (no look-ahead),
 * the one with the latest as-of date; ties go to the later filing. An amendment filed later that re-reports an
 * older as-of count (e.g. a 10-Q/A for last year's quarter) does not override a newer count. Pure.
 */
export function pointBefore(points: SharePoint[], day: string): SharePoint | null {
  let pick: SharePoint | null = null
  for (const p of points) {
    if (p.filed >= day) break
    if (!pick || p.end > pick.end || (p.end === pick.end && p.filed >= pick.filed)) pick = p
  }
  return pick
}

const STOP = new Set(['inc', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'plc', 'holdings', 'holding', 'group', 'the', 'class', 'common', 'stock', 'shares', 'ordinary', 'american', 'depositary', 'ads', 'adr', 'sa', 'nv', 'ag', 'se', 'lp', 'llc', 'trust', 'international', 'technologies', 'technology', 'therapeutics', 'pharmaceuticals', 'bio', 'biosciences', 'new', 'and', 'of', 'de'])
const tokens = (name: string) => name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t))
/** Ticker reuse guard: the Alpaca asset name and the EDGAR entity name share a distinctive word. Pure. */
export function namesMatch(assetName: string | undefined, entityName: string | null) {
  if (!assetName || !entityName) return true // nothing to compare: do not exclude on that alone
  const a = new Set(tokens(assetName))
  const b = tokens(entityName)
  if (!a.size || !b.length) return true
  return b.some((t) => a.has(t) || [...a].some((x) => x.length >= 5 && t.length >= 5 && (x.startsWith(t) || t.startsWith(x))))
}

/**
 * rawClose / splitAdjustedClose on the last trading day on or before `day`, or null when there is no bar on or
 * before it. Split-adjusted closes are adjusted for EVERY split up to the download date, so this ratio is the
 * product of all split factors after `day`. Dividing two of them (count date vs trade day) leaves only the splits
 * between the two dates: splits after the trade day appear in both and cancel. Pure.
 */
export function splitRatio(raw: Map<string, number>, adjusted: Map<string, number>, days: string[], day: string): number | null {
  let lo = 0, hi = days.length - 1, at = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] <= day) { at = mid; lo = mid + 1 } else hi = mid - 1 }
  if (at < 0) return null
  const r = raw.get(days[at]), a = adjusted.get(days[at])
  return r && a ? r / a : null
}
/** Shares at the count's as-of date -> shares on the trade day, across splits in between. Pure. */
export function splitAdjustShares(shares: number, ratioAtCount: number, ratioOnDay: number) {
  return ratioOnDay > 0 ? shares * (ratioAtCount / ratioOnDay) : shares
}

export async function sharesRecord(cik: string): Promise<SharesRecord> {
  const key = `sec/v4/shares/${cik}`
  const hit = readCache<SharesRecord>(key)
  if (hit) return hit
  let out: SharesRecord = { cik, entityName: null, source: null, points: [] }
  for (const [taxonomy, tag] of EDGAR_FLOAT.tags) {
    // sec() returns null on 404 (SEC's answer when the company never reported this concept): try the next tag.
    // Request failures (retries used up, 403) throw and are counted as sec-error by the caller; nothing is cached.
    const text = await sec(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${tag}.json`)
    if (!text) continue
    let json: unknown
    try { json = JSON.parse(text) } catch { throw new SecDataError(`CIK ${cik} ${taxonomy}:${tag}: response is not JSON (${text.slice(0, 60).replace(/\s+/g, ' ')})`) }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new SecDataError(`CIK ${cik} ${taxonomy}:${tag}: response is not a JSON object`)
    const obj = json as Record<string, unknown>
    const units = obj.units
    const shares = units && typeof units === 'object' && !Array.isArray(units) ? (units as Record<string, unknown>).shares : undefined
    if (!Array.isArray(shares)) {
      edgarIssues.noSharesShape += 1
      if (edgarIssues.noSharesShape <= LOG_FIRST) {
        const unitKeys = units && typeof units === 'object' && !Array.isArray(units) ? Object.keys(units as object).join(',') : typeof units
        console.log(`[edgar-float] CIK ${cik} ${taxonomy}:${tag}: no units.shares array -> no data (top-level keys: ${Object.keys(obj).join(',')}; units: ${unitKeys})`)
      }
    }
    const points = sharePoints(shares)
    out = { cik, entityName: typeof obj.entityName === 'string' ? obj.entityName : out.entityName, source: `${taxonomy}:${tag}`, points }
    if (points.length) break
  }
  writeCache(key, out)
  return out
}

export type SymbolFloat = { cik: string | null; record: SharesRecord | null; nameOk: boolean; annual: Awaited<ReturnType<typeof secCompany>>['annual']; error?: string }

/** Builds the per-symbol EDGAR data for `symbols` (SEC at under 10 requests/s; cached per CIK). */
export async function loadEdgarFloat(symbols: string[], names: Map<string, string>, onProgress?: (done: number) => void) {
  const out = new Map<string, SymbolFloat>()
  let done = 0
  for (const symbol of symbols) {
    let cik: string | null = null
    try {
      cik = (await cikFor(symbol)).cik
      if (!cik) out.set(symbol, { cik: null, record: null, nameOk: false, annual: [] })
      else {
        const [record, company] = [await sharesRecord(cik), await secCompany(cik)]
        out.set(symbol, { cik, record, nameOk: namesMatch(names.get(symbol), record.entityName), annual: company.annual })
      }
    } catch (error) {
      // One company's failure never stops the run: counted as sec-error, not cached, retried on the next run.
      const message = error instanceof Error ? error.message : String(error)
      edgarIssues.errors += 1
      if (edgarIssues.errors <= LOG_FIRST) console.log(`[edgar-float] ${symbol}${cik ? ` (CIK ${cik})` : ''}: SEC data error, counted as sec-error: ${message.slice(0, 200)}`)
      out.set(symbol, { cik, record: null, nameOk: false, annual: [], error: message })
    }
    done += 1
    if (onProgress && done % 250 === 0) onProgress(done)
  }
  return out
}

export function filerType(data: SymbolFloat | undefined, day: string): FilerType {
  if (!data?.cik) return 'unknown'
  if (!data.annual.length) return 'unknown'
  return isForeignFiler(data.annual, day) ? 'foreign' : 'domestic'
}

/** Float (EDGAR shares outstanding) on `day`, or the reason there is none. Pure given the loaded data. */
export function edgarFloatOn(data: SymbolFloat | undefined, day: string, ratios?: { raw: Map<string, number>; adjusted: Map<string, number>; days: string[] }): FloatResult {
  const filer = filerType(data, day)
  if (data?.error) return { miss: 'sec-error', filer }
  if (!data?.cik) return { miss: 'no-cik', filer }
  if (!data.nameOk) return { miss: 'name-mismatch', filer }
  if (!data.record?.points.length) return { miss: 'no-value', filer }
  const p = pointBefore(data.record.points, day)
  if (!p) return { miss: 'none-filed-before', filer }
  const ageDays = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${p.filed}T00:00:00Z`)) / 86_400_000)
  if (ageDays > EDGAR_FLOAT.maxAgeDays) return { miss: 'stale', filer }
  let shares = p.shares
  if (ratios) {
    // Both ratios must come from real bars; a count dated before the first bar would otherwise be scaled by the
    // splits after the trade day only (e.g. a later 2-for-1 halving a 2022 count), so it counts as missing instead.
    const atCount = splitRatio(ratios.raw, ratios.adjusted, ratios.days, p.end)
    const onDay = splitRatio(ratios.raw, ratios.adjusted, ratios.days, day)
    if (atCount == null || onDay == null) return { miss: 'no-split-data', filer }
    shares = splitAdjustShares(p.shares, atCount, onDay)
  }
  return { shares, filed: p.filed, ageDays, source: data.record.source ?? '', filer }
}

/** Close-by-day maps for the split ratio, from raw and split-adjusted Alpaca daily bars. */
export function closeMaps(raw: RawBar[] | undefined, adjusted: RawBar[] | undefined, toDay: (t: string) => string) {
  const r = new Map((raw ?? []).map((b) => [toDay(b.t), b.c]))
  const a = new Map((adjusted ?? []).map((b) => [toDay(b.t), b.c]))
  return { raw: r, adjusted: a, days: [...r.keys()].filter((d) => a.has(d)).sort() }
}
