// Strategy SW (swing) data probe - BACKTEST ONLY. Data size and coverage facts, no trades, no results.
//
//   npx tsx scripts/backtest/rulebook/strategy-sw-probe.ts                (default sample of 150 stocks)
//   npx tsx scripts/backtest/rulebook/strategy-sw-probe.ts --sample=300
//
// Reports, before any SW code exists:
//   1. Alpaca history depth: SPY's first daily bar, common stocks in the asset list (active and delisted).
//   2. A random sample of common stocks (active + delisted): raw and split-adjusted daily bars 2016-01-01 to
//      2026-10-16, requests, time, bars; extrapolated to every common stock (requests, hours, GB, memory).
//   3. Coverage by year in the sample (how many symbols have bars each year) and delisted symbols with data,
//      plus long gaps inside a symbol's history (possible ticker reuse).
//   4. FMP earnings calendar depth: one week in 2016, 2019, 2022 and 2025 (rows, share with a report time).
//   5. FMP sector coverage for part of the sample (sector is current/last known, not point in time).
import { pathToFileURL } from 'node:url'
import { apiStats, fetchJson, getAssets, getDailyBars, getDailyBarsSplitAdjusted, type RawBar } from '../data'
import { toEasternDay } from '../universe'
import { isCommonStock } from './data'
import { addDays, parseArgs } from './runner'
import { loadEarnings } from './swing-v2'

export const SW_PROBE = { start: '2016-01-01', end: '2026-10-16', sample: 150, sectorSample: 40, seed: 20261023 } as const

// Small deterministic PRNG so the sample is the same on every run.
export function seededSample<T>(items: T[], n: number, seed: number) {
  let s = seed >>> 0
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]] }
  return copy.slice(0, Math.min(n, copy.length))
}

