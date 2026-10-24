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
export async function cikFor(symbol: string): Promise<{ cik: string | null; source: 'sec' | 'fmp' | 'none' }> {
  const map = await tickerMap()
  if (map[symbol]) return { cik: map[symbol], source: 'sec' }
  const key = `fmp/profile/v1/${symbol}`
  let row = readCache<{ cik?: string | null } | null>(key)
  if (row === undefined) {
    const apiKey = process.env.FMP_API_KEY?.trim()
    if (!apiKey) throw new Error('FMP_API_KEY is required to find the CIK of delisted tickers')
    edgarStats.fmpRequests += 1
    const response = await fetch(`https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`, { signal: AbortSignal.timeout(60_000) })
    const rows = response.ok ? ((await response.json()) as Array<{ cik?: string | null }>) : []
    row = rows?.[0] ? { cik: rows[0].cik ?? null } : null
    writeCache(key, row)
  }
  const cik = row?.cik ? String(row.cik).replace(/\D/g, '').padStart(10, '0') : null
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
