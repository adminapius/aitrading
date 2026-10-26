// ARCHIVED Oct 25, 2026 (parked; FAIL or parked verdict in its spec). Kept for the record; not run by anything.
// Strategy SW data prefetch - BACKTEST ONLY. Downloads and caches every input the SW backtest will need.
// No strategy logic, no trades, no results: the spec is not locked yet. Safe to run overnight; reruns are cache hits.
//
//   $env:ALPACA_API_KEY / $env:ALPACA_API_SECRET / $env:FMP_API_KEY / $env:SEC_USER_AGENT="Your Name you@example.com"
//   $env:NODE_OPTIONS="--max-old-space-size=8192"
//   npx tsx scripts/backtest/rulebook/strategy-sw-prefetch.ts
//
// Steps:
//   1. Raw daily bars 2016-01-01..2026-10-16 for every common stock in Alpaca's asset list (active + delisted) and SPY.
//   2. Point-in-time universe per day (spec section 1): prior raw close > $10, 50-day average volume > 1M shares,
//      top 500 by 50-day average dollar volume. Prints how many stocks ever qualify, per year, and how many delisted.
//   3. Split-adjusted daily bars for every stock that ever qualifies (indicators).
//   4. For those stocks: CIK, every SEC 8-K with Item 2.02 (earnings dates), FMP profile (current / last-known sector).
//   5. FMP earnings calendar 2022+ (cross-check).
//   6. Coverage report: earnings 8-Ks per universe stock-year, report timing, sector coverage, FMP agreement.
import { pathToFileURL } from 'node:url'
import { apiStats, getAssets, getDailyBars, getDailyBarsSplitAdjusted, type RawBar } from '../../data'
import { toEasternDay } from '../../universe'
import { isCommonStock } from '../../rulebook/data'
import { cikFor, earningsFilings, edgarStats, fmpProfile, type EarningsFiling } from '../../rulebook/edgar-earnings'
import { matchRate } from './strategy-sw-edgar-probe'
import { loadEarnings } from './swing-v2'

export const SWP = { start: '2016-01-01', end: '2026-10-16', minPrice: 10, minAvgVolume: 1_000_000, top: 500, avgDays: 50 } as const

type Row = { day: string; c: number; v: number }

/** Point-in-time members per day: prior close > $10, prior 50-day avg volume > 1M, top N by prior 50-day avg $ volume. Pure. */
export function universeMembers(daily: Map<string, Row[]>, days: string[], opts: { minPrice: number; minAvgVolume: number; top: number; avgDays: number } = SWP) {
  const prevDay = new Map(days.map((d, i) => [d, i > 0 ? days[i - 1] : '']))
  const daySet = new Set(days)
  const cand = new Map<string, Array<{ s: string; dv: number }>>()
  for (const [s, rows] of daily) {
    let vol = 0
    let dv = 0
    for (let i = 0; i < rows.length; i += 1) {
      if (i >= opts.avgDays) {
        const d = rows[i].day
        if (daySet.has(d) && rows[i - 1].day === prevDay.get(d) && rows[i - 1].c > opts.minPrice && vol / opts.avgDays > opts.minAvgVolume) {
          const list = cand.get(d) ?? []
          list.push({ s, dv: dv / opts.avgDays })
          cand.set(d, list)
        }
        vol -= rows[i - opts.avgDays].v
        dv -= rows[i - opts.avgDays].c * rows[i - opts.avgDays].v
      }
      vol += rows[i].v
      dv += rows[i].c * rows[i].v
    }
  }
  const out = new Map<string, string[]>()
  for (const d of days) out.set(d, (cand.get(d) ?? []).sort((a, b) => b.dv - a.dv).slice(0, opts.top).map((x) => x.s))
  return out
}

const mins = (t0: number) => `${((Date.now() - t0) / 60_000).toFixed(1)} min`

