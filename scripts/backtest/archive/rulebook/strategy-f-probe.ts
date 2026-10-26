// ARCHIVED Oct 25, 2026 (parked; FAIL or parked verdict in its spec). Kept for the record; not run by anything.
// Strategy F data probe - BACKTEST ONLY. Data size and cost facts, no trades, no results.
//
//   npx tsx scripts/backtest/rulebook/strategy-f-probe.ts                 (counts + a 6-day sample download)
//   npx tsx scripts/backtest/rulebook/strategy-f-probe.ts --sample-days=0 (counts only, no minute downloads)
//
// What it reports:
//   1. Universe: top 100 common stocks above $10 by 20-day average dollar volume, decided each morning (point in time),
//      plus SPY/QQQ, over Oct 14, 2024 - Oct 16, 2026. Unique symbols, symbol-days, how many are already cached.
//   2. Download estimate (1-minute SIP bars 4:00-16:00, cached per symbol-day), measured on a few sample days.
//   3. Opening-range facts on the sample days only (no outcomes): OR size vs price and vs daily ATR(14),
//      the F-A stop distance, how often the $2,000 / no-leverage cash cap limits a 1%-risk position,
//      and what the 0.05% stop slippage costs in R.
//   4. Shortable / easy-to-borrow flags as Alpaca shows them TODAY (no history exists).
//   5. SP penny-gapper line: candidate symbol-days and how many minute files are already cached.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apiStats, CACHE_ROOT, fetchJson, getDailyBars, getDailyBarsSplitAdjusted, type RawBar } from '../../data'
import { toEasternDay, type DailyRow } from '../../universe'
import { RULEBOOK } from '../../rulebook/config'
import { getDayBars, isCommonStock, loadReference, minuteOfDay, strategySPCandidates } from '../../rulebook/data'
import { atr, type Bar } from '../../rulebook/indicators'
import { addDays, parseArgs } from '../../rulebook/runner'

