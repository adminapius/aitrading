// Earnings report dates from SEC EDGAR: 8-K filings with Item 2.02 ("Results of Operations and Financial Condition").
// BACKTEST ONLY. Dates are ACTUAL report dates, not pre-announced ones -> tagged [approximate] wherever used.
// Needs SEC_USER_AGENT (name + contact email, SEC rule). FMP_API_KEY only to find the CIK of delisted tickers.
// acceptanceDateTime is real UTC (confirmed in the dilution check: exactly 4.0 h vs FMP Eastern), converted to Eastern.
import { readCache, writeCache } from '../data'

export type EarningsFiling = { date: string; time: 'bmo' | 'amc' | 'intraday'; acceptedEt: string; accession: string }

const SEC_DELAY_MS = 120 // under the SEC's 10 requests/second
let lastSec = 0
export const edgarStats = { secRequests: 0, fmpRequests: 0 }

async function sec(url: string) {
  const agent = process.env.SEC_USER_AGENT?.trim()
  if (!agent) throw new Error('Set SEC_USER_AGENT (your name and contact email; the SEC requires it), e.g. $env:SEC_USER_AGENT="Your Name you@example.com"')
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wait = lastSec + SEC_DELAY_MS - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastSec = Date.now()
    edgarStats.secRequests += 1
    try {
      const response = await fetch(url, { headers: { 'User-Agent': agent, 'Accept-Encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(60_000) })
      if (response.status === 404) return null
      if (response.status === 429 || response.status >= 500) throw new Error(`SEC ${response.status}`)
      if (!response.ok) throw new Error(`SEC HTTP ${response.status} for ${url}`)
      return await response.text()
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SEC HTTP')) throw error
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt))
    }
  }
  throw new Error(`SEC request kept failing: ${url}`)
}

const etFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** EDGAR acceptance (UTC, e.g. "2024-05-01T20:05:12.000Z") -> Eastern date and before-open / after-close / intraday. Pure. */
export function classifyAcceptance(acceptance: string): { date: string; time: EarningsFiling['time']; acceptedEt: string } {
  const iso = /Z$/.test(acceptance) ? acceptance : `${acceptance.replace(' ', 'T')}Z`
  const parts = Object.fromEntries(etFormat.formatToParts(new Date(Date.parse(iso))).map((p) => [p.type, p.value]))
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const minute = Number(parts.hour) * 60 + Number(parts.minute)
  const time = minute < 9 * 60 + 30 ? 'bmo' : minute >= 16 * 60 ? 'amc' : 'intraday'
  return { date, time, acceptedEt: `${date} ${parts.hour}:${parts.minute}` }
}

/** 8-K (not 8-K/A) whose items include 2.02. Pure. */
export function isEarnings8K(form: string, items: string | undefined) {
  return form === '8-K' && (items ?? '').split(',').map((s) => s.trim()).includes('2.02')
}

async function tickerMap(): Promise<Record<string, string>> {
  const hit = readCache<Record<string, string>>('sec/v1/company_tickers')
  if (hit) return hit
  const raw = JSON.parse((await sec('https://www.sec.gov/files/company_tickers.json')) ?? '{}') as Record<string, { cik_str: number; ticker: string }>
  const map: Record<string, string> = {}
  for (const row of Object.values(raw)) map[row.ticker.toUpperCase()] = String(row.cik_str).padStart(10, '0')
  writeCache('sec/v1/company_tickers', map)
  return map
}

/** CIK for a ticker: SEC's current ticker list first, then FMP's company profile (covers most delisted tickers). */
/** FMP company profile (CIK and current / last-known sector), cached per symbol. */
export async function fmpProfile(symbol: string): Promise<{ cik: string | null; sector: string | null } | null> {
  const key = `fmp/profile/v2/${symbol}`
  const hit = readCache<{ cik: string | null; sector: string | null } | null>(key)
  if (hit !== undefined) return hit
  const apiKey = process.env.FMP_API_KEY?.trim()
  if (!apiKey) throw new Error('FMP_API_KEY is required for FMP company profiles')
  edgarStats.fmpRequests += 1
  const response = await fetch(`https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`, { signal: AbortSignal.timeout(60_000) })
  const rows = response.ok ? ((await response.json()) as Array<{ cik?: string | null; sector?: string | null }>) : []
  const row = rows?.[0] ? { cik: rows[0].cik ? String(rows[0].cik).replace(/\D/g, '').padStart(10, '0') : null, sector: rows[0].sector?.trim() || null } : null
  if (response.ok) writeCache(key, row) // a failed request is retried next run, not cached as "no profile"
  return row
}

/** CIK for a ticker: SEC's current ticker list first, then FMP's company profile (covers most delisted tickers). */
export async function cikFor(symbol: string): Promise<{ cik: string | null; source: 'sec' | 'fmp' | 'none' }> {
  const map = await tickerMap()
  if (map[symbol]) return { cik: map[symbol], source: 'sec' }
  const cik = (await fmpProfile(symbol))?.cik ?? null
  return { cik, source: cik ? 'fmp' : 'none' }
}

