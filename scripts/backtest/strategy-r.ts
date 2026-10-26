// Strategy R ("Ross-type": H1 / H2 / H3) - BACKTEST ONLY. Spec (DRAFT; R1-R14 approved Oct 25, 2026; not locked):
// docs/strategy-r-spec.md
//
//   $env:ALPACA_API_KEY / $env:ALPACA_API_SECRET / $env:FMP_API_KEY / $env:SEC_USER_AGENT="Your Name you@example.com"
//   $env:NODE_OPTIONS="--max-old-space-size=8192"
//   npx tsx scripts/backtest/strategy-r.ts --probe     (counts only; NO exits, NO returns; caches what the run needs)
//
// The probe needs the U1 universe (scripts/backtest/u1-delisted.ts). The run is built only after U1 is merged, its
// results are recorded, and R is locked (Jose, Oct 25, 2026).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apiStats, flushQuoteCache, getDailyBars, getDailyBarsAsof, getDailyBarsSplitAdjusted, getLatestQuote, getMinuteBarsForDay, getNewsForDay, type RawBar } from './data'
import { closeMaps, EDGAR_FLOAT, edgarFloatOn, edgarIssues, loadEdgarFloat, sharesRecord, type FloatResult, type SymbolFloat } from './edgar-float'
import { easternMidnight } from './market'
import { edgarStats, secCompany } from './rulebook/edgar-earnings'
import { RULEBOOK } from './rulebook/config'
import { EJW } from './strategy-ej'
import { extendUniverse } from './u1-delisted'
import { buildUniverse, toEasternDay, type Universe } from './universe'

export const R = {
  windows: { tuning: ['2024-10-14', '2026-07-31'], holdout: ['2026-08-01', '2026-10-16'] } as Record<'tuning' | 'holdout', [string, string]>,
  /** Entry windows by the entry fill bar's start, minutes after ET midnight, [from, to). */
  lines: { H1: [7 * 60, 11 * 60], H2: [7 * 60, 9 * 60 + 30], H3: [9 * 60 + 45, 11 * 60] } as Record<'H1' | 'H2' | 'H3', [number, number]>,
  maxFloat: 5_000_000,
  minPrice: 2,
  maxPrice: 20,
  minGain: 0.2,
  minVolume: 500_000, // shares since 04:00 (R4)
  newsMinutes: 120, // R3
  pullbackMaxBars: 5, // R6
  maxRetrace: 0.5, // R6
  minRisk: 0.02, // R8
  maxRiskPct: 0.1, // R8
  quoteLookbackSec: 120, // R11
  maxSpreadPct: 0.03, // R11, of the mid
  slippage: 0.01, // R11, on top of half the spread
  tick: 0.01,
  haltGapMinutes: 5, // R10: no bar for >= 5 consecutive minutes in regular hours
  haltPriorMinutes: 5, // ... after trading in each of the previous 5 minutes
  rthOpen: 9 * 60 + 30,
  equity: 2000, // probe sizing only (no P&L in the probe)
  riskPct: 0.01, // E's sizing: 1% of equity at risk
  positionPct: RULEBOOK.account.normal.positionValueCapPct,
  maxOpen: RULEBOOK.account.normal.maxOpenPositions,
  maxShareOfBarVolume: 0.1,
  maxShareOfDayVolume: 0.01,
  coverageFloor: 0.75, // section 2 (LOCKED Oct 25)
  minHoldoutTrades: 30, // R12 / R14
}
export type LineName = keyof typeof R.lines

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; vw: number }

// ---------------- pure helpers (tested) ----------------

/** Daily pre-screen (needs minute data next): high >= +20% over the prior close, some price in $2-20, volume >= 500k. Pure. */
export function prefilter(rows: Array<{ day: string; o: number; h: number; l: number; c: number; v: number }>, from: string, to: string) {
  const out: Array<{ day: string; prevClose: number }> = []
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i], prev = rows[i - 1].c
    if (row.day < from || row.day > to || !(prev > 0)) continue
    if (Math.max(row.o, row.h) / prev - 1 < R.minGain || row.v < R.minVolume) continue
    if (row.h < R.minPrice || row.l > R.maxPrice) continue
    out.push({ day: row.day, prevClose: prev })
  }
  return out
}

