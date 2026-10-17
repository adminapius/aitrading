// Dilution check - BACKTEST ONLY, diagnostic, NO TRADING RULES. Spec: docs/orderflow-step-a-spec.md (dilution section).
//
//   1) measure first:  npx tsx scripts/backtest/rulebook/dilution.ts --probe=8
//   2) then:           npx tsx scripts/backtest/rulebook/dilution.ts --all
//
// Needs SEC_USER_AGENT (SEC requires a name + contact email, e.g. "Your Name your@email") and FMP_API_KEY.
// For each Step 2b setup day: SEC EDGAR filings accepted before 7:00 ET that morning -> effective S-3 (exact),
// effective S-1 in the last 90 days (exact), 424B takedown in the last 30 days (exact), active ATM (approximate, from filing text). FMP filing lists cross-check.
// Only small flag results are cached (never full filing text).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readCache, writeCache } from '../data'
import { readStep2b } from './orderflow'
import { parseArgs } from './runner'

export const DIL = {
  cutoffMinute: 7 * 60, // a filing counts if accepted before 7:00 ET on the setup day
  takedownForms: ['424B1', '424B2', '424B4', '424B5', '424B7'],
  takedownDays: 30,
  shelfYears: 3,
  s1Days: 90, // effective S-1 in the last 90 days (Jose, Oct 16, 23:57 PT)
  atmLookbackDays: 730,
  secDelayMs: 130, // stays under the SEC's 10 requests per second
  minGroup: 30,
  minGapR: 0.5,
} as const

export type Filing = { form: string; filingDate: string; acceptance: string; accession: string; primaryDocument: string; fileNumber: string }