/** Every earnings 8-K (Item 2.02) a company filed, oldest first. Cached per CIK. */
export async function earningsFilings(cik: string): Promise<EarningsFiling[]> {
  const key = `sec/v2/earnings8k/${cik}`
  const hit = readCache<EarningsFiling[]>(key)
  if (hit) return hit
  const text = await sec(`https://data.sec.gov/submissions/CIK${cik}.json`)
  if (!text) { writeCache(key, []); return [] }
  const json = JSON.parse(text) as { filings: { recent: Record<string, string[]>; files?: Array<{ name: string }> } }
  const blocks: Array<Record<string, string[]>> = [json.filings.recent]
  for (const file of json.filings.files ?? []) {
    const more = await sec(`https://data.sec.gov/submissions/${file.name}`)
    if (more) blocks.push(JSON.parse(more) as Record<string, string[]>)
  }
  const out: EarningsFiling[] = []
  for (const b of blocks) for (let i = 0; i < (b.form?.length ?? 0); i += 1) {
    if (!isEarnings8K(b.form[i], b.items?.[i])) continue
    const c = classifyAcceptance(b.acceptanceDateTime[i])
    out.push({ ...c, accession: b.accessionNumber[i] })
  }
  out.sort((x, y) => x.acceptedEt.localeCompare(y.acceptedEt))
  writeCache(key, out)
  return out
}

// ---------------- v3: earnings dates + annual-report forms (foreign-filer check, D11) + full FMP profile ----------------

export type AnnualForm = { form: '10-K' | '20-F' | '40-F'; date: string }
export type SecCompany = { earnings: EarningsFiling[]; annual: AnnualForm[] }

/** Annual-report form family of an EDGAR form type, or null (amendments included). Pure. */
export function annualFamily(form: string): AnnualForm['form'] | null {
  const f = form.toUpperCase()
  if (/^10-K(405|T)?(\/A)?$/.test(f)) return '10-K'
  if (/^20-F(\/A)?$/.test(f)) return '20-F'
  if (/^40-F(\/A)?$/.test(f)) return '40-F'
  return null
}

/** Foreign filer on `day`: the latest annual report filed before the day is a 20-F or 40-F; if none yet, the first one decides. Pure. */
export function isForeignFiler(annual: AnnualForm[], day: string) {
  if (!annual.length) return false
  let pick: AnnualForm | null = null
  for (const a of annual) if (a.date < day) pick = a
  return (pick ?? annual[0]).form !== '10-K'
}

/** Earnings 8-Ks and annual-report forms for a company, oldest first. Cached per CIK. */
export async function secCompany(cik: string): Promise<SecCompany> {
  const key = `sec/v3/company/${cik}`
  const hit = readCache<SecCompany>(key)
  if (hit) return hit
  const text = await sec(`https://data.sec.gov/submissions/CIK${cik}.json`)
  if (!text) { const empty = { earnings: [], annual: [] }; writeCache(key, empty); return empty }
  const json = JSON.parse(text) as { filings: { recent: Record<string, string[]>; files?: Array<{ name: string }> } }
  const blocks: Array<Record<string, string[]>> = [json.filings.recent]
  for (const file of json.filings.files ?? []) {
    const more = await sec(`https://data.sec.gov/submissions/${file.name}`)
    if (more) blocks.push(JSON.parse(more) as Record<string, string[]>)
  }
  const earnings: EarningsFiling[] = []
  const annual: AnnualForm[] = []
  for (const b of blocks) for (let i = 0; i < (b.form?.length ?? 0); i += 1) {
    const fam = annualFamily(b.form[i])
    if (fam) annual.push({ form: fam, date: b.filingDate[i] })
    if (!isEarnings8K(b.form[i], b.items?.[i])) continue
    earnings.push({ ...classifyAcceptance(b.acceptanceDateTime[i]), accession: b.accessionNumber[i] })
  }
  earnings.sort((x, y) => x.acceptedEt.localeCompare(y.acceptedEt))
  annual.sort((x, y) => x.date.localeCompare(y.date))
  const out = { earnings, annual }
  writeCache(key, out)
  return out
}

export type FmpProfile3 = { cik: string | null; sector: string | null; isAdr: boolean; country: string | null }

/** FMP company profile with the ADR flag and country, cached per symbol. */
export async function fmpProfile3(symbol: string): Promise<FmpProfile3 | null> {
  const key = `fmp/profile/v3/${symbol}`
  const hit = readCache<FmpProfile3 | null>(key)
  if (hit !== undefined) return hit
  const apiKey = process.env.FMP_API_KEY?.trim()
  if (!apiKey) throw new Error('FMP_API_KEY is required for FMP company profiles')
  edgarStats.fmpRequests += 1
  const response = await fetch(`https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`, { signal: AbortSignal.timeout(60_000) })
  const rows = response.ok ? ((await response.json()) as Array<{ cik?: string | null; sector?: string | null; isAdr?: boolean | null; country?: string | null }>) : []
  const r = rows?.[0]
  const row: FmpProfile3 | null = r ? { cik: r.cik ? String(r.cik).replace(/\D/g, '').padStart(10, '0') : null, sector: r.sector?.trim() || null, isAdr: r.isAdr === true, country: r.country?.trim() || null } : null
  if (response.ok) writeCache(key, row)
  return row
}

/** CIK: SEC's current ticker list first, then the FMP profile. */
export async function cikFor3(symbol: string, profile: FmpProfile3 | null): Promise<string | null> {
  const map = await tickerMap()
  return map[symbol] ?? profile?.cik ?? null
}
