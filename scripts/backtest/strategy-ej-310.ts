// Strategy E-J $3-10 - BACKTEST ONLY. Spec (LOCKED Oct 24, 2026): docs/strategy-ej-310-spec.md
//
//   $env:ALPACA_API_KEY / $env:ALPACA_API_SECRET / $env:FMP_API_KEY / $env:SEC_USER_AGENT="Your Name you@example.com"
//   $env:NODE_OPTIONS="--max-old-space-size=8192"
//   npx tsx scripts/backtest/strategy-ej-310.ts --probe        (EDGAR float coverage by year + minute-data size; no trades)
//
// The run modes (fresh window, info holdout, D12) are added after the probe confirms the window (spec D2).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scanConfig } from '../../lib/scan-config'
import { CLEAN_MOMENTUM_MIN_PRICE } from '../../lib/strategies/clean-momentum'
import { apiStats, CACHE_ROOT, getDailyBarsSplitAdjusted, hashKey } from './data'
import { daySymbolSets, loadDay, prefetchDay, setFifteenMinuteWindow } from './market'
import { buildUniverse, toEasternDay, type Universe } from './universe'
import { edgarStats } from './rulebook/edgar-earnings'
import { EDGAR_FLOAT, edgarFloatOn, loadEdgarFloat, type FilerType, type FloatMiss } from './edgar-float'

export const EJ310 = {
  fresh: ['2021-10-14', '2024-10-11'] as [string, string],
  infoHoldout: ['2026-08-01', '2026-10-16'] as [string, string],
  historyLookbackDays: 57,
  minEntryGain: 0.2, // E's clean-momentum floor: a stock-day E could enter has a day high at least +20%
  minEntryPrice: CLEAN_MOMENTUM_MIN_PRICE, // E's $3 floor (the scanner's own minimum is lower)
  coverageFloor: 0.9, // D2
  years: [['2021-10-14', '2022-10-13'], ['2022-10-14', '2023-10-13'], ['2023-10-14', '2024-10-11']] as Array<[string, string]>,
}

/** Stock-days E could enter on: day high >= +20% vs the prior close, high >= $3, volume >= the scanner minimum. Pure. */
export function enterableDays(universe: Pick<Universe, 'daily'>, from: string, to: string) {
  const out = new Map<string, string[]>()
  for (const [symbol, rows] of universe.daily) {
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i]
      if (row.day < from || row.day > to) continue
      const prev = rows[i - 1].c
      const peak = Math.max(row.o, row.h)
      if (!(prev > 0) || row.v < scanConfig.minVolume || peak < EJ310.minEntryPrice || peak / prev - 1 < EJ310.minEntryGain) continue
      out.set(symbol, [...(out.get(symbol) ?? []), row.day])
    }
  }
  return out
}