/** Minute of the ET day for a bar start. Pure. */
export const minuteOf = (t: number, midnight: number) => Math.round((t - midnight) / 60_000)

/**
 * R10: indices of bars that resume trading after an inferred halt: both bars in regular hours, no bar for at least
 * 5 consecutive minutes in between, and a bar in each of the 5 minutes before the gap. Pure.
 */
export function haltResumes(bars: Bar[], midnight: number): Set<number> {
  const out = new Set<number>()
  const minutes = bars.map((b) => minuteOf(b.t, midnight))
  for (let i = 1; i < bars.length; i += 1) {
    const prev = minutes[i - 1], cur = minutes[i]
    if (prev < R.rthOpen || cur - prev - 1 < R.haltGapMinutes) continue
    let traded = true
    for (let k = 1; k < R.haltPriorMinutes; k += 1) if (minutes[i - 1 - k] !== prev - k) { traded = false; break }
    if (traded && i - R.haltPriorMinutes >= 0) out.add(i)
  }
  return out
}

export type Break = { i: number; minute: number; high: number; low: number; bars: number; trigger: number }

/**
 * R5/R6 trigger, on 1-minute bars from 04:00: after a bar sets a new high of day H, 1-5 pullback bars that do not
 * exceed H (low L = their lowest low; valid while L stays above VWAP and gives back at most half the day's low-to-H
 * move); the next bar trading at H + $0.01 is a break. Reset on a 6th pullback bar, a close below L, an invalid
 * pullback, or a halt (a pending order is cancelled). Every break is listed: the break bar is itself a new high, so
 * the sequence does not depend on whether an earlier break was filled or skipped. Pure.
 */
export function findBreaks(bars: Bar[], midnight: number, resumes: Set<number> = haltResumes(bars, midnight)): Break[] {
  const out: Break[] = []
  let H = -Infinity, dayLow = Infinity, pv = 0, vol = 0
  let pb: { k: number; L: number; valid: boolean } | null = null
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i]
    if (resumes.has(i)) pb = null
    else if (pb && pb.k >= 1 && pb.valid && b.h >= H + R.tick - 1e-9) out.push({ i, minute: minuteOf(b.t, midnight), high: H, low: pb.L, bars: pb.k, trigger: Math.round((H + R.tick) * 100) / 100 })
    pv += b.vw * b.v; vol += b.v
    dayLow = Math.min(dayLow, b.l)
    const vwap = vol > 0 ? pv / vol : b.c
    if (b.h > H) { H = b.h; pb = { k: 0, L: Infinity, valid: false }; continue }
    if (!pb) continue
    if (pb.k >= 1 && b.c < pb.L) { pb = null; continue }
    pb.k += 1
    pb.L = Math.min(pb.L, b.l)
    if (pb.k > R.pullbackMaxBars) { pb = null; continue }
    pb.valid = pb.L > vwap && H - pb.L <= R.maxRetrace * (H - dayLow)
    if (!pb.valid) pb = null
  }
  return out
}

/** Section 3 at a break (bars closed before the break bar, news before its start), float excepted. First failing reason, or null. Pure. */
export function filterAt(bars: Bar[], i: number, ctx: { prevClose: number; cumVolume: number[]; newsTimes: number[] }, window: [number, number], midnight: number): string | null {
  if (i < 1) return 'no earlier bar'
  const minute = minuteOf(bars[i].t, midnight)
  if (minute < window[0] || minute >= window[1]) return 'outside the entry window'
  const last = bars[i - 1].c
  if (last < R.minPrice || last > R.maxPrice) return 'price outside $2-20'
  if (last / ctx.prevClose - 1 < R.minGain) return 'gain under 20%'
  if (ctx.cumVolume[i - 1] < R.minVolume) return 'volume under 500k'
  const start = bars[i].t
  if (!ctx.newsTimes.some((t) => t < start && t >= start - R.newsMinutes * 60_000)) return 'no news within 120 min'
  return null
}

