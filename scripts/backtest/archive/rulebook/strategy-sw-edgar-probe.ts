// ARCHIVED Oct 25, 2026 (parked; FAIL or parked verdict in its spec). Kept for the record; not run by anything.
// Strategy SW: EDGAR earnings-date coverage probe - BACKTEST ONLY, no trades, no results.
//
//   $env:SEC_USER_AGENT="Your Name you@example.com"
//   npx tsx scripts/backtest/rulebook/strategy-sw-edgar-probe.ts
//
// For ~80 stocks (20 known delisted large caps, 30 active large caps, 30 random stocks with data):
//   - CIK found? (SEC ticker list, else FMP profile)
//   - earnings 8-Ks (Item 2.02) per full trading year 2016-2025: share of stock-years with >= 3 (a normal year has 4)
//   - report timing: before the open / after the close / during the session
//   - cross-check vs the FMP earnings calendar 2022+ (dates within 3 calendar days)
import { pathToFileURL } from 'node:url'
import { getAssets, getDailyBars, type RawBar } from '../../data'
import { toEasternDay } from '../../universe'
import { isCommonStock } from '../../rulebook/data'
import { cikFor, earningsFilings, edgarStats, type EarningsFiling } from '../../rulebook/edgar-earnings'
import { addDays } from '../../rulebook/runner'
import { KNOWN_DELISTED, seededSample, SW_PROBE } from './strategy-sw-probe'
import { loadEarnings } from './swing-v2'

export const ACTIVE_LARGE = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'JPM', 'XOM', 'UNH', 'JNJ', 'PG', 'HD', 'KO', 'PEP',
  'COST', 'WMT', 'BAC', 'CVX', 'MRK', 'ABBV', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'NFLX', 'AMD', 'INTC', 'CSCO', 'DIS'] as const

/** Share of EDGAR dates with an FMP date within `days` calendar days (and the reverse). Pure. */
export function matchRate(a: string[], b: string[], days = 3) {
  if (!a.length) return null
  const near = (x: string) => b.some((y) => Math.abs(Date.parse(x) - Date.parse(y)) <= days * 86_400_000)
  return a.filter(near).length / a.length
}

async function main() {
  const assets = await getAssets()
  const commons = [...new Set(assets.filter((a) => (!a.class || a.class === 'us_equity') && isCommonStock(a.symbol, a.name ?? '')).map((a) => a.symbol))].sort()
  const sample = seededSample(commons, SW_PROBE.sample, SW_PROBE.seed)
  const sampleBars = await getDailyBars(sample, SW_PROBE.start, SW_PROBE.end) // cached by the SW probe
  const randomWithData = seededSample(sample.filter((s) => ((sampleBars[s] ?? []) as RawBar[]).length > 200), 30, SW_PROBE.seed + 2)
  const groups: Array<[string, string[]]> = [['delisted large caps', [...KNOWN_DELISTED]], ['active large caps', [...ACTIVE_LARGE]], ['random stocks with data', randomWithData]]
  const symbols = groups.flatMap(([, list]) => list)
  const bars = { ...(await getDailyBars([...KNOWN_DELISTED], SW_PROBE.start, SW_PROBE.end)), ...(await getDailyBars([...ACTIVE_LARGE], SW_PROBE.start, SW_PROBE.end)), ...sampleBars }

  const filings = new Map<string, EarningsFiling[]>()
  const cikSource = { sec: 0, fmp: 0, none: 0 }
  for (const s of symbols) {
    const { cik, source } = await cikFor(s)
    cikSource[source] += 1
    filings.set(s, cik ? await earningsFilings(cik) : [])
  }
  console.log(`[edgar] ${symbols.length} stocks: CIK from SEC list ${cikSource.sec}, from FMP profile ${cikSource.fmp}, not found ${cikSource.none}; SEC requests ${edgarStats.secRequests}, FMP ${edgarStats.fmpRequests}`)

  const years = Array.from({ length: 10 }, (_, i) => 2016 + i)
  for (const [name, list] of groups) {
    const cells: string[] = []
    let good = 0
    let total = 0
    for (const y of years) {
      let n = 0
      let ok = 0
      for (const s of list) {
        const traded = ((bars[s] ?? []) as RawBar[]).filter((b) => toEasternDay(b.t).startsWith(String(y))).length
        if (traded < 200) continue // only full trading years
        n += 1
        if ((filings.get(s) ?? []).filter((f) => f.date.startsWith(String(y))).length >= 3) ok += 1
      }
      good += ok
      total += n
      cells.push(`${y} ${n ? `${ok}/${n}` : '-'}`)
    }
    console.log(`[edgar] ${name}: stock-years with >= 3 earnings 8-Ks: ${cells.join(', ')} -> ${total ? ((good / total) * 100).toFixed(0) : 'n/a'}% overall`)
  }
  const all = [...filings.values()].flat().filter((f) => f.date >= '2016-01-01')
  const t = { bmo: 0, amc: 0, intraday: 0 }
  for (const f of all) t[f.time] += 1
  console.log(`[edgar] timing of ${all.length} earnings 8-Ks since 2016: before the open ${t.bmo}, after the close ${t.amc}, during the session ${t.intraday}`)
  const missing = symbols.filter((s) => !(filings.get(s) ?? []).length)
  console.log(`[edgar] stocks with no earnings 8-K at all: ${missing.length} [${missing.join(', ')}]`)

  // FMP cross-check from 2022 (the plan's calendar starts there)
  const fmp = await loadEarnings('2022-01-03', addDays(SW_PROBE.end, -6))
  const ed: string[] = []
  const fm: string[] = []
  let rateSumE = 0, rateSumF = 0, rated = 0
  for (const s of symbols) {
    const e = (filings.get(s) ?? []).map((f) => f.date).filter((d) => d >= '2022-01-03')
    const f = (fmp.get(s) ?? []).map((x) => x.date).filter((d) => d <= SW_PROBE.end)
    if (!e.length || !f.length) continue
    ed.push(...e); fm.push(...f)
    rateSumE += matchRate(e, f) ?? 0
    rateSumF += matchRate(f, e) ?? 0
    rated += 1
  }
  console.log(`[edgar] FMP cross-check 2022+ (${rated} stocks with both): EDGAR dates with an FMP date within 3 days ${rated ? ((rateSumE / rated) * 100).toFixed(0) : 'n/a'}%, FMP dates with an EDGAR date within 3 days ${rated ? ((rateSumF / rated) * 100).toFixed(0) : 'n/a'}% (${ed.length} EDGAR, ${fm.length} FMP dates)`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[edgar] failed', error)
    process.exitCode = 1
  })
}
