// U1 - universe fix for delisted and renamed stocks (docs/backtest-known-issues.md, issue 1). BACKTEST ONLY.
//
//   npx tsx scripts/backtest/u1-delisted.ts --probe        counts only: FMP delisted commons, Alpaca bars, EDGAR CIKs
//
// What it does (opt-in: no existing script calls it, so locked runs and their caches are unchanged):
// - FMP's delisted list, common stocks only (preferreds, units, warrants, rights, funds dropped), delisted inside
//   the universe's history; each one not already in the universe is added under an internal key "TICKER@ASOF"
//   (ASOF = the day before FMP's delisting date) and fetched from Alpaca as the old ticker with `asof`, so a ticker
//   later reused by another company maps to the company that used it then. Entities with no Alpaca bars are counted.
// - FMP's symbol-change list: an old ticker used before its change date resolves to the new symbol (Alpaca keeps
//   a renamed company's history under the new symbol).
// - Each added entity's EDGAR company (CIK) by its old company name, from SEC's cik-lookup-data (every name an
//   EDGAR filer has used, former names included), not today's ticker map.
// SEC requests need SEC_USER_AGENT ("Name email"); FMP needs FMP_API_KEY; Alpaca needs ALPACA_API_KEY / SECRET.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchJson, getDailyBarsAsof, hashKey, readCache, registerAliases, writeCache, type Alias, type RawBar } from './data'
import { sec } from './rulebook/edgar-earnings'
import { buildUniverse, toEasternDay, type Universe } from './universe'
import { EJW } from './strategy-ej'

export type FmpDelisted = { symbol?: string; companyName?: string; exchange?: string; ipoDate?: string; delistedDate?: string }
export type FmpSymbolChange = { date?: string; companyName?: string; oldSymbol?: string; newSymbol?: string }
export type U1Entity = { key: string; ticker: string; asof: string; name: string; exchange: string; delistedDate: string; bars: number; firstBar: string | null; lastBar: string | null; cik: string | null; cikHow: string }
export type Rename = { old: string; new: string; date: string; name: string }

const LISTED = /^(NASDAQ|NYSE|AMEX|NYSE ?AMERICAN|NYSEAMERICAN|NYSE ?ARCA|BATS|CBOE)$/i

// ---------------- pure helpers (tested) ----------------

const NOT_COMMON_NAME = /\b(preferred|pref\.?|depositary shares? representing|units?|warrants?|rights?|notes?|debentures?|bonds?|funds?|municipal|tax-free|etf|etn|exchange[- ]traded|index|ishares|proshares|direxion|invesco|spdr|trust units|certificates?|% (senior|subordinated))\b|\d+(\.\d+)?\s?%/i
const NOT_COMMON_SYMBOL = /(?:[-.^](?:P|PR)[A-Z]?$|[-.]?(?:WS|WT|W|U|UN|R|RT)$|\+|\^|=)/
/** Common stock (not a preferred, unit, warrant, right, note or fund) by FMP symbol and name. Pure. */
export function isCommonStock(row: Pick<FmpDelisted, 'symbol' | 'companyName'>) {
  const symbol = (row.symbol ?? '').toUpperCase().trim()
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return false
  // Nasdaq 5th-letter codes that are not common stock: W warrant, U unit, R right, X mutual fund, M/N/O/P preferred,
  // G/H/I convertible, T with warrants, V when-issued, Z misc. Shorter symbols ending in those letters are normal.
  // (A/B class, D new issue after a reverse split, E delinquent, F foreign, Q bankruptcy, Y ADR stay: those are commons.)
  if (/^[A-Z]{4}[WURXMNOPGHITVZ]$/.test(symbol)) return false
  if (NOT_COMMON_SYMBOL.test(symbol) && /[-.]/.test(symbol)) return false
  return !NOT_COMMON_NAME.test(row.companyName ?? '')
}

/** FMP's class-share spelling ("CWEN-A") -> Alpaca's ("CWEN.A"); other symbols unchanged. Pure. */
export const alpacaTicker = (symbol: string) => symbol.toUpperCase().trim().replace(/^([A-Z]{1,5})-([A-Z])$/, '$1.$2')