async function main() {
  const t0 = Date.now()
  for (const name of ['ALPACA_API_KEY', 'FMP_API_KEY', 'SEC_USER_AGENT']) if (!process.env[name]?.trim()) throw new Error(`Set ${name} in this window first.`)
  const assets = await getAssets()
  const status = new Map<string, boolean>()
  for (const a of assets) {
    if (a.class && a.class !== 'us_equity') continue
    if (!isCommonStock(a.symbol, a.name ?? '')) continue
    if (!status.has(a.symbol)) status.set(a.symbol, a.status === 'active')
  }
  const commons = [...status.keys()].sort()
  console.log(`[sw-prefetch] step 1: raw daily bars for ${commons.length} common stocks + SPY, ${SWP.start} to ${SWP.end}`)
  const raw = await getDailyBars(['SPY', ...commons], SWP.start, SWP.end)
  const spyDays = ((raw.SPY ?? []) as RawBar[]).map((b) => toEasternDay(b.t))
  const daily = new Map<string, Row[]>()
  let rawBars = 0
  for (const s of commons) {
    const list = (raw[s] ?? []) as RawBar[]
    if (!list.length) continue
    rawBars += list.length
    daily.set(s, list.map((b) => ({ day: toEasternDay(b.t), c: b.c, v: b.v })))
  }
  for (const k of Object.keys(raw)) delete raw[k]
  console.log(`[sw-prefetch] raw done (${mins(t0)}): ${daily.size} stocks with data, ${(rawBars / 1e6).toFixed(1)}M bars, ${spyDays.length} SPY days; Alpaca requests ${apiStats.alpaca} (cached ${apiStats.alpacaCached})`)

  console.log('[sw-prefetch] step 2: point-in-time universe (>$10, 50-day avg volume > 1M, top 500 by 50-day avg dollar volume)')
  const members = universeMembers(daily, spyDays)
  const ever = new Set<string>()
  const byYear = new Map<string, Set<string>>()
  for (const [d, list] of members) for (const s of list) { ever.add(s); const y = d.slice(0, 4); if (!byYear.has(y)) byYear.set(y, new Set()); byYear.get(y)!.add(s) }
  const everList = [...ever].sort()
  const delistedEver = everList.filter((s) => !status.get(s)).length
  const sizes = [...members.values()].map((l) => l.length)
  console.log(`[sw-prefetch] ${everList.length} stocks are in the universe on at least one day (${delistedEver} now delisted); daily size min ${Math.min(...sizes)}, max ${Math.max(...sizes)}`)
  console.log(`[sw-prefetch] distinct members by year: ${[...byYear].sort().map(([y, set]) => `${y} ${set.size}`).join(', ')}`)
  const yearsOf = new Map<string, Set<string>>()
  for (const [y, set] of byYear) for (const s of set) { if (!yearsOf.has(s)) yearsOf.set(s, new Set()); yearsOf.get(s)!.add(y) }
  const tradedDays = new Map<string, Map<string, number>>()
  for (const s of everList) {
    const m = new Map<string, number>()
    for (const r of daily.get(s) ?? []) m.set(r.day.slice(0, 4), (m.get(r.day.slice(0, 4)) ?? 0) + 1)
    tradedDays.set(s, m)
  }
  daily.clear()

  console.log(`[sw-prefetch] step 3: split-adjusted daily bars for the ${everList.length} universe stocks + SPY`)
  for (let i = 0; i < everList.length; i += 1000) {
    const adj = await getDailyBarsSplitAdjusted(i === 0 ? ['SPY', ...everList.slice(i, i + 1000)] : everList.slice(i, i + 1000), SWP.start, SWP.end)
    for (const k of Object.keys(adj)) delete adj[k]
    console.log(`      ${Math.min(i + 1000, everList.length)} / ${everList.length} (${mins(t0)})`)
  }

  console.log(`[sw-prefetch] step 4: SEC earnings 8-Ks (Item 2.02) and FMP profiles for ${everList.length} stocks`)
  const filings = new Map<string, EarningsFiling[]>()
  const cikSource = { sec: 0, fmp: 0, none: 0 }
  let withSector = 0
  const sectors = new Map<string, number>()
  for (const [n, s] of everList.entries()) {
    const { cik, source } = await cikFor(s)
    cikSource[source] += 1
    filings.set(s, cik ? await earningsFilings(cik) : [])
    const p = await fmpProfile(s)
    if (p?.sector) { withSector += 1; sectors.set(p.sector, (sectors.get(p.sector) ?? 0) + 1) }
    if ((n + 1) % 250 === 0) console.log(`      ${n + 1} / ${everList.length} (${mins(t0)}; SEC requests ${edgarStats.secRequests}, FMP ${edgarStats.fmpRequests})`)
  }

  console.log('[sw-prefetch] step 5: FMP earnings calendar 2022+ (cross-check)')
  const fmp = await loadEarnings('2022-01-03', '2026-10-12')

  console.log(`\n[sw-prefetch] ===== COVERAGE REPORT (${mins(t0)}) =====`)
  console.log(`[sw-prefetch] CIK: SEC list ${cikSource.sec}, FMP profile ${cikSource.fmp}, not found ${cikSource.none} [${everList.filter((s) => !(filings.get(s) ?? []).length).slice(0, 25).join(', ')}${cikSource.none > 25 ? ', ...' : ''}]`)
  const cells: string[] = []
  let good = 0
  let total = 0
  for (let y = 2016; y <= 2026; y += 1) {
    const ys = String(y)
    const need = y === 2026 ? 2 : 3 // 2026 is a partial year (to Oct 16)
    let n = 0
    let ok = 0
    for (const s of everList) {
      if (!yearsOf.get(s)?.has(ys)) continue
      if ((tradedDays.get(s)?.get(ys) ?? 0) < (y === 2026 ? 150 : 200)) continue // full trading years only
      n += 1
      if ((filings.get(s) ?? []).filter((f) => f.date.startsWith(ys)).length >= need) ok += 1
    }
    good += ok
    total += n
    cells.push(`${y} ${n ? `${((ok / n) * 100).toFixed(0)}% of ${n}` : '-'}`)
  }
  console.log(`[sw-prefetch] universe stock-years with a normal count of earnings 8-Ks (>= 3; >= 2 for 2026): ${cells.join(', ')} -> ${total ? ((good / total) * 100).toFixed(0) : 'n/a'}% overall`)
  const all = [...filings.values()].flat().filter((f) => f.date >= SWP.start)
  const t = { bmo: 0, amc: 0, intraday: 0 }
  for (const f of all) t[f.time] += 1
  console.log(`[sw-prefetch] timing of ${all.length} earnings 8-Ks: before the open ${t.bmo} (${((t.bmo / Math.max(1, all.length)) * 100).toFixed(0)}%), after the close ${t.amc} (${((t.amc / Math.max(1, all.length)) * 100).toFixed(0)}%), during the session ${t.intraday} (${((t.intraday / Math.max(1, all.length)) * 100).toFixed(0)}%)`)
  console.log(`[sw-prefetch] sector (FMP, current / last known): ${withSector} of ${everList.length}; ${[...sectors].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  let rated = 0, se = 0, sf = 0
  for (const s of everList) {
    const e = (filings.get(s) ?? []).map((f) => f.date).filter((d) => d >= '2022-01-03' && d <= '2026-10-12')
    const f = (fmp.get(s) ?? []).map((x) => x.date).filter((d) => d <= '2026-10-12')
    if (!e.length || !f.length) continue
    rated += 1
    se += matchRate(e, f) ?? 0
    sf += matchRate(f, e) ?? 0
  }
  console.log(`[sw-prefetch] FMP cross-check 2022+ (${rated} stocks with both): EDGAR dates with an FMP date within 3 days ${rated ? ((se / rated) * 100).toFixed(0) : 'n/a'}%, FMP dates with an EDGAR date within 3 days ${rated ? ((sf / rated) * 100).toFixed(0) : 'n/a'}%`)
  console.log(`[sw-prefetch] requests: Alpaca ${apiStats.alpaca} (cached ${apiStats.alpacaCached}), SEC ${edgarStats.secRequests}, FMP profiles ${edgarStats.fmpRequests}. Done in ${mins(t0)}. Everything is cached for the SW backtest.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[sw-prefetch] failed', error)
    process.exitCode = 1
  })
}