async function main() {
  const args = parseArgs()
  const n = Number(args.get('sample') ?? SW_PROBE.sample)
  const assets = await getAssets()
  const commons = new Map<string, { active: boolean }>()
  for (const a of assets) {
    if (a.class && a.class !== 'us_equity') continue
    if (!isCommonStock(a.symbol, a.name ?? '')) continue
    if (!commons.has(a.symbol)) commons.set(a.symbol, { active: a.status === 'active' })
  }
  const all = [...commons.keys()].sort()
  const inactive = all.filter((s) => !commons.get(s)!.active)
  console.log(`[sw-probe] Alpaca asset list: ${all.length} common-stock symbols (${all.length - inactive.length} active, ${inactive.length} delisted/inactive)`)

  const spy = (await getDailyBars(['SPY'], SW_PROBE.start, SW_PROBE.end)).SPY as RawBar[] | undefined
  const spyDays = (spy ?? []).map((b) => toEasternDay(b.t))
  console.log(`[sw-probe] SPY daily bars: ${spyDays.length}, first ${spyDays[0] ?? 'none'}, last ${spyDays[spyDays.length - 1] ?? 'none'}`)

  const sample = seededSample(all, n, SW_PROBE.seed)
  const r0 = apiStats.alpaca
  const t0 = Date.now()
  const raw = await getDailyBars(sample, SW_PROBE.start, SW_PROBE.end)
  const rawReq = apiStats.alpaca - r0
  const rawSec = (Date.now() - t0) / 1000
  const r1 = apiStats.alpaca
  const t1 = Date.now()
  const adj = await getDailyBarsSplitAdjusted(sample, SW_PROBE.start, SW_PROBE.end)
  const adjReq = apiStats.alpaca - r1
  const adjSec = (Date.now() - t1) / 1000
  const bars = (rec: Record<string, RawBar[]>) => Object.values(rec).reduce((s, list) => s + (list?.length ?? 0), 0)
  const rawBars = bars(raw as Record<string, RawBar[]>)
  const adjBars = bars(adj as Record<string, RawBar[]>)
  const withData = sample.filter((s) => (raw[s] ?? []).length > 0)
  const inactiveSample = sample.filter((s) => !commons.get(s)!.active)
  const inactiveWithData = inactiveSample.filter((s) => (raw[s] ?? []).length > 0)
  console.log(`\n[sw-probe] sample: ${sample.length} symbols (${inactiveSample.length} delisted), ${withData.length} with any daily bars (${inactiveWithData.length} of the delisted)`)
  console.log(`[sw-probe] raw daily: ${rawBars} bars, ${rawReq} requests (0 if cached), ${rawSec.toFixed(0)}s; split-adjusted: ${adjBars} bars, ${adjReq} requests, ${adjSec.toFixed(0)}s`)

  // Coverage by year
  const years = Array.from({ length: 11 }, (_, i) => 2016 + i)
  const perYear = years.map((y) => sample.filter((s) => (raw[s] ?? []).some((b) => toEasternDay(b.t).startsWith(String(y)))).length)
  console.log(`[sw-probe] sample symbols with bars by year: ${years.map((y, i) => `${y} ${perYear[i]}`).join(', ')}`)
  const firstBars = withData.map((s) => toEasternDay(raw[s][0].t)).sort()
  const startsAt2016 = firstBars.filter((d) => d < '2016-02-01').length
  console.log(`[sw-probe] first bar: ${startsAt2016} of ${withData.length} start in Jan 2016 (history begins there); median first bar ${firstBars[Math.floor(firstBars.length / 2)] ?? 'n/a'}`)
  const dayIndex = new Map(spyDays.map((d, i) => [d, i]))
  let gapped = 0
  for (const s of withData) {
    const idx = (raw[s] as RawBar[]).map((b) => dayIndex.get(toEasternDay(b.t))).filter((i): i is number => i != null)
    for (let k = 1; k < idx.length; k += 1) if (idx[k] - idx[k - 1] > 60) { gapped += 1; break }
  }
  console.log(`[sw-probe] symbols with a gap of more than 60 trading days inside their history (possible ticker reuse or long halt): ${gapped} of ${withData.length}`)

  // Extrapolate to every common stock
  const scale = all.length / Math.max(1, sample.length)
  const perReqBars = rawReq ? rawBars / rawReq : 10_000
  const fullBars = (rawBars + adjBars) * scale
  const fullReq = Math.ceil(fullBars / Math.max(1, perReqBars))
  const secPerReq = rawReq + adjReq ? (rawSec + adjSec) / (rawReq + adjReq) : 0.5
  console.log(`[sw-probe] FULL ESTIMATE (all ${all.length} symbols, raw + split-adjusted): about ${(fullBars / 1e6).toFixed(1)}M bars, ${fullReq} requests, ${((fullReq * secPerReq) / 3600).toFixed(1)} h (outside 06:45-16:05 ET), about ${((fullBars * 45) / 1024 ** 3).toFixed(2)} GB gzipped JSON on disk, about ${((fullBars * 80) / 1024 ** 3).toFixed(1)} GB if all held in memory at once (the build processes it in chunks)`)

  // Earnings depth
  console.log('\n[sw-probe] FMP earnings calendar, one week per year:')
  for (const week of ['2016-03-07', '2019-03-04', '2022-03-07', '2025-03-03']) {
    let rows = 0
    let timed = 0
    await loadEarnings(week, week, (r, t) => { rows += r; timed += t })
    console.log(`      week of ${week}: ${rows} rows, report time known ${rows ? ((timed / rows) * 100).toFixed(0) : 'n/a'}%`)
  }
  const weeks = Math.ceil((Date.parse(SW_PROBE.end) - Date.parse(SW_PROBE.start)) / (7 * 86_400_000))
  console.log(`      full range ${SW_PROBE.start} to ${SW_PROBE.end}: about ${weeks} weekly requests (cached after the first run)`)

  // Sector coverage
  const apiKey = process.env.FMP_API_KEY?.trim()
  if (!apiKey) { console.log('[sw-probe] FMP_API_KEY not set: sector check skipped'); return }
  const sectorSample = seededSample(withData, SW_PROBE.sectorSample, SW_PROBE.seed + 1)
  let hasSector = 0
  let inactiveHas = 0
  let inactiveN = 0
  const sectors = new Map<string, number>()
  for (const s of sectorSample) {
    const active = commons.get(s)!.active
    if (!active) inactiveN += 1
    try {
      const rows = await fetchJson<Array<{ sector?: string | null }>>(`https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(s)}&apikey=${apiKey}`, 'fmp-profile', 'fmp')
      const sector = rows?.[0]?.sector?.trim()
      if (sector) { hasSector += 1; if (!active) inactiveHas += 1; sectors.set(sector, (sectors.get(sector) ?? 0) + 1) }
    } catch { /* counted as missing */ }
  }
  console.log(`\n[sw-probe] FMP sector (current/last known, not point in time): ${hasSector} of ${sectorSample.length} have one (${inactiveHas} of ${inactiveN} delisted); sectors seen: ${[...sectors].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  console.log(`[sw-probe] a full sector load would be about ${all.length} profile requests (or one bulk file), cached`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[sw-probe] failed', error)
    process.exitCode = 1
  })
}