export type Plan = { fill: number; stop: number; risk: number; shares: number; spreadPct: number } | { skip: string; spreadPct?: number }

/** R11 / R8 / sizing at a break: quote rules, fill price, stop, risk bounds, size and volume caps. Pure. */
export function planEntry(br: Break, bar: Bar, quote: { bp: number; ap: number } | null, cumVolumeBefore: number, equity = R.equity): Plan {
  if (!quote || !(quote.bp > 0) || !(quote.ap > 0) || quote.ap < quote.bp) return { skip: 'no quote within 120 s' }
  const mid = (quote.ap + quote.bp) / 2
  const spreadPct = (quote.ap - quote.bp) / mid
  if (spreadPct > R.maxSpreadPct) return { skip: 'spread over 3%', spreadPct }
  const fill = Math.max(br.trigger, bar.o) + (quote.ap - quote.bp) / 2 + R.slippage
  const stop = br.low - R.tick
  const risk = fill - stop
  if (risk < R.minRisk) return { skip: 'risk under $0.02', spreadPct }
  if (risk > R.maxRiskPct * fill) return { skip: 'risk over 10% of price', spreadPct }
  const shares = Math.floor(Math.min((equity * R.riskPct) / risk, (equity * R.positionPct) / fill, R.maxShareOfBarVolume * bar.v, R.maxShareOfDayVolume * cumVolumeBefore))
  if (shares < 1) return { skip: 'size under 1 share (volume caps)', spreadPct }
  return { fill, stop, risk, shares, spreadPct }
}

/** Probe trade-count range from filled setups: all of them (no position cap) and at least min(fills, 3) a day. Pure. */
export function tradeRange(fillsByDay: Map<string, number>) {
  let upper = 0, lower = 0, capDays = 0
  for (const n of fillsByDay.values()) { upper += n; lower += Math.min(n, R.maxOpen); if (n > R.maxOpen) capDays += 1 }
  return { upper, lower, capDays }
}

/** Coverage cell for the locked float check (section 2). covered / (stock-days - foreign) is the gate. Pure. */
export type Cov = { n: number; covered: number; under5m: number; foreign: number; miss: Record<string, number>; u1: number; u1Covered: number }
export const cov = (): Cov => ({ n: 0, covered: 0, under5m: 0, foreign: 0, miss: {}, u1: 0, u1Covered: 0 })
export function addCoverage(c: Cov, f: FloatResult, isU1: boolean) {
  c.n += 1
  if (isU1) c.u1 += 1
  if (f.filer === 'foreign') { c.foreign += 1; return }
  if ('shares' in f) { c.covered += 1; if (isU1) c.u1Covered += 1; if (f.shares <= R.maxFloat) c.under5m += 1 } else c.miss[f.miss] = (c.miss[f.miss] ?? 0) + 1
}
export const coverageShare = (c: Cov) => (c.n - c.foreign > 0 ? c.covered / (c.n - c.foreign) : 0)

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a')

// ---------------- probe ----------------