/** The asof date for a delisted ticker: the calendar day before FMP's delisting date. Pure. */
export function asofFor(delistedDate: string) {
  return new Date(Date.parse(`${delistedDate.slice(0, 10)}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
}

const LEGAL = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC', 'LLC', 'LP', 'L', 'P', 'SA', 'NV', 'AG', 'SE', 'AB', 'ASA', 'SPA', 'BV', 'THE'])
/** Company name for matching across FMP and EDGAR: upper case, "/DE/"-style state tags and punctuation removed,
 *  legal-form words dropped ("Acme Therapeutics, Inc." and "ACME THERAPEUTICS INC /DE/" both -> "ACME THERAPEUTICS"). Pure. */
export function normalizeCompanyName(name: string) {
  const words = name.toUpperCase().replace(/\/[A-Z]{2,3}\/?/g, ' ').replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  while (words.length > 1 && LEGAL.has(words.at(-1)!)) words.pop()
  return words.filter((w, i) => !(i === 0 && w === 'THE')).join(' ')
}

/** One line of SEC cik-lookup-data.txt ("NAME:CIK:") -> [name, 10-digit CIK]; null when it is not that shape. Pure. */
export function parseCikLine(line: string): [string, string] | null {
  const m = /^(.*):(\d{1,10}):\s*$/.exec(line)
  return m ? [m[1], m[2].padStart(10, '0')] : null
}

/** Ross's ticker on `day` -> the universe key that traded under it then: the plain symbol if it has a bar that day,
 *  else an added delisted entity using that ticker until its asof date, else the new symbol of a rename after `day`. Pure. */
export function resolveTicker(ticker: string, day: string, hasBar: (key: string, day: string) => boolean, entities: U1Entity[], renames: Rename[]): { key: string | null; how: 'plain' | 'delisted' | 'rename' | 'missing' } {
  if (hasBar(ticker, day)) return { key: ticker, how: 'plain' }
  const e = entities.filter((x) => x.ticker === ticker && day <= x.asof && hasBar(x.key, day)).sort((a, b) => a.asof.localeCompare(b.asof))[0]
  if (e) return { key: e.key, how: 'delisted' }
  // follow rename chains (A -> B -> C) forward from the trade day
  let symbol = ticker, from = day
  for (let hop = 0; hop < 5; hop += 1) {
    const r = renames.filter((x) => x.old === symbol && x.date > from).sort((a, b) => a.date.localeCompare(b.date))[0]
    if (!r) break
    if (hasBar(r.new, day)) return { key: r.new, how: 'rename' }
    const ent = entities.find((x) => x.ticker === r.new && day <= x.asof && hasBar(x.key, day))
    if (ent) return { key: ent.key, how: 'rename' }
    symbol = r.new; from = r.date
  }
  return { key: null, how: 'missing' }
}

// ---------------- data ----------------

async function fmpPaged<T>(key: string, url: (page: number) => string, kind: string): Promise<T[] | null> {
  const hit = readCache<T[]>(key)
  if (hit) return hit
  const rows: T[] = []
  try {
    for (let page = 0; page < 1000; page += 1) {
      const batch = await fetchJson<T[]>(url(page), kind, 'fmp')
      if (!Array.isArray(batch) || !batch.length) break
      rows.push(...batch)
      if (batch.length < 100) break
    }
  } catch (error) {
    console.log(`[u1] ${kind} unavailable from FMP (${error instanceof Error ? error.message.slice(0, 120) : error})`)
    return null
  }
  writeCache(key, rows)
  return rows
}
const fmpKey = () => process.env.FMP_API_KEY?.trim() ?? ''
/** Same cache key as the E-J $3-10 universe check, so an existing download is reused. */
export const fmpDelisted = () => fmpPaged<FmpDelisted>('fmp/delisted-companies-all-v1', (p) => `https://financialmodelingprep.com/stable/delisted-companies?page=${p}&limit=100&apikey=${fmpKey()}`, 'fmp-delisted')
export async function fmpSymbolChanges() {
  const key = 'fmp/symbol-change-v1'
  const hit = readCache<FmpSymbolChange[]>(key)
  if (hit) return hit
  try {
    const rows = await fetchJson<FmpSymbolChange[]>(`https://financialmodelingprep.com/stable/symbol-change?limit=100000&apikey=${fmpKey()}`, 'fmp-symbol-change', 'fmp')
    writeCache(key, rows)
    return rows
  } catch (error) {
    console.log(`[u1] symbol changes unavailable from FMP (${error instanceof Error ? error.message.slice(0, 120) : error})`)
    return null
  }
}

/** SEC cik-lookup-data.txt (every name an EDGAR filer has used): name -> CIKs, kept only for `wanted` names. The
 *  file is large, so only the matches are cached (keyed by the wanted set). */
export async function cikByName(wanted: Set<string>): Promise<Map<string, string[]>> {
  const key = `sec/u1/cik-names-${hashKey([...wanted].sort())}`
  const hit = readCache<Record<string, string[]>>(key)
  if (hit) return new Map(Object.entries(hit))
  console.log(`[u1] downloading SEC cik-lookup-data.txt to match ${wanted.size} company names (one large file)...`)
  const text = await sec('https://www.sec.gov/Archives/edgar/cik-lookup-data.txt')
  if (!text) throw new Error('SEC cik-lookup-data.txt not found')
  const out = new Map<string, string[]>()
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    const parsed = parseCikLine(text.slice(start, end))
    start = end + 1
    if (!parsed) continue
    const norm = normalizeCompanyName(parsed[0])
    if (!wanted.has(norm)) continue
    const list = out.get(norm) ?? []
    if (!list.includes(parsed[1])) list.push(parsed[1])
    out.set(norm, list)
  }
  writeCache(key, Object.fromEntries(out))
  return out
}

/** Several CIKs share a name: keep the one(s) that filed within a year before the delisting date (SEC submissions). */
async function pickCik(ciks: string[], delistedDate: string): Promise<string[]> {
  const keep: string[] = []
  for (const cik of ciks) {
    const cacheKey = `sec/u1/filing-dates/${cik}`
    let dates = readCache<string[]>(cacheKey)
    if (!dates) {
      const text = await sec(`https://data.sec.gov/submissions/CIK${cik}.json`)
      const json = text ? (JSON.parse(text) as { filings?: { recent?: { filingDate?: string[] } } }) : null
      dates = json?.filings?.recent?.filingDate ?? []
      writeCache(cacheKey, dates)
    }
    const from = new Date(Date.parse(`${delistedDate}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10)
    if (dates.some((d) => d >= from && d <= delistedDate)) keep.push(cik)
  }
  return keep
}

export type U1Result = { entities: U1Entity[]; renames: Rename[]; stats: Record<string, number | string> }

/**
 * Adds the delisted entities and renames to `universe` (in place) and registers their Alpaca aliases.
 * `edgar` = also find each entity's CIK by its old name (SEC requests).
 */
export async function extendUniverse(universe: Universe, input: { historyStart: string; end: string }, opts: { edgar?: boolean } = {}): Promise<U1Result> {
  const stats: Record<string, number | string> = {}
  const bump = (k: string, n = 1) => { stats[k] = Number(stats[k] ?? 0) + n }
  const fmp = await fmpDelisted()
  if (!fmp) throw new Error('U1 needs FMP\'s delisted-companies list')
  const rows = fmp.filter((r) => r.symbol && r.delistedDate && r.delistedDate.slice(0, 10) >= input.historyStart && r.delistedDate.slice(0, 10) <= input.end && LISTED.test((r.exchange ?? '').trim()))
  stats['FMP delisted, listed exchange, inside the history'] = rows.length
  const seen = new Set<string>()
  const todo: Array<{ ticker: string; asof: string; name: string; exchange: string; delistedDate: string }> = []
  for (const r of rows) {
    // FMP writes share classes as "CWEN-A"; Alpaca uses "CWEN.A"
    const ticker = alpacaTicker(r.symbol!), d = r.delistedDate!.slice(0, 10)
    if (!isCommonStock(r)) { bump('dropped: preferred / unit / warrant / right / note / fund'); continue }
    const id = `${ticker}@${d}`
    if (seen.has(id)) { bump('dropped: duplicate row'); continue }
    seen.add(id)
    // already present: the universe has the same ticker trading in the 14 days before the delisting (same company)
    const near = (universe.daily.get(ticker) ?? []).some((x) => x.day < d && Date.parse(d) - Date.parse(x.day) <= 14 * 86_400_000)
    if (near) { bump('already in the universe under the same ticker'); continue }
    todo.push({ ticker, asof: asofFor(d), name: (r.companyName ?? '').trim(), exchange: (r.exchange ?? '').trim(), delistedDate: d })
  }
  stats['to add (common, not present)'] = todo.length

  // Alpaca daily bars under the old ticker, grouped by asof date; one retry 10 days earlier for empty results
  const byAsof = new Map<string, typeof todo>()
  for (const t of todo) byAsof.set(t.asof, [...(byAsof.get(t.asof) ?? []), t])
  const barsFor = new Map<string, RawBar[]>()
  let done = 0
  for (const [asof, list] of byAsof) {
    const got = await getDailyBarsAsof(list.map((t) => t.ticker), input.historyStart, input.end, asof)
    for (const t of list) barsFor.set(`${t.ticker}@${t.asof}`, got[t.ticker] ?? [])
    done += 1
    if (done % 200 === 0) console.log(`[u1]   daily bars: ${done}/${byAsof.size} asof dates`)
  }
  const retry = todo.filter((t) => !(barsFor.get(`${t.ticker}@${t.asof}`)?.length))
  const retryByAsof = new Map<string, typeof todo>()
  for (const t of retry) { const a = asofFor(new Date(Date.parse(`${t.delistedDate}T12:00:00Z`) - 9 * 86_400_000).toISOString().slice(0, 10)); retryByAsof.set(a, [...(retryByAsof.get(a) ?? []), { ...t, asof: a }]) }
  const moved = new Map<string, string>()
  for (const [asof, list] of retryByAsof) {
    const got = await getDailyBarsAsof(list.map((t) => t.ticker), input.historyStart, input.end, asof)
    for (const t of list) if (got[t.ticker]?.length) { moved.set(`${t.ticker}@${asofFor(t.delistedDate)}`, asof); barsFor.set(`${t.ticker}@${asof}`, got[t.ticker]) }
  }

  const entities: U1Entity[] = []
  for (const t of todo) {
    const asof = moved.get(`${t.ticker}@${t.asof}`) ?? t.asof
    const key = `${t.ticker}@${asof}`
    const bars = barsFor.get(key) ?? []
    entities.push({ key, ticker: t.ticker, asof, name: t.name, exchange: t.exchange, delistedDate: t.delistedDate, bars: bars.length,
      firstBar: bars.length ? toEasternDay(bars[0].t) : null, lastBar: bars.length ? toEasternDay(bars.at(-1)!.t) : null, cik: null, cikHow: 'not looked up' })
    if (!bars.length) { bump('no Alpaca daily bars under the old ticker'); continue }
    bump('added with Alpaca daily bars')
    universe.daily.set(key, bars.map((b) => ({ day: toEasternDay(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })))
    universe.names.set(key, t.name)
    universe.delisted.add(key)
    universe.symbols.push(key)
  }
  const added = entities.filter((e) => e.bars > 0)
  registerAliases(added.map((e) => [e.key, { ticker: e.ticker, asof: e.asof } as Alias]))
  universe.u1 = { entities: added }

  // renames inside the history
  const changes = (await fmpSymbolChanges()) ?? []
  const renames: Rename[] = changes.filter((c) => c.oldSymbol && c.newSymbol && c.date && c.date.slice(0, 10) >= input.historyStart && c.date.slice(0, 10) <= input.end)
    .map((c) => ({ old: c.oldSymbol!.toUpperCase(), new: c.newSymbol!.toUpperCase(), date: c.date!.slice(0, 10), name: c.companyName ?? '' }))
  stats['FMP symbol changes inside the history'] = renames.length
  universe.u1.renames = renames

  if (opts.edgar) {
    const wanted = new Set(added.map((e) => normalizeCompanyName(e.name)).filter(Boolean))
    const names = await cikByName(wanted)
    for (const e of added) {
      const norm = normalizeCompanyName(e.name)
      const ciks = names.get(norm) ?? []
      if (!norm) { e.cikHow = 'no company name'; bump('EDGAR: no company name') }
      else if (!ciks.length) { e.cikHow = 'no EDGAR name match'; bump('EDGAR: no name match') }
      else if (ciks.length === 1) { e.cik = ciks[0]; e.cikHow = 'unique name match'; bump('EDGAR: unique name match') }
      else {
        const keep = await pickCik(ciks, e.delistedDate)
        if (keep.length === 1) { e.cik = keep[0]; e.cikHow = `name shared by ${ciks.length} CIKs; the one filing in the year before delisting`; bump('EDGAR: shared name, resolved by filing dates') }
        else { e.cikHow = `ambiguous: ${ciks.length} CIKs share the name, ${keep.length} filed in the year before delisting`; bump('EDGAR: ambiguous') }
      }
    }
  }
  return { entities, renames, stats }
}

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true'] as const }))
  if (args.get('probe') !== 'true') throw new Error('Pass --probe (counts only; nothing else is built here)')
  for (const k of ['ALPACA_API_KEY', 'FMP_API_KEY', 'SEC_USER_AGENT']) if (!process.env[k]?.trim()) throw new Error(`Set ${k} in this window first.`)
  const t0 = Date.now()
  const out = join(process.cwd(), args.get('out') ?? 'backtests/u1')
  const historyStart = new Date(Date.parse(`${EJW.start}T00:00:00Z`) - EJW.historyLookbackDays * 86_400_000).toISOString().slice(0, 10)
  const universe = await buildUniverse({ historyStart, end: EJW.end, periodStart: EJW.start, simFrom: EJW.start, simTo: EJW.end })
  const before = universe.symbols.length
  console.log(`[u1] PROBE ${historyStart}..${EJW.end} (the E replay's history): ${before} symbols in today's universe`)
  const res = await extendUniverse(universe, { historyStart, end: EJW.end }, { edgar: true })
  console.log('\n[u1] ===== U1 PROBE (counts only) =====')
  for (const [k, v] of Object.entries(res.stats)) console.log(`[u1]   ${String(v).padStart(6)}  ${k}`)
  const added = res.entities.filter((e) => e.bars > 0)
  const inWindow = added.filter((e) => (e.lastBar ?? '') >= EJW.start)
  console.log(`[u1]   universe ${before} -> ${universe.symbols.length} symbols; ${inWindow.length} added entities trade on or after ${EJW.start}`)
  const byYear = new Map<string, number>()
  for (const e of added) byYear.set(e.delistedDate.slice(0, 4), (byYear.get(e.delistedDate.slice(0, 4)) ?? 0) + 1)
  console.log(`[u1]   added by delisting year: ${[...byYear].sort().map(([y, n]) => `${y} ${n}`).join(', ')}`)
  console.log(`[u1]   no Alpaca bars, first 20: ${res.entities.filter((e) => !e.bars).slice(0, 20).map((e) => `${e.ticker} (${e.delistedDate})`).join(', ') || 'none'}`)
  mkdirSync(out, { recursive: true })
  const q = (s: unknown) => { const t = s == null ? '' : String(s); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
  writeFileSync(join(out, 'entities.csv'), ['key,ticker,asof,name,exchange,delisted_date,daily_bars,first_bar,last_bar,cik,cik_how', ...res.entities.map((e) => [e.key, e.ticker, e.asof, e.name, e.exchange, e.delistedDate, e.bars, e.firstBar, e.lastBar, e.cik, e.cikHow].map(q).join(','))].join('\n') + '\n')
  writeFileSync(join(out, 'renames.csv'), ['old,new,date,name', ...res.renames.map((r) => [r.old, r.new, r.date, r.name].map(q).join(','))].join('\n') + '\n')
  writeFileSync(join(out, 'probe.json'), JSON.stringify({ ranAt: new Date().toISOString(), historyStart, end: EJW.end, before, after: universe.symbols.length, stats: res.stats }, null, 1))
  console.log(`[u1] wrote ${out}: entities.csv, renames.csv, probe.json. Done in ${((Date.now() - t0) / 60_000).toFixed(1)} min. Send this output to Claude.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error('[u1] failed', error); process.exitCode = 1 })
}