type Cell = { n: number; covered: number; under10m: number; miss: Partial<Record<FloatMiss, number>>; ages: number[]; sources: Record<string, number> }
const cell = (): Cell => ({ n: 0, covered: 0, under10m: 0, miss: {}, ages: [], sources: {} })
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a')
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const seg = (s: string) => { const c = s.replace(/[:*?"<>|]/g, '-'); return WINDOWS_RESERVED.test(c.split('.')[0]) ? `_${c}` : c }

async function probe(out: string) {
  const t0 = Date.now()
  const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`
  const [start, end] = EJ310.fresh
  const historyStart = new Date(Date.parse(`${start}T00:00:00Z`) - EJ310.historyLookbackDays * 86_400_000).toISOString().slice(0, 10)
  setFifteenMinuteWindow(historyStart, end)
  const universe = await buildUniverse({ historyStart, end, periodStart: start, simFrom: start, simTo: end })
  const days = universe.tradingDays.filter((d) => d >= start && d <= end)
  console.log(`[ej310] PROBE ${start} to ${end}: ${days.length} days, ${universe.symbols.length} symbols (${universe.delisted.size} delisted) (${mins()})`)

  // 1. EDGAR float for every symbol with a day E could enter on
  const enterable = enterableDays(universe, start, end)
  const symbols = [...enterable.keys()].sort()
  console.log(`[ej310] ${symbols.length} symbols / ${[...enterable.values()].reduce((s, d) => s + d.length, 0)} stock-days with a day high >= +20% and >= $3; loading EDGAR share counts (SEC, cached per company) ...`)
  const edgar = await loadEdgarFloat(symbols, universe.names, (done) => console.log(`[ej310]   EDGAR ${done}/${symbols.length} (${mins()}, SEC requests ${edgarStats.secRequests})`))
  const adjusted = await getDailyBarsSplitAdjusted(symbols, historyStart, end)
  const ratios = new Map(symbols.map((s) => {
    const raw = new Map((universe.daily.get(s) ?? []).map((r) => [r.day, r.c]))
    const adj = new Map((adjusted[s] ?? []).map((b) => [toEasternDay(b.t), b.c]))
    return [s, { raw, adjusted: adj, days: [...raw.keys()].filter((d) => adj.has(d)).sort() }]
  }))
  console.log(`[ej310] EDGAR loaded (${mins()}; SEC ${edgarStats.secRequests}, FMP ${edgarStats.fmpRequests})`)

  // 2. coverage by year x filer type x live/delisted
  const table = new Map<string, Cell>()
  const add = (key: string, r: ReturnType<typeof edgarFloatOn>) => {
    const c = table.get(key) ?? cell()
    c.n += 1
    if ('shares' in r) { c.covered += 1; if (r.shares <= 10_000_000) c.under10m += 1; c.ages.push(r.ageDays); c.sources[r.source] = (c.sources[r.source] ?? 0) + 1 } else c.miss[r.miss] = (c.miss[r.miss] ?? 0) + 1
    table.set(key, c)
  }
  for (const [symbol, list] of enterable) for (const day of list) {
    const year = EJ310.years.findIndex(([a, b]) => day >= a && day <= b)
    if (year < 0) continue
    const r = edgarFloatOn(edgar.get(symbol), day, ratios.get(symbol))
    const status = universe.delisted.has(symbol) ? 'delisted' : 'live'
    for (const key of [`${year}|all|all`, `${year}|${r.filer}|all`, `${year}|all|${status}`, `${year}|${r.filer}|${status}`, `all|all|all`, `all|${r.filer}|all`]) add(key, r)
  }
  const filers: Array<FilerType | 'all'> = ['all', 'domestic', 'foreign', 'unknown']
  const label = (y: string) => (y === 'all' ? 'all 3 years' : `${EJ310.years[Number(y)][0]}..${EJ310.years[Number(y)][1]}`)
  console.log(`\n[ej310] ===== EDGAR FLOAT COVERAGE (stock-days E could enter on; value filed before the day, <= ${EDGAR_FLOAT.maxAgeDays} days old) =====`)
  console.log('[ej310] year                      filer      stock-days  covered   live covered  delisted covered  <=10M of covered  median age  missing (reason: count)')
  const stops: string[] = []
  for (const y of ['0', '1', '2', 'all']) for (const f of filers) {
    const c = table.get(`${y}|${f}|all`)
    if (!c) continue
    const live = table.get(`${y}|${f}|live`) ?? cell(), dead = table.get(`${y}|${f}|delisted`) ?? cell()
    console.log(`[ej310] ${label(y).padEnd(25)} ${f.padEnd(9)} ${String(c.n).padStart(10)}  ${pct(c.covered, c.n).padStart(7)}   ${`${pct(live.covered, live.n)} of ${live.n}`.padStart(14)}  ${`${pct(dead.covered, dead.n)} of ${dead.n}`.padStart(16)}  ${pct(c.under10m, c.covered).padStart(16)}  ${String(median(c.ages) ?? 'n/a').padStart(9)}d  ${Object.entries(c.miss).map(([k, v]) => `${k}: ${v}`).join(', ')}`)
    if (y !== 'all' && f === 'all' && c.covered / c.n < EJ310.coverageFloor) stops.push(`${label(y)} ${pct(c.covered, c.n)}`)
  }
  const all = table.get('all|all|all') ?? cell()
  console.log(`[ej310] value sources (covered stock-days): ${Object.entries(all.sources).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  console.log('[ej310] foreign filers: annual 20-F / 40-F cover values only (6-K has no XBRL share count), up to the age cap; no value -> excluded and counted above.')

  // 3. minute-data size (same as the E-J probe), with the EDGAR float in place
  universe.floatOverride = (symbol, day) => { const r = edgarFloatOn(edgar.get(symbol), day, ratios.get(symbol)); return 'shares' in r ? r.shares : undefined }
  let symbolDays = 0, batches = 0, cached = 0
  for (const d of days) {
    const { pool, entryCandidates } = daySymbolSets(universe, d)
    const list = [...new Set([...pool, ...entryCandidates])].sort()
    symbolDays += list.length
    for (let i = 0; i < list.length; i += 100) { batches += 1; if (existsSync(join(CACHE_ROOT, 'minute', seg(d), `${hashKey(list.slice(i, i + 100))}.json.gz`))) cached += 1 }
  }
  console.log(`\n[ej310] minute data: ${symbolDays} symbol-days (gainer pools + EDGAR float <= 10M candidates), ${batches} day-batches, ${cached} already cached`)
  const pick = [0, 1, 2].map((k) => days[Math.round((k * (days.length - 1)) / 2)])
  const r0 = apiStats.alpaca, s0 = Date.now()
  for (const d of pick) { await prefetchDay(universe, d); await loadDay(universe, d) }
  const req = apiStats.alpaca - r0, sec = (Date.now() - s0) / 1000
  console.log(`[ej310] sample ${pick.join(', ')}: ${req} Alpaca requests in ${sec.toFixed(0)}s`)
  console.log(`[ej310] FULL ESTIMATE: about ${Math.round((req / 3) * days.length)} requests, about ${(((sec / 3) * days.length) / 3600).toFixed(1)} h (outside 06:45-16:05 ET on weekdays), plus quote look-ups at decisions; reruns are cache hits`)

  mkdirSync(join(out, 'probe'), { recursive: true })
  writeFileSync(join(out, 'probe', 'coverage.json'), JSON.stringify({ ranAt: new Date().toISOString(), window: EJ310.fresh, maxAgeDays: EDGAR_FLOAT.maxAgeDays, table: Object.fromEntries([...table].map(([k, c]) => [k, { ...c, ages: undefined, medianAgeDays: median(c.ages) }])), minute: { symbolDays, batches, cached, sampleRequests: req, sampleSeconds: sec } }, null, 1))
  console.log(`[ej310] wrote ${join(out, 'probe', 'coverage.json')} (the probe is not a locked run; it can be rerun)`)
  if (stops.length) console.log(`\n[ej310] STOP (spec D2): coverage under 90% in ${stops.join('; ')}. Send this output to Claude; nothing gets run until Jose decides.`)
  else console.log('\n[ej310] D2 check: every year has at least 90% coverage. Send this output to Claude to record it in the spec.')
  console.log(`[ej310] done in ${mins()}`)
}

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true'] as const }))
  for (const k of ['ALPACA_API_KEY', 'FMP_API_KEY', 'SEC_USER_AGENT']) if (!process.env[k]?.trim()) throw new Error(`Set ${k} in this window first.`)
  const out = join(process.cwd(), args.get('out') ?? 'backtests/strategy-ej-310')
  if (args.get('probe') === 'true') return probe(out)
  throw new Error('Only --probe is built so far. The run modes are added after the probe confirms the window (spec D2).')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error('[ej310] failed', error); process.exitCode = 1 })
}
