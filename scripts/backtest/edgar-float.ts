// Point-in-time shares outstanding from SEC EDGAR, used as the float for E-J $3-10 and the D12 E-current read.
// BACKTEST ONLY. Spec: docs/strategy-ej-310-spec.md (D1, D2). Tagged [approximate]: shares outstanding >= float.
//
// - Value on a trade day = the latest cover-page share count FILED strictly before that day (by filing date, not
//   period end: no look-ahead), at most MAX_AGE_DAYS old by filing date, adjusted for splits between the count's
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
export type FloatMiss = 'no-cik' | 'name-mismatch' | 'no-value' | 'none-filed-before' | 'stale'
export type FloatResult = { shares: number; filed: string; ageDays: number; source: string; filer: FilerType } | { miss: FloatMiss; filer: FilerType }

/** Facts from one companyconcept response -> one point per filing (classes summed, duplicates dropped). Pure. */
export function sharePoints(units: Array<{ end?: string; val?: number; accn?: string; form?: string; filed?: string }>): SharePoint[] {
  const byFiling = new Map<string, { filed: string; end: string; form: string; values: Map<string, number> }>()
  for (const u of units) {
    if (!u.accn || !u.filed || !u.end || !(Number(u.val) > 0)) continue
    const row = byFiling.get(u.accn) ?? { filed: u.filed, end: u.end, form: u.form ?? '', values: new Map<string, number>() }
    if (u.end > row.end) { row.end = u.end; row.values.clear() } // keep the latest as-of date in that filing
    if (u.end === row.end) row.values.set(`${u.end}:${u.val}`, Number(u.val))
    byFiling.set(u.accn, row)
  }
  return [...byFiling.entries()].map(([accn, r]) => ({ accn, filed: r.filed, end: r.end, form: r.form, shares: [...r.values.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => a.filed.localeCompare(b.filed) || a.accn.localeCompare(b.accn))
}

/** Latest point filed strictly before `day`. Pure. */
export function pointBefore(points: SharePoint[], day: string): SharePoint | null {
  let pick: SharePoint | null = null
  for (const p of points) {
    if (p.filed >= day) break
    pick = p
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

/** rawClose / splitAdjustedClose on the last trading day on or before `day`. Pure. */
export function splitRatio(raw: Map<string, number>, adjusted: Map<string, number>, days: string[], day: string) {
  let lo = 0, hi = days.length - 1, at = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] <= day) { at = mid; lo = mid + 1 } else hi = mid - 1 }
  if (at < 0) return 1
  const r = raw.get(days[at]), a = adjusted.get(days[at])
  return r && a ? r / a : 1
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
    const text = await sec(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${tag}.json`)
    if (!text) continue
    const json = JSON.parse(text) as { entityName?: string; units?: Record<string, Array<{ end?: string; val?: number; accn?: string; form?: string; filed?: string }>> }
    const points = sharePoints(json.units?.shares ?? [])
    out = { cik, entityName: json.entityName ?? out.entityName, source: `${taxonomy}:${tag}`, points }
    if (points.length) break
  }
  writeCache(key, out)
  return out
}

type SymbolFloat = { cik: string | null; record: SharesRecord | null; nameOk: boolean; annual: Awaited<ReturnType<typeof secCompany>>['annual'] }

/** Builds the per-symbol EDGAR data for `symbols` (SEC at under 10 requests/s; cached per CIK). */
export async function loadEdgarFloat(symbols: string[], names: Map<string, string>, onProgress?: (done: number) => void) {
  const out = new Map<string, SymbolFloat>()
  let done = 0
  for (const symbol of symbols) {
    const { cik } = await cikFor(symbol)
    if (!cik) out.set(symbol, { cik: null, record: null, nameOk: false, annual: [] })
    else {
      const [record, company] = [await sharesRecord(cik), await secCompany(cik)]
      out.set(symbol, { cik, record, nameOk: namesMatch(names.get(symbol), record.entityName), annual: company.annual })
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
  if (!data?.cik) return { miss: 'no-cik', filer }
  if (!data.nameOk) return { miss: 'name-mismatch', filer }
  if (!data.record?.points.length) return { miss: 'no-value', filer }
  const p = pointBefore(data.record.points, day)
  if (!p) return { miss: 'none-filed-before', filer }
  const ageDays = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${p.filed}T00:00:00Z`)) / 86_400_000)
  if (ageDays > EDGAR_FLOAT.maxAgeDays) return { miss: 'stale', filer }
  const shares = ratios ? splitAdjustShares(p.shares, splitRatio(ratios.raw, ratios.adjusted, ratios.days, p.end), splitRatio(ratios.raw, ratios.adjusted, ratios.days, day)) : p.shares
  return { shares, filed: p.filed, ageDays, source: data.record.source ?? '', filer }
}

/** Close-by-day maps for the split ratio, from raw and split-adjusted Alpaca daily bars. */
export function closeMaps(raw: RawBar[] | undefined, adjusted: RawBar[] | undefined, toDay: (t: string) => string) {
  const r = new Map((raw ?? []).map((b) => [toDay(b.t), b.c]))
  const a = new Map((adjusted ?? []).map((b) => [toDay(b.t), b.c]))
  return { raw: r, adjusted: a, days: [...r.keys()].filter((d) => a.has(d)).sort() }
}
