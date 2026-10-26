// Live EDGAR data for the scanner (spec section 1): point-in-time shares outstanding (the float column) and the
// dilution flag. SEC is free and needs SEC_USER_AGENT ("Name email"); requests stay far under SEC's 10 a second.
// Results are cached per symbol per ET day in Supabase (ait_edgar_daily) so each company is read once a day.
import { ASSISTANT, ASSISTANT_ENV } from '@/lib/assistant/config'
import { marketData } from '@/lib/assistant/alpaca-read'

export type SharePoint = { filed: string; end: string; shares: number; form: string; accn: string }
export type Filing = { form: string; filed: string; accession: string; url: string }
export type EdgarDaily = {
  symbol: string; day: string; cik: string | null; name: string | null
  float: { shares: number; filed: string; asOf: string; ageDays: number; splitFactor: number } | null; floatMiss: string | null
  filer: 'domestic' | 'foreign' | 'unknown'
  dilution: { flagged: boolean; filings: Filing[]; atm: Filing[] }
}

// ---------------- pure (tested) ----------------

/** companyconcept units -> one point per filing (share classes summed, the latest as-of date in each filing). Pure. */
export function sharePoints(units: unknown): SharePoint[] {
  if (!Array.isArray(units)) return []
  const byFiling = new Map<string, { filed: string; end: string; form: string; values: Map<string, number> }>()
  for (const u of units as Array<{ end?: string; val?: number; accn?: string; form?: string; filed?: string } | null>) {
    if (!u || !u.accn || !u.filed || !u.end || !(Number(u.val) > 0)) continue
    const row = byFiling.get(u.accn) ?? { filed: u.filed, end: u.end, form: u.form ?? '', values: new Map<string, number>() }
    if (u.end > row.end) { row.end = u.end; row.values.clear() }
    if (u.end === row.end) row.values.set(`${u.end}:${u.val}`, Number(u.val))
    byFiling.set(u.accn, row)
  }
  return [...byFiling].map(([accn, r]) => ({ accn, filed: r.filed, end: r.end, form: r.form, shares: [...r.values.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => a.filed.localeCompare(b.filed) || a.accn.localeCompare(b.accn))
}

/** The most current count FILED strictly before `day` (no look-ahead). Pure. */
export function pointBefore(points: SharePoint[], day: string): SharePoint | null {
  let pick: SharePoint | null = null
  for (const p of points) {
    if (p.filed >= day) break
    if (!pick || p.end > pick.end || (p.end === pick.end && p.filed >= pick.filed)) pick = p
  }
  return pick
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

const DILUTION_FORMS = /^(S-1|S-1\/A|F-1|F-1\/A|S-3|S-3\/A|F-3|F-3\/A|424B[1-8])$/
/** A4: S-1/F-1/S-3/F-3 (and amendments) or any 424B in the last 90 days. Pure. */
export function dilutionFilings(filings: Filing[], day: string, days = ASSISTANT.dilutionDays) {
  return filings.filter((f) => DILUTION_FORMS.test(f.form) && f.filed < day && daysBetween(f.filed, day) <= days)
}

/** Latest annual report form -> filer type (20-F / 40-F = foreign). Pure. */
export function filerType(filings: Filing[], day: string): EdgarDaily['filer'] {
  const annual = filings.filter((f) => /^(10-K|20-F|40-F)(\/A)?$/.test(f.form) && f.filed < day).sort((a, b) => b.filed.localeCompare(a.filed))[0]
  if (!annual) return 'unknown'
  return /^(20-F|40-F)/.test(annual.form) ? 'foreign' : 'domestic'
}

/** submissions JSON "recent" arrays -> filings. Pure. */
export function parseSubmissions(json: unknown, cik: string): Filing[] {
  const r = (json as { filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[]; primaryDocument?: string[] } } })?.filings?.recent
  if (!r?.form) return []
  return r.form.map((form, i) => {
    const accession = r.accessionNumber?.[i] ?? ''
    return { form, filed: r.filingDate?.[i] ?? '', accession, url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${r.primaryDocument?.[i] ?? ''}` }
  })
}

/** Shares at the count date -> shares today, across splits in between (raw/split-adjusted close ratios). Pure. */
export function splitFactor(ratioAtCount: number | null, ratioNow: number | null) {
  return ratioAtCount && ratioNow ? ratioAtCount / ratioNow : 1
}

// ---------------- network ----------------

function secHeaders() {
  const ua = process.env[ASSISTANT_ENV.secUserAgent]?.trim()
  if (!ua) throw new Error(`${ASSISTANT_ENV.secUserAgent} is not set ("Name email"); SEC requires it.`)
  return { 'User-Agent': ua, Accept: 'application/json' }
}

async function secJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { headers: secHeaders(), signal: AbortSignal.timeout(8_000), cache: 'no-store' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`SEC ${new URL(url).pathname} failed (${response.status})`)
  return await response.json() as T
}

let tickerMap: { day: string; map: Map<string, { cik: string; name: string }> } | null = null
async function cikFor(symbol: string, day: string) {
  if (!tickerMap || tickerMap.day !== day) {
    const json = await secJson<Record<string, { cik_str: number; ticker: string; title: string }>>('https://www.sec.gov/files/company_tickers.json')
    tickerMap = { day, map: new Map(Object.values(json ?? {}).map((r) => [r.ticker.toUpperCase().replace('-', '.'), { cik: String(r.cik_str).padStart(10, '0'), name: r.title }])) }
  }
  return tickerMap.map.get(symbol.toUpperCase()) ?? null
}

/** raw / split-adjusted daily close: the first bar on or after `start` ('first') or the last bar before `end` ('last'). */
async function closeRatio(symbol: string, start: string, pick: 'first' | 'last', end?: string) {
  const q = (adj: string) => `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}${end ? `&end=${end}` : ''}&limit=10&adjustment=${adj}&feed=sip`
  const [raw, split] = await Promise.all([marketData<{ bars?: Array<{ c: number }> }>(q('raw')), marketData<{ bars?: Array<{ c: number }> }>(q('split'))])
  const at = <T,>(v: T[] | undefined) => (pick === 'first' ? v?.[0] : v?.at(-1))
  const r = at(raw.bars)?.c, s = at(split.bars)?.c
  return r && s ? r / s : null
}

/** One symbol's EDGAR facts for an ET day (not cached here; the route caches the result). */
export async function edgarDaily(symbol: string, day: string): Promise<EdgarDaily> {
  const base: EdgarDaily = { symbol, day, cik: null, name: null, float: null, floatMiss: null, filer: 'unknown', dilution: { flagged: false, filings: [], atm: [] } }
  const company = await cikFor(symbol, day)
  if (!company) return { ...base, floatMiss: 'no CIK for this ticker' }
  const { cik, name } = company
  const submissions = await secJson<unknown>(`https://data.sec.gov/submissions/CIK${cik}.json`)
  const filings = parseSubmissions(submissions, cik)
  const filer = filerType(filings, day)
  const dil = dilutionFilings(filings, day)
  let atm: Filing[] = []
  try {
    const start = new Date(Date.parse(`${day}T00:00:00Z`) - ASSISTANT.atmDays * 86_400_000).toISOString().slice(0, 10)
    const hits = await secJson<{ hits?: { hits?: Array<{ _source?: { form?: string; file_date?: string; adsh?: string } }> } }>(`https://efts.sec.gov/LATEST/search-index?q=%22at-the-market%22&ciks=${cik}&dateRange=custom&startdt=${start}&enddt=${day}`)
    atm = (hits?.hits?.hits ?? []).map((h) => ({ form: h._source?.form ?? '', filed: h._source?.file_date ?? '', accession: h._source?.adsh ?? '', url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${(h._source?.adsh ?? '').replace(/-/g, '')}/` }))
      .filter((f) => f.filed < day && /^(424B5|8-K|S-3|S-3\/A|10-Q|10-K)$/.test(f.form))
  } catch { atm = [] }
  const out: EdgarDaily = { ...base, cik, name, filer, dilution: { flagged: dil.length > 0 || atm.length > 0, filings: dil.slice(0, 5), atm: atm.slice(0, 3) } }
  const concept = await secJson<{ units?: { shares?: unknown } }>(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/dei/EntityCommonStockSharesOutstanding.json`)
  const p = pointBefore(sharePoints(concept?.units?.shares), day)
  if (!p) return { ...out, floatMiss: concept ? 'no count filed before today' : 'no cover-page share count' }
  const ageDays = daysBetween(p.filed, day)
  if (ageDays > ASSISTANT.edgarMaxAgeDays) return { ...out, floatMiss: `stale (${ageDays} days)` }
  const weekAgo = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10)
  const factor = splitFactor(await closeRatio(symbol, p.end, 'first').catch(() => null), await closeRatio(symbol, weekAgo, 'last', day).catch(() => null))
  return { ...out, float: { shares: p.shares * factor, filed: p.filed, asOf: p.end, ageDays, splitFactor: factor } }
}