// How EDGAR's acceptanceDateTime is read: 'et' = already Eastern wall-clock time (the trailing Z ignored),
// 'utc' = real UTC, converted to Eastern. Set with --edgar-tz after checking a sample against the SEC's filing page.
let edgarTz: 'et' | 'utc' = 'et'
export function setEdgarTz(value: 'et' | 'utc') { edgarTz = value }
const etFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
function wallClock(value: string) {
  const plain = value.replace('T', ' ').replace(/\.\d+Z?$|Z$/, '').slice(0, 19)
  if (edgarTz === 'et' || !/Z$/.test(value)) return plain
  const parts = Object.fromEntries(etFormat.formatToParts(new Date(Date.parse(`${plain.replace(' ', 'T')}Z`))).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

/** Accepted before 7:00 ET on `day` (filings from earlier days always count). Pure. */
export function beforeCutoff(filing: Pick<Filing, 'filingDate' | 'acceptance'>, day: string) {
  const accepted = wallClock(filing.acceptance)
  const acceptedDay = accepted.slice(0, 10)
  if (acceptedDay < day) return true
  if (acceptedDay > day) return false
  const [h, m] = accepted.slice(11, 16).split(':').map(Number)
  return h * 60 + m < DIL.cutoffMinute
}
const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000

/** Exact flags from the filing list. Pure, used by the tests. */
export function exactFlags(filings: Filing[], day: string) {
  const known = filings.filter((f) => beforeCutoff(f, day))
  const effective = new Map<string, string>() // file number -> effective day
  for (const f of known) if (f.form === 'EFFECT' && f.fileNumber && !effective.has(f.fileNumber)) effective.set(f.fileNumber, wallClock(f.acceptance).slice(0, 10))
  const withdrawn = new Set(known.filter((f) => f.form === 'RW').map((f) => f.fileNumber))
  const shelves = known.filter((f) => (f.form === 'S-3' || f.form === 'S-3ASR') && f.fileNumber).map((f) => ({ fileNumber: f.fileNumber, effectiveDay: f.form === 'S-3ASR' ? wallClock(f.acceptance).slice(0, 10) : effective.get(f.fileNumber) ?? null }))
  const live = shelves.filter((s) => s.effectiveDay && !withdrawn.has(s.fileNumber) && daysBetween(s.effectiveDay, day) <= 365 * DIL.shelfYears)
  const recent = (f: Filing) => daysBetween(wallClock(f.acceptance).slice(0, 10), day) <= DIL.takedownDays
  const takedowns = known.filter((f) => (DIL.takedownForms as readonly string[]).includes(f.form) && recent(f))
  const resale424b3 = known.filter((f) => f.form === '424B3' && recent(f))
  // S-1 declared effective (EFFECT on its file number) within the last 90 days, not withdrawn
  const s1Live = known.filter((f) => f.form === 'S-1' && f.fileNumber && effective.has(f.fileNumber) && !withdrawn.has(f.fileNumber)
    && daysBetween(effective.get(f.fileNumber)!, day) <= DIL.s1Days)
  return { effectiveS1_90: s1Live.length > 0, effectiveS3: live.length > 0, shelfFileNumbers: live.map((s) => s.fileNumber), takedown30: takedowns.length > 0, takedownForms: takedowns.map((f) => f.form), resale424b3: resale424b3.length > 0 }
}

/** ATM text test on one filing's text. Pure. */
export function atmText(text: string) {
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&#8209;|&#8211;|&#8212;|&ndash;|&mdash;/gi, '-').replace(/\s+/g, ' ')
  const atm = /at[\s-]*the[\s-]*market/i.test(plain) && /(sales agreement|equity distribution agreement|distribution agreement|sales agent|ATM agreement|ATM program|ATM offering)/i.test(plain)
  const terminated = /terminat\w*[^.]{0,200}(sales agreement|equity distribution agreement|at[\s-]*the[\s-]*market)|(sales agreement|equity distribution agreement|at[\s-]*the[\s-]*market)[^.]{0,200}terminat/i.test(plain)
  return { atm, terminated }
}

// ---------------- network (SEC with a User-Agent, throttled; FMP) ----------------
let lastSec = 0
const stats = { secRequests: 0, secBytes: 0, fmpRequests: 0, docs: 0 }
async function sec(url: string) {
  const agent = process.env.SEC_USER_AGENT?.trim()
  if (!agent) throw new Error('Set SEC_USER_AGENT (your name and contact email; the SEC requires it), e.g. $env:SEC_USER_AGENT="Your Name you@example.com"')
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wait = lastSec + DIL.secDelayMs - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastSec = Date.now()
    stats.secRequests += 1
    try {
      const response = await fetch(url, { headers: { 'User-Agent': agent, 'Accept-Encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(60_000) })
      if (response.status === 404) return null
      if (response.status === 429 || response.status >= 500) throw new Error(`SEC ${response.status}`)
      if (!response.ok) throw new Error(`SEC HTTP ${response.status} for ${url}`)
      const text = await response.text()
      stats.secBytes += text.length
      return text
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SEC HTTP')) throw error
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt))
    }
  }
  throw new Error(`SEC request kept failing: ${url}`)
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

type FmpFiling = { cik?: string; formType: string; acceptedDate: string; filingDate: string; link?: string }
async function fmpFilings(symbol: string, from: string, to: string): Promise<FmpFiling[]> {
  const key = `sec/v1/fmp/${symbol}/${from}_${to}`
  const hit = readCache<FmpFiling[]>(key)
  if (hit) return hit
  const apiKey = process.env.FMP_API_KEY?.trim()
  if (!apiKey) throw new Error('FMP_API_KEY is required for the FMP cross-check')
  const out: FmpFiling[] = []
  for (let page = 0; page < 20; page += 1) {
    stats.fmpRequests += 1
    const response = await fetch(`https://financialmodelingprep.com/stable/sec-filings-search/symbol?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&page=${page}&limit=100&apikey=${apiKey}`, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) break
    const rows = (await response.json()) as FmpFiling[]
    if (!Array.isArray(rows) || !rows.length) break
    out.push(...rows)
    if (rows.length < 100) break
  }
  writeCache(key, out)
  return out
}

async function submissions(cik: string): Promise<Filing[]> {
  const key = `sec/v1/submissions/${cik}`
  const hit = readCache<Filing[]>(key)
  if (hit) return hit
  const text = await sec(`https://data.sec.gov/submissions/CIK${cik}.json`)
  if (!text) return []
  const json = JSON.parse(text) as { filings: { recent: Record<string, string[]>; files?: Array<{ name: string }> } }
  const blocks = [json.filings.recent]
  for (const file of json.filings.files ?? []) {
    const more = await sec(`https://data.sec.gov/submissions/${file.name}`)
    if (more) blocks.push(JSON.parse(more) as Record<string, string[]>)
  }
  const filings: Filing[] = []
  for (const b of blocks) for (let i = 0; i < (b.form?.length ?? 0); i += 1) {
    filings.push({ form: b.form[i], filingDate: b.filingDate[i], acceptance: b.acceptanceDateTime[i], accession: b.accessionNumber[i], primaryDocument: b.primaryDocument[i], fileNumber: b.fileNumber?.[i] ?? '' })
  }
  writeCache(key, filings)
  return filings
}

async function docFlags(cik: string, filing: Filing) {
  const key = `sec/v1/doc/${filing.accession}`
  const hit = readCache<{ atm: boolean; terminated: boolean; missing?: boolean }>(key)
  if (hit) return hit
  stats.docs += 1
  const text = await sec(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.accession.replace(/-/g, '')}/${filing.primaryDocument}`)
  const flags = text ? atmText(text) : { atm: false, terminated: false, missing: true }
  writeCache(key, flags)
  return flags
}

async function atmFlag(cik: string, filings: Filing[], day: string) {
  const known = filings.filter((f) => beforeCutoff(f, day) && daysBetween(wallClock(f.acceptance).slice(0, 10), day) <= DIL.atmLookbackDays)
  let lastAtm = ''
  let lastEnd = ''
  for (const f of known.filter((x) => x.form === '8-K' || x.form === '424B5')) {
    const flags = await docFlags(cik, f)
    const date = wallClock(f.acceptance)
    if (flags.atm && !flags.terminated && date > lastAtm) lastAtm = date
    if (f.form === '8-K' && flags.terminated && date > lastEnd) lastEnd = date
  }
  const tenQ = known.filter((x) => x.form === '10-Q').sort((a, b) => wallClock(b.acceptance).localeCompare(wallClock(a.acceptance)))[0]
  const q = tenQ ? await docFlags(cik, tenQ) : null
  const fromFilings = lastAtm !== '' && lastAtm > lastEnd
  const from10q = Boolean(q?.atm && !q.terminated && wallClock(tenQ!.acceptance) > lastEnd)
  return fromFilings || from10q
}

// ---------------- report ----------------
type Row = { day: string; symbol: string; r: number; mfe: number; cik: string | null; cikSource: string; s3: boolean; s1: boolean; takedown: boolean; b3: boolean; atm: boolean | null;
  fmpS3: boolean | null; fmpS1: boolean | null; fmpTakedown: boolean | null; fmpCik: string | null }

function groupLine(name: string, rows: Row[]) {
  if (!rows.length) return `${name.padEnd(5)}   0`
  const rs = rows.map((r) => r.r)
  const total = rs.reduce((a, b) => a + b, 0)
  return `${name.padEnd(5)} ${String(rows.length).padStart(3)}   avg R ${(total / rows.length).toFixed(2).padStart(6)}   win ${String(Math.round((100 * rs.filter((r) => r > 0).length) / rows.length)).padStart(3)}%   avg MFE ${(rows.reduce((a, r) => a + r.mfe, 0) / rows.length).toFixed(2).padStart(5)}   total ${total.toFixed(1).padStart(6)}R`
}

function flagReport(title: string, rows: Row[], pick: (row: Row) => boolean | null, judged: boolean) {
  const usable = rows.filter((row) => pick(row) != null)
  const yes = usable.filter((row) => pick(row) === true)
  const no = usable.filter((row) => pick(row) === false)
  console.log(`\n[dil] ${title}`)
  console.log(`      ${groupLine('yes', yes)}`)
  console.log(`      ${groupLine('no', no)}`)
  if (!judged) { console.log('      (information only, not judged)'); return }
  const avg = (list: Row[]) => list.reduce((a, r) => a + r.r, 0) / Math.max(1, list.length)
  const ok = yes.length >= DIL.minGroup && no.length >= DIL.minGroup && avg(no) > 0 && avg(no) - avg(yes) >= DIL.minGapR
  console.log(`      reading rule: "no" avg > 0 (${avg(no).toFixed(2)}R), "no" - "yes" >= ${DIL.minGapR}R (${(avg(no) - avg(yes)).toFixed(2)}R), both groups >= ${DIL.minGroup} (${yes.length}/${no.length}) -> ${ok ? 'EDGE' : 'no edge'}`)
}

async function main() {
  const args = parseArgs()
  const out = join(process.cwd(), args.get('out') ?? 'backtests/dilution')
  const probe = args.has('probe') ? Number(args.get('probe') === 'true' ? 8 : args.get('probe')) : 0
  if (!probe && args.get('all') !== 'true') throw new Error('Run --probe=8 first to measure the download, then --all.')
  const tzArg = args.get("edgar-tz")
  if (!probe && tzArg !== "et" && tzArg !== "utc") throw new Error('Pass --edgar-tz=et or --edgar-tz=utc (decided from the probe samples checked against the SEC filing page).')
  if (tzArg === "et" || tzArg === "utc") setEdgarTz(tzArg)
  const samples: string[] = []
  const setups = readStep2b(join(process.cwd(), 'backtests/sp-runner-v3/trades.csv'))
  const chosen = probe ? Array.from({ length: Math.min(probe, setups.length) }, (_, k) => setups[Math.floor((k * setups.length) / Math.min(probe, setups.length))]) : setups
  const tickers = await tickerMap()
  const started = Date.now()
  const rows: Row[] = []
  const tzChecks: number[] = []
  for (const [index, setup] of chosen.entries()) {
    const from = new Date(Date.parse(`${setup.day}T00:00:00Z`) - (365 * DIL.shelfYears + 30) * 86_400_000).toISOString().slice(0, 10)
    const fmp = await fmpFilings(setup.symbol, from, setup.day).catch(() => [] as FmpFiling[])
    const fmpCik = fmp.find((f) => f.cik)?.cik?.padStart(10, '0') ?? null
    const edgarCik = tickers[setup.symbol.toUpperCase()] ?? null
    const cik = fmpCik ?? edgarCik
    const row: Row = { day: setup.day, symbol: setup.symbol, r: setup.r, mfe: setup.mfe, cik, cikSource: fmpCik ? (edgarCik && edgarCik !== fmpCik ? 'fmp (edgar differs)' : 'fmp') : edgarCik ? 'edgar' : 'none',
      s3: false, s1: false, takedown: false, b3: false, atm: null, fmpS3: null, fmpS1: null, fmpTakedown: null, fmpCik }
    if (cik) {
      const filings = await submissions(cik)
      const flags = exactFlags(filings, setup.day)
      row.s3 = flags.effectiveS3
      row.s1 = flags.effectiveS1_90
      row.takedown = flags.takedown30
      row.b3 = flags.resale424b3
      row.atm = await atmFlag(cik, filings, setup.day)
      // timezone check: EDGAR acceptance (read as Eastern wall clock) vs FMP acceptedDate for the same filing
      const byAcc = new Map(filings.map((f) => [f.accession.replace(/-/g, ''), f]))
      for (const f of fmp) {
        const acc = f.link?.match(/\/(\d{18})\//)?.[1]
        const match = acc ? byAcc.get(acc) : undefined
        if (match && f.acceptedDate && samples.length < 4 && (match.form === '8-K' || match.form.startsWith('424B')) && match.acceptance.slice(0, 10) === f.acceptedDate.slice(0, 10))
          samples.push(`${match.form} ${setup.symbol}: EDGAR data "${match.acceptance}" | FMP "${f.acceptedDate}" | SEC page: ${f.link}`)
        if (match && f.acceptedDate) tzChecks.push((Date.parse(`${wallClock(match.acceptance).replace(' ', 'T')}Z`) - Date.parse(`${f.acceptedDate.replace(' ', 'T')}Z`)) / 3_600_000)
      }
    }
    if (fmp.length) {
      const asFilings: Filing[] = fmp.map((f) => ({ form: f.formType, filingDate: f.filingDate.slice(0, 10), acceptance: f.acceptedDate, accession: '', primaryDocument: '', fileNumber: '' }))
      const fmpFlags = exactFlags(asFilings, setup.day)
      row.fmpTakedown = fmpFlags.takedown30
      // FMP has no file numbers: an S-3 followed by an EFFECT notice within 120 days counts
      const known = asFilings.filter((f) => beforeCutoff(f, setup.day))
      row.fmpS1 = known.some((s) => s.form === 'S-1' && known.some((e) => e.form === 'EFFECT' && wallClock(e.acceptance) >= wallClock(s.acceptance) && daysBetween(wallClock(s.acceptance).slice(0, 10), wallClock(e.acceptance).slice(0, 10)) <= 180 && daysBetween(wallClock(e.acceptance).slice(0, 10), setup.day) <= DIL.s1Days))
      row.fmpS3 = known.some((s) => (s.form === 'S-3' || s.form === 'S-3ASR') && known.some((e) => e.form === 'EFFECT' && wallClock(e.acceptance) >= wallClock(s.acceptance) && daysBetween(wallClock(s.acceptance).slice(0, 10), wallClock(e.acceptance).slice(0, 10)) <= 120 && daysBetween(wallClock(e.acceptance).slice(0, 10), setup.day) <= 365 * DIL.shelfYears))
    }
    rows.push(row)
    if (probe || index % 10 === 0) console.log(`[dil] ${index + 1}/${chosen.length} ${setup.day} ${setup.symbol}: cik ${row.cikSource}, FMP filings ${fmp.length}, S-3 ${row.s3}, S-1 90d ${row.s1}, 424B 30d ${row.takedown}, ATM~ ${row.atm} · ${stats.secRequests} SEC requests, ${(stats.secBytes / 1e6).toFixed(0)} MB, ${((Date.now() - started) / 60000).toFixed(1)} min`)
  }
  const tz = tzChecks.length ? [...tzChecks].sort((a, b) => a - b)[Math.floor(tzChecks.length / 2)] : Number.NaN
  console.log(`[dil] time check: EDGAR vs FMP acceptance, median difference ${Number.isFinite(tz) ? tz.toFixed(1) : 'n/a'} h over ${tzChecks.length} matched filings (0 = both Eastern, as assumed)`)
  if (probe) {
    console.log('[dil] samples - open one SEC page link and read its "Accepted" time (the SEC page shows Eastern time):')
    for (const sample of samples) console.log(`      ${sample}`)
    console.log('[dil]   if "Accepted" equals the EDGAR data time -> --edgar-tz=et; if it is 4-5 hours earlier -> --edgar-tz=utc')
    const minutes = (Date.now() - started) / 60000
    console.log(`\n[dil] PROBE: ${chosen.length} setups, ${stats.secRequests} SEC requests (${stats.docs} documents), ${(stats.secBytes / 1e6).toFixed(0)} MB, ${stats.fmpRequests} FMP requests, ${minutes.toFixed(1)} min.`)
    console.log(`[dil] Estimate for all ${setups.length} setups: about ${Math.round((stats.secRequests * setups.length) / chosen.length)} SEC requests, ${((stats.secBytes * setups.length) / chosen.length / 1e9).toFixed(1)} GB, ${((minutes * setups.length) / chosen.length).toFixed(0)} min (less if a company repeats: its filings are cached). Disk: flags only, a few MB.`)
    return
  }
  const matched = rows.filter((r) => r.cik)
  console.log(`\n[dil] ===== DILUTION CHECK (information only) - ${rows.length} Step 2b setups, ${matched.length} matched to an SEC CIK =====`)
  console.log(`[dil] CIK source: ${JSON.stringify(rows.reduce((acc, r) => ({ ...acc, [r.cikSource]: (acc[r.cikSource] ?? 0) + 1 }), {} as Record<string, number>))}`)
  flagReport('Effective S-3 shelf (EXACT; company or resale registration)', matched, (r) => r.s3, true)
  flagReport('Effective S-1 in the last 90 days (EXACT)', matched, (r) => r.s1, true)
  flagReport('424B takedown (424B1/2/4/5/7) in the last 30 days (EXACT)', matched, (r) => r.takedown, true)
  flagReport('Any exact flag (S-3 effective OR S-1 effective 90d OR 424B takedown 30d)', matched, (r) => r.s3 || r.s1 || r.takedown, true)
  flagReport('424B3 in the last 30 days (resale prospectus, information only)', matched, (r) => r.b3, false)
  flagReport('Active ATM (APPROXIMATE, from filing text, information only)', matched, (r) => r.atm, false)
  const agree = (a: Array<boolean | null>, b: boolean[]) => { let n = 0; let same = 0; a.forEach((x, i) => { if (x != null) { n += 1; if (x === b[i]) same += 1 } }); return `${same}/${n}` }
  console.log(`\n[dil] FMP cross-check (setups with FMP filings): S-3 effective agrees ${agree(matched.map((r) => r.fmpS3), matched.map((r) => r.s3))}, S-1 90d agrees ${agree(matched.map((r) => r.fmpS1), matched.map((r) => r.s1))}, 424B 30d agrees ${agree(matched.map((r) => r.fmpTakedown), matched.map((r) => r.takedown))}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'dilution.csv'), ['date,ticker,cik,cik_source,r_2b,mfe_2b,effective_s3,effective_s1_90d,takedown_424b_30d,resale_424b3_30d,atm_approx,fmp_effective_s3,fmp_effective_s1_90d,fmp_takedown_30d',
    ...rows.map((r) => [r.day, r.symbol, r.cik ?? '', r.cikSource, r.r.toFixed(3), r.mfe.toFixed(2), r.s3, r.s1, r.takedown, r.b3, r.atm ?? '', r.fmpS3 ?? '', r.fmpS1 ?? '', r.fmpTakedown ?? ''].join(','))].join('\n') + '\n')
  console.log(`[dil] wrote ${join(out, 'dilution.csv')}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[dil] failed', error)
    process.exitCode = 1
  })
}