async function probe(out: string) {
  const t0 = Date.now()
  const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`
  const log: string[] = []
  const say = (s = '') => { console.log(s); log.push(s) }
  // Same history and end as the E replays and the Ross audit's U1 rerun, so their caches are reused.
  const historyStart = new Date(Date.parse(`${EJW.start}T00:00:00Z`) - EJW.historyLookbackDays * 86_400_000).toISOString().slice(0, 10)
  const end = R.windows.holdout[1]
  const universe: Universe = await buildUniverse({ historyStart, end, periodStart: R.windows.tuning[0], simFrom: R.windows.tuning[0], simTo: end })
  const base = universe.symbols.length
  const u1 = await extendUniverse(universe, { historyStart, end }, { edgar: true })
  const entities = new Map(u1.entities.filter((e) => e.bars > 0).map((e) => [e.key, e]))
  say(`[r] PROBE (counts only: no exits, no returns). Universe ${base} symbols + U1 ${entities.size} delisted entities (${mins()})`)

  // 1. daily pre-screen
  const pre = new Map<string, Array<{ day: string; prevClose: number }>>()
  for (const [symbol, rows] of universe.daily) {
    const list = prefilter(rows, R.windows.tuning[0], end)
    if (list.length) pre.set(symbol, list)
  }
  const byDay = new Map<string, Array<{ symbol: string; prevClose: number }>>()
  for (const [symbol, list] of pre) for (const x of list) byDay.set(x.day, [...(byDay.get(x.day) ?? []), { symbol, prevClose: x.prevClose }])
  const preDays = [...pre.values()].reduce((a, l) => a + l.length, 0)
  say(`[r] daily pre-screen (high >= +20%, price $2-20 touched, volume >= 500k): ${pre.size} symbols, ${preDays} stock-days (${[...pre.keys()].filter((k) => k.includes('@')).length} U1 entities)`)

  // 2. EDGAR float (point-in-time shares outstanding, D1 method), plain symbols by ticker, U1 entities by their CIK
  const plain = [...pre.keys()].filter((k) => !k.includes('@')).sort()
  const edgar = await loadEdgarFloat(plain, universe.names, (done) => say(`[r]   EDGAR ${done}/${plain.length} (${mins()}, SEC requests ${edgarStats.secRequests})`))
  const splitStart = new Date(Date.parse(`${R.windows.tuning[0]}T00:00:00Z`) - (EDGAR_FLOAT.maxAgeDays + 160) * 86_400_000).toISOString().slice(0, 10)
  const [rawD, splitD] = [await getDailyBars(plain, splitStart, end), await getDailyBarsSplitAdjusted(plain, splitStart, end)]
  const ratios = new Map<string, ReturnType<typeof closeMaps>>(plain.map((s) => [s, closeMaps(rawD[s], splitD[s], toEasternDay)]))
  const byAsof = new Map<string, string[]>()
  for (const k of pre.keys()) if (k.includes('@')) { const e = entities.get(k)!; byAsof.set(e.asof, [...(byAsof.get(e.asof) ?? []), k]) }
  for (const [asof, keys] of byAsof) {
    const tickers = keys.map((k) => entities.get(k)!.ticker)
    const [rawA, splitA] = [await getDailyBarsAsof(tickers, splitStart, end, asof), await getDailyBarsAsof(tickers, splitStart, end, asof, 'split')]
    for (const k of keys) {
      const e = entities.get(k)!
      ratios.set(k, closeMaps(rawA[e.ticker], splitA[e.ticker], toEasternDay))
      if (!e.cik) { edgar.set(k, { cik: null, record: null, nameOk: false, annual: [] }); continue }
      try {
        const [record, company] = [await sharesRecord(e.cik), await secCompany(e.cik)]
        edgar.set(k, { cik: e.cik, record, nameOk: true, annual: company.annual } as SymbolFloat)
      } catch (error) { edgar.set(k, { cik: e.cik, record: null, nameOk: false, annual: [], error: (error as Error).message }) }
    }
  }
  const floatAt = (symbol: string, day: string) => edgarFloatOn(edgar.get(symbol), day, ratios.get(symbol))
  say(`[r] EDGAR loaded (${mins()}; SEC ${edgarStats.secRequests}; companies with a SEC data error: ${edgarIssues.errors}, not cached)`)

  // 3. minute bars, news, triggers, quotes - day by day
  type LineCount = { breaks: number; filterFail: Record<string, number>; setups: number; skips: Record<string, number>; spreadByHour: Record<string, number>; setupsByHour: Record<string, number>; fills: number; fillsByDay: Map<string, number>; spreads: { pre: number[]; rth: number[] } }
  const lineCount = (): LineCount => ({ breaks: 0, filterFail: {}, setups: 0, skips: {}, spreadByHour: {}, setupsByHour: {}, fills: 0, fillsByDay: new Map(), spreads: { pre: [], rth: [] } })
  const counts: Record<string, Record<LineName, LineCount>> = { tuning: { H1: lineCount(), H2: lineCount(), H3: lineCount() }, holdout: { H1: lineCount(), H2: lineCount(), H3: lineCount() } }
  const coverage = new Map<string, Cov>()
  const covAdd = (key: string, f: FloatResult, isU1: boolean) => { const c = coverage.get(key) ?? cov(); addCoverage(c, f, isU1); coverage.set(key, c) }
  const win = { tuning: { days: 0, candidateDays: 0, u1Days: 0, halts: 0, minuteSymbolDays: 0, noMinuteBars: 0 }, holdout: { days: 0, candidateDays: 0, u1Days: 0, halts: 0, minuteSymbolDays: 0, noMinuteBars: 0 } }
  const quotes = { asked: 0, none: 0 }
  const rows: string[] = ['window,line,day,symbol,u1,break_et,trigger,pullback_low,pullback_bars,float,filer,decision,spread_pct']
  const tradingDays = universe.tradingDays.filter((d) => d >= R.windows.tuning[0] && d <= end)
  const lines = Object.keys(R.lines) as LineName[]
  let n = 0
  for (const day of tradingDays) {
    const w = day <= R.windows.tuning[1] ? 'tuning' : 'holdout'
    win[w].days += 1
    const list = byDay.get(day) ?? []
    n += 1
    if (!list.length) continue
    const midnight = easternMidnight(day)
    const iso = (m: number) => new Date(midnight + m * 60_000).toISOString()
    const raw = await getMinuteBarsForDay(day, list.map((x) => x.symbol), iso(4 * 60), iso(16 * 60))
    const news = await getNewsForDay(day, list.map((x) => x.symbol), iso(R.lines.H1[0] - R.newsMinutes), iso(R.lines.H1[1]))
    const newsBy = new Map<string, number[]>()
    for (const s of news) for (const sym of s.symbols ?? []) if (s.created_at) newsBy.set(sym, [...(newsBy.get(sym) ?? []), Date.parse(s.created_at)])
    for (const { symbol, prevClose } of list) {
      win[w].minuteSymbolDays += 1
      const bars: Bar[] = ((raw[symbol] ?? []) as RawBar[]).map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw ?? b.c }))
        .filter((b) => b.t >= midnight + 4 * 3_600_000 && b.t < midnight + 16 * 3_600_000).sort((a, b) => a.t - b.t)
      if (!bars.length) { win[w].noMinuteBars += 1; continue }
      const cumVolume: number[] = []
      let v = 0
      for (const b of bars) { v += b.v; cumVolume.push(v) }
      const ctx = { prevClose, cumVolume, newsTimes: newsBy.get(symbol) ?? [] }
      const resumes = haltResumes(bars, midnight)
      // candidate stock-day (section 2's coverage base): passes section 3 except float at some bar close in 07:00-11:00
      let candidate = false
      for (let i = 1; i < bars.length && !candidate; i += 1) if (!resumes.has(i) && filterAt(bars, i, ctx, R.lines.H1, midnight) === null) candidate = true
      const isU1 = symbol.includes('@')
      const f = floatAt(symbol, day)
      if (candidate) {
        win[w].candidateDays += 1
        if (isU1) win[w].u1Days += 1
        win[w].halts += resumes.size
        for (const key of [`${w}|${day.slice(0, 4)}`, `${w}|all`]) covAdd(key, f, isU1)
      }
      const floatLabel = 'shares' in f ? String(Math.round(f.shares)) : f.miss
      const breaks = findBreaks(bars, midnight, resumes)
      for (const line of lines) {
        const c = counts[w][line]
        for (const br of breaks) {
          const minute = minuteOf(bars[br.i].t, midnight)
          if (minute < R.lines[line][0] || minute >= R.lines[line][1]) continue
          c.breaks += 1
          const fail = filterAt(bars, br.i, ctx, R.lines[line], midnight) ?? (f.filer === 'foreign' ? 'foreign filer (R2)' : !('shares' in f) ? `no float value (${f.miss})` : f.shares > R.maxFloat ? 'float over 5M' : null)
          const et = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
          if (fail) { c.filterFail[fail] = (c.filterFail[fail] ?? 0) + 1; continue }
          c.setups += 1
          const hour = et.slice(0, 2)
          c.setupsByHour[hour] = (c.setupsByHour[hour] ?? 0) + 1
          quotes.asked += 1
          const q = await getLatestQuote(day, symbol, new Date(bars[br.i].t), R.quoteLookbackSec)
          if (!q) quotes.none += 1
          const plan = planEntry(br, bars[br.i], q, cumVolume[br.i - 1])
          if (plan.spreadPct != null) (minute < R.rthOpen ? c.spreads.pre : c.spreads.rth).push(plan.spreadPct)
          if ('skip' in plan) {
            c.skips[plan.skip] = (c.skips[plan.skip] ?? 0) + 1
            if (plan.skip === 'spread over 3%') c.spreadByHour[hour] = (c.spreadByHour[hour] ?? 0) + 1
            rows.push([w, line, day, symbol, isU1, et, br.trigger, br.low, br.bars, floatLabel, f.filer, plan.skip, plan.spreadPct?.toFixed(4) ?? ''].join(','))
            continue
          }
          c.fills += 1
          c.fillsByDay.set(day, (c.fillsByDay.get(day) ?? 0) + 1)
          rows.push([w, line, day, symbol, isU1, et, br.trigger, br.low, br.bars, floatLabel, f.filer, 'would fill', plan.spreadPct.toFixed(4)].join(','))
          break // R7: one entry per symbol per day
        }
      }
    }
    flushQuoteCache()
    if (n % 50 === 0) say(`[r]   ${n}/${tradingDays.length} days (${mins()}, Alpaca ${apiStats.alpaca}, quotes ${quotes.asked})`)
  }

  // 4. report
  say('\n[r] ===== STRATEGY R PROBE (counts only; no exits, no returns) =====')
  for (const w of ['tuning', 'holdout'] as const) {
    const x = win[w]
    say(`[r] ${w} ${R.windows[w][0]}..${R.windows[w][1]}: ${x.days} trading days; ${x.minuteSymbolDays} pre-screened stock-days (${x.noMinuteBars} without minute bars); ${x.candidateDays} candidate stock-days (section 3 except float, 07:00-11:00), ${x.u1Days} of them U1 entities; ${x.halts} inferred halts on candidate days`)
  }
  say(`\n[r] ----- EDGAR FLOAT COVERAGE (LOCKED floor ${100 * R.coverageFloor}% in every calendar year; gate = covered / (candidate stock-days - foreign)) -----`)
  say('[r] window   year   candidate  foreign (R2)  covered  coverage  incl. foreign  <=5M of covered  U1 covered          missing (reason: count)')
  const below: string[] = []
  for (const [k, c] of [...coverage].sort()) {
    const [w, y] = k.split('|')
    const share = coverageShare(c)
    if (y !== 'all' && share < R.coverageFloor) below.push(`${w} ${y} ${(100 * share).toFixed(1)}%`)
    say(`[r] ${w.padEnd(8)} ${y.padEnd(5)} ${String(c.n).padStart(10)}  ${`${c.foreign} (${pct(c.foreign, c.n)})`.padStart(12)}  ${String(c.covered).padStart(7)}  ${pct(c.covered, c.n - c.foreign).padStart(8)}  ${pct(c.covered, c.n).padStart(13)}  ${pct(c.under5m, c.covered).padStart(15)}  ${`${c.u1Covered} of ${c.u1}`.padStart(10)}  ${Object.entries(c.miss).map(([m, v]) => `${m}: ${v}`).join(', ')}`)
  }
  say(below.length ? `[r] ** COVERAGE UNDER 75% in ${below.join('; ')}: by the locked rule the run is information only and cannot pass. **` : '[r] coverage check: every calendar year of both windows is at or above 75%.')
  say('[r] Foreign filers (20-F / 40-F) are excluded by R2; the column shows what the exclusion costs, by year.')

  say('\n[r] ----- TRIGGERS, SETUPS, SKIPS, ESTIMATED TRADES (per line; sizing at $2,000 with no P&L) -----')
  const flags: string[] = []
  const summary: Record<string, unknown> = {}
  for (const w of ['tuning', 'holdout'] as const) for (const line of lines) {
    const c = counts[w][line]
    const range = tradeRange(c.fillsByDay)
    say(`[r] ${w} ${line} (${R.lines[line].map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`).join('-')}): breaks ${c.breaks}, setups ${c.setups}, would fill ${c.fills}; ESTIMATED TRADES ${range.lower}-${range.upper} (lower = at most 3 a day; ${range.capDays} days with more than 3)`)
    say(`[r]     not a setup: ${Object.entries(c.filterFail).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
    say(`[r]     skipped setups: ${Object.entries(c.skips).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
    const spreadSkips = c.skips['spread over 3%'] ?? 0
    say(`[r]     spread over 3% by hour (skips / setups): ${Object.keys(c.setupsByHour).sort().map((h) => `${h}:00 ${c.spreadByHour[h] ?? 0}/${c.setupsByHour[h]}`).join(', ') || 'none'}; total ${spreadSkips}/${c.setups} (${pct(spreadSkips, c.setups)})`)
    say(`[r]     median quoted spread at setups: pre-market ${median(c.spreads.pre) != null ? `${(100 * median(c.spreads.pre)!).toFixed(2)}%` : 'n/a'} (${c.spreads.pre.length}), regular hours ${median(c.spreads.rth) != null ? `${(100 * median(c.spreads.rth)!).toFixed(2)}%` : 'n/a'} (${c.spreads.rth.length})`)
    if (line === 'H2' && c.setups && spreadSkips / c.setups > 0.5) flags.push(`${w} H2: ${pct(spreadSkips, c.setups)} of setups skipped for spread over 3% (R11 flag; the rule does not change)`)
    if (w === 'holdout' && range.upper < R.minHoldoutTrades) flags.push(`holdout ${line}: at most ${range.upper} trades, under 30 (R14: information only in the backtest; a locked paper test only by Jose's decision)`)
    else if (w === 'holdout' && range.lower < R.minHoldoutTrades) flags.push(`holdout ${line}: ${range.lower}-${range.upper} trades; may fall under 30 once positions are capped (R14 decided by the run's count)`)
    summary[`${w}|${line}`] = { ...c, fillsByDay: undefined, spreads: { preMedian: median(c.spreads.pre), rthMedian: median(c.spreads.rth), pre: c.spreads.pre.length, rth: c.spreads.rth.length }, range }
  }
  say(`[r] quotes: ${quotes.asked} looked up at setups, ${quotes.none} with none in the 120 s before the fill bar (${pct(quotes.none, quotes.asked)})`)
  say('[r] fees in the run: E\'s constants (SEC $20.60 per $1M sold, FINRA TAF $0.000195 a share, max $9.79), on top of the R11 fill price.')
  for (const f of flags) say(`[r] ** FLAG: ${f} **`)

  mkdirSync(join(out, 'probe'), { recursive: true })
  writeFileSync(join(out, 'probe', 'setups.csv'), rows.join('\n') + '\n')
  writeFileSync(join(out, 'probe', 'probe.json'), JSON.stringify({ ranAt: new Date().toISOString(), windows: R.windows, lines: R.lines, win, coverage: Object.fromEntries(coverage), below, summary, quotes, flags, u1: u1.stats }, null, 1))
  writeFileSync(join(out, 'probe', 'report.txt'), log.join('\n') + '\n')
  say(`[r] wrote ${join(out, 'probe')} (report.txt, probe.json, setups.csv; not a locked run, can be rerun). Alpaca ${apiStats.alpaca} requests (cached ${apiStats.alpacaCached}). Done in ${mins()}. Send report.txt to Claude.`)
}

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true'] as const }))
  for (const k of ['ALPACA_API_KEY', 'FMP_API_KEY', 'SEC_USER_AGENT']) if (!process.env[k]?.trim()) throw new Error(`Set ${k} in this window first.`)
  const out = join(process.cwd(), args.get('out') ?? 'backtests/strategy-r')
  if (args.get('probe') === 'true') return probe(out)
  throw new Error('Only --probe is built. The run is built after U1 is merged, its results are recorded, and R is locked.')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error('[r] failed', error); process.exitCode = 1 })
}