export const F_PROBE = {
  holdoutEnd: '2026-10-16',
  top: 100,
  minPrice: 10,
  advDays: 20,
  atrDays: 14,
  index: ['SPY', 'QQQ'],
  orStart: 9 * 60 + 30,
  orEnd: 9 * 60 + 44, // last 1-minute bar of the opening range
  minOrToAtr: 0.25,
  targetFraction: 0.382,
  equity: 2000,
  risk: 0.01,
  slippage: 0.0005,
} as const

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const segment = (s: string) => { const c = s.replace(/[:*?"<>|]/g, '-'); return WINDOWS_RESERVED.test(c.split('.')[0]) ? `_${c}` : c }
const minutePath = (day: string, symbol: string) => join(CACHE_ROOT, 'rulebook', 'm1', day, `${segment(symbol)}.json.gz`)

const pct = (values: number[], p: number) => {
  if (!values.length) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]
}
const spread = (values: number[], digits = 2, scale = 1) => values.length
  ? `p25 ${(pct(values, 0.25) * scale).toFixed(digits)}, median ${(pct(values, 0.5) * scale).toFixed(digits)}, p75 ${(pct(values, 0.75) * scale).toFixed(digits)} (n=${values.length})`
  : 'n/a'

// Point-in-time top-N by prior 20-day average dollar volume (raw close x volume), prior close above $10, common stock only.
export function topByDollarVolume(daily: Map<string, DailyRow[]>, names: Map<string, string>, days: string[], top: number) {
  const prevDay = new Map(days.map((day, i) => [day, i > 0 ? days[i - 1] : '']))
  const daySet = new Set(days)
  const candidates = new Map<string, Array<{ symbol: string; adv: number }>>()
  for (const [symbol, rows] of daily) {
    if (F_PROBE.index.includes(symbol as 'SPY')) continue
    if (!isCommonStock(symbol, names.get(symbol) ?? '')) continue
    let sum = 0
    for (let i = 0; i < rows.length; i += 1) {
      if (i >= F_PROBE.advDays) {
        const day = rows[i].day
        if (daySet.has(day) && rows[i - 1].day === prevDay.get(day) && rows[i - 1].c > F_PROBE.minPrice) {
          const list = candidates.get(day) ?? []
          list.push({ symbol, adv: sum / F_PROBE.advDays })
          candidates.set(day, list)
        }
        sum -= rows[i - F_PROBE.advDays].c * rows[i - F_PROBE.advDays].v
      }
      sum += rows[i].c * rows[i].v
    }
  }
  const out = new Map<string, string[]>()
  for (const day of days) out.set(day, (candidates.get(day) ?? []).sort((a, b) => b.adv - a.adv).slice(0, top).map((x) => x.symbol))
  return out
}

async function main() {
  const args = parseArgs()
  const sampleDays = Number(args.get('sample-days') ?? 6)
  const P = RULEBOOK.period
  const ref = await loadReference(addDays(P.start, -420), P.start, P.end) // cached from earlier runs
  const symbols = ref.universe.symbols

  // Oct 14-16, 2026 are past the cached reference period: one small daily download for every symbol.
  const before = apiStats.alpaca
  const extra = await getDailyBars(symbols, addDays(P.end, 1), F_PROBE.holdoutEnd)
  for (const [symbol, bars] of Object.entries(extra)) {
    const rows = ref.universe.daily.get(symbol) ?? []
    const last = rows.length ? rows[rows.length - 1].day : ''
    for (const bar of bars as RawBar[]) {
      const day = toEasternDay(bar.t)
      if (day > last) rows.push({ day, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v })
    }
    ref.universe.daily.set(symbol, rows)
  }
  const extraRequests = apiStats.alpaca - before
  const allDays = (ref.universe.daily.get('SPY') ?? []).map((row) => row.day)
  const days = allDays.filter((day) => day >= P.start && day <= F_PROBE.holdoutEnd)
  const tuning = days.filter((day) => day <= P.tuningEnd).length
  const holdout = days.filter((day) => day >= P.holdoutStart).length
  console.log(`[f-probe] days: ${days.length} (tuning ${tuning}, holdout ${holdout} to ${F_PROBE.holdoutEnd}); extra daily download Oct 14-16: ${extraRequests} requests`)

  // 1. Universe
  const members = topByDollarVolume(ref.universe.daily, ref.universe.names, allDays, F_PROBE.top)
  const unique = new Set<string>()
  let symbolDays = 0
  let cachedDays = 0
  let turnover = 0
  let prev: Set<string> | null = null
  let shortDays = 0
  for (const day of days) {
    const list = [...(members.get(day) ?? []), ...F_PROBE.index]
    if ((members.get(day) ?? []).length < F_PROBE.top) shortDays += 1
    for (const symbol of list) {
      unique.add(symbol)
      symbolDays += 1
      if (existsSync(minutePath(day, symbol))) cachedDays += 1
    }
    const now = new Set(members.get(day) ?? [])
    if (prev) turnover += [...now].filter((s) => !prev!.has(s)).length
    prev = now
  }
  console.log(`[f-probe] universe: ${unique.size} unique symbols (incl. SPY/QQQ), ${symbolDays} symbol-days, ${cachedDays} already cached (${((cachedDays / symbolDays) * 100).toFixed(1)}%), avg ${(turnover / Math.max(1, days.length - 1)).toFixed(1)} names change per day, ${shortDays} days with fewer than ${F_PROBE.top} names`)
  const first = members.get(days[0]) ?? []
  const last = members.get(days[days.length - 1]) ?? []
  console.log(`[f-probe] first day ${days[0]} top 10: ${first.slice(0, 10).join(', ')}`)
  console.log(`[f-probe] last day ${days[days.length - 1]} top 10: ${last.slice(0, 10).join(', ')}`)

  // 5. SP penny-gapper line (cached reference period only)
  let spDays = 0
  let spCached = 0
  for (const day of days.filter((d) => d <= P.end)) {
    for (const c of strategySPCandidates(ref, day)) {
      spDays += 1
      if (existsSync(minutePath(day, c.symbol))) spCached += 1
    }
  }
  console.log(`[f-probe] SP penny-gapper line: ${spDays} candidate symbol-days to ${P.end}, ${spCached} cached (${spDays ? ((spCached / spDays) * 100).toFixed(1) : 'n/a'}%); Oct 14-16 not counted (no reference stats)`)

  // 4. Shortable / easy to borrow, as of today
  try {
    const base = (process.env.ALPACA_BASE_URL?.trim() || 'https://paper-api.alpaca.markets').replace(/\/+$/, '').replace(/\/v2$/, '')
    const assets = await fetchJson<Array<{ symbol: string; shortable?: boolean; easy_to_borrow?: boolean }>>(`${base}/v2/assets?status=active&asset_class=us_equity`, 'assets-shortable')
    const flags = new Map(assets.map((a) => [a.symbol, a]))
    const active = [...unique].filter((s) => flags.has(s))
    const notShortable = active.filter((s) => !flags.get(s)!.shortable)
    const htb = active.filter((s) => flags.get(s)!.shortable && !flags.get(s)!.easy_to_borrow)
    console.log(`[f-probe] shortable TODAY (Alpaca has no history): ${active.length} of ${unique.size} still active; not shortable ${notShortable.length} [${notShortable.slice(0, 15).join(', ')}]; hard to borrow ${htb.length} [${htb.slice(0, 15).join(', ')}]`)
  } catch (error) {
    console.log(`[f-probe] shortable check failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (sampleDays <= 0) return
  // 2 + 3. Sample download and opening-range facts
  const sample = Array.from({ length: sampleDays }, (_, i) => days[Math.round((i * (days.length - 1)) / Math.max(1, sampleDays - 1))])
  let sampleRequests = 0
  let sampleSeconds = 0
  let sampleMissing = 0
  let sampleBytes = 0
  let sampleFiles = 0
  const stock = { rangePct: [] as number[], toAtr: [] as number[], stopPct: [] as number[], effRisk: [] as number[], costR: [] as number[], pass: 0, n: 0, capped: 0, noBars: 0 }
  const index = { rangePct: [] as number[], toAtr: [] as number[], stopPct: [] as number[], effRisk: [] as number[], costR: [] as number[], pass: 0, n: 0, capped: 0, noBars: 0 }
  for (const day of sample) {
    const list = [...(members.get(day) ?? []), ...F_PROBE.index]
    sampleMissing += list.filter((s) => !existsSync(minutePath(day, s))).length
    const r0 = apiStats.alpaca
    const t0 = Date.now()
    const bars = await getDayBars(day, list)
    sampleRequests += apiStats.alpaca - r0
    sampleSeconds += (Date.now() - t0) / 1000
    for (const s of list) if (existsSync(minutePath(day, s))) { sampleBytes += statSync(minutePath(day, s)).size; sampleFiles += 1 }
    const adjusted = await getDailyBarsSplitAdjusted(list, addDays(day, -45), addDays(day, -1))
    for (const symbol of list) {
      const box = F_PROBE.index.includes(symbol as 'SPY') ? index : stock
      box.n += 1
      const or = (bars.get(symbol) ?? []).filter((b) => { const m = minuteOfDay(b.t); return m >= F_PROBE.orStart && m <= F_PROBE.orEnd })
      const daily: Bar[] = ((adjusted[symbol] ?? []) as RawBar[]).map((b, i) => ({ t: i, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
      const a = atr(daily, F_PROBE.atrDays)
      const dailyAtr = a[a.length - 1]
      if (!or.length || dailyAtr == null) { box.noBars += 1; continue }
      const high = Math.max(...or.map((b) => b.h))
      const low = Math.min(...or.map((b) => b.l))
      const price = or[or.length - 1].c
      const range = high - low
      box.rangePct.push(range / price)
      box.toAtr.push(range / dailyAtr)
      if (range < F_PROBE.minOrToAtr * dailyAtr) continue
      box.pass += 1
      const stop = 0.5 * F_PROBE.targetFraction * range // F-A: stop is half the target distance
      const riskDollars = F_PROBE.equity * F_PROBE.risk
      const wanted = Math.floor(riskDollars / stop)
      const cashShares = Math.floor(F_PROBE.equity / price)
      if (wanted > cashShares) box.capped += 1
      box.stopPct.push(stop / price)
      box.effRisk.push(Math.min(wanted, cashShares) * stop)
      box.costR.push((F_PROBE.slippage * price) / stop)
    }
  }
  const missingTotal = symbolDays - cachedDays
  const perFile = sampleFiles ? sampleBytes / sampleFiles : 0
  const reqPerMissing = sampleMissing ? sampleRequests / sampleMissing : 0
  const secPerReq = sampleRequests ? sampleSeconds / sampleRequests : 0
  console.log(`\n[f-probe] sample: ${sample.join(', ')}`)
  console.log(`[f-probe] sample download: ${sampleMissing} missing symbol-days -> ${sampleRequests} requests in ${sampleSeconds.toFixed(0)}s; avg file ${(perFile / 1024).toFixed(1)} KB`)
  console.log(`[f-probe] FULL ESTIMATE: ${missingTotal} missing symbol-days, about ${Math.ceil(missingTotal * reqPerMissing)} requests, about ${((missingTotal * reqPerMissing * secPerReq) / 3600).toFixed(1)} h of download time (outside 06:45-16:05 ET), about ${((missingTotal * perFile) / 1024 ** 3).toFixed(2)} GB on disk`)
  for (const [name, box] of [['top-100 stocks', stock], ['SPY/QQQ', index]] as const) {
    console.log(`[f-probe] --- ${name}: ${box.n} symbol-days, ${box.noBars} without OR bars or ATR ---`)
    console.log(`      OR range as % of price: ${spread(box.rangePct, 2, 100)}`)
    console.log(`      OR range / prior daily ATR(14): ${spread(box.toAtr)}; passes the 25% filter: ${box.pass} of ${box.n - box.noBars}`)
    console.log(`      F-A stop distance as % of price: ${spread(box.stopPct, 3, 100)}`)
    console.log(`      cash cap ($2,000, no leverage) limits the 1% risk position: ${box.capped} of ${box.pass}; actual risk $: ${spread(box.effRisk)} (1% = $20)`)
    console.log(`      0.05% stop slippage alone, in R: ${spread(box.costR)}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[f-probe] failed', error)
    process.exitCode = 1
  })
}
