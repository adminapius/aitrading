// Strategy C (rest-of-day momentum, SPY) - BACKTEST ONLY. Spec (LOCKED Oct 24, 2026): docs/strategy-c-spec.md
//
//   $env:ALPACA_API_KEY / $env:ALPACA_API_SECRET / $env:FMP_API_KEY
//   npx tsx scripts/backtest/strategy-c.ts --probe        (data coverage only; computes NO returns)
//   npx tsx scripts/backtest/strategy-c.ts --close-check  (D2 follow-up: which close is right on mismatch days; NO returns)
//
// The probe also downloads and caches everything the run needs, so the run itself is a cache read.
// The run mode is added after the probe's coverage is recorded in the spec (D15).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ALPACA_DATA_URL, ALPACA_TRADING_URL, apiStats, fetchJson, getDailyBars, getDailyBarsAdjusted, HISTORICAL_FEED, readCache, writeCache, type RawBar } from './data'
import { easternMidnight } from './market'
import { toEasternDay } from './universe'

export const C = {
  symbols: ['SPY', 'QQQ', 'IWM', 'DIA'] as const,
  /** Primary listing exchange (SIP exchange code): where the closing auction prints. */
  primary: { SPY: 'P', QQQ: 'Q', IWM: 'P', DIA: 'P' } as Record<string, string>,
  passFail: ['2020-06-01', '2026-10-16'] as [string, string],
  consistency: ['2016-01-04', '2020-05-29'] as [string, string],
  dataStart: '2015-11-01', // prior closes and the first month of the 10-month average are not needed before this
  signalMinute: 15 * 60 + 29, // r uses the close of the 15:29 bar
  entryMinute: 15 * 60 + 30, // fill at the 15:30 bar's open (D3)
  lateEntryMinute: 15 * 60 + 31, // D3 information line
}

export type CalendarDay = { date: string; open: string; close: string }
export type Trade = { t: string; x: string; p: number; s: number; c?: string[] }

/** Half day = the session closes before 16:00 (D7). Pure. */
export const isHalfDay = (day: Pick<CalendarDay, 'close'>) => day.close.slice(0, 5) !== '16:00'

/**
 * Official close from the trades printed just after 16:00 (D2): on the primary exchange, the market-center official
 * close message (condition M) if present, otherwise the largest closing print (condition 6). Pure.
 */
export function closingPrint(trades: Trade[], primary: string): { price: number; kind: 'M' | '6' } | null {
  const own = trades.filter((t) => t.x === primary && t.p > 0)
  const m = own.find((t) => (t.c ?? []).includes('M'))
  if (m) return { price: m.p, kind: 'M' }
  const six = own.filter((t) => (t.c ?? []).includes('6')).sort((a, b) => b.s - a.s)[0]
  return six ? { price: six.p, kind: '6' } : null
}

/**
 * One-day dividend factor for day D (D1): (adj/raw on D-1) / (adj/raw on D), from Alpaca dividend-adjusted vs raw
 * daily closes. On an ex-dividend day it is 1 - dividend / prior close; otherwise 1. Prior close x factor = prior
 * close minus that day's dividend. Pure.
 */
export function dividendFactor(rawPrev: number, adjPrev: number, rawDay: number, adjDay: number) {
  if (!(rawPrev > 0 && adjPrev > 0 && rawDay > 0 && adjDay > 0)) return 1
  const f = (adjPrev / rawPrev) / (adjDay / rawDay)
  // A real dividend is at least half a cent a share; smaller ratios are rounding in the adjusted closes (probe, Oct 25).
  return Math.abs(1 - f) * rawPrev < 0.005 ? 1 : f
}

/** Which of two closing prices is nearer a reference (the 15:59 bar close). Pure. */
export function closerTo(ref: number, print: number, daily: number): 'print' | 'daily' | 'tie' {
  const a = Math.abs(print - ref), b = Math.abs(daily - ref)
  return Math.abs(a - b) < 1e-9 ? 'tie' : a < b ? 'print' : 'daily'
}

const etIso = (day: string, minute: number, second = 0) => new Date(easternMidnight(day) + minute * 60_000 + second * 1_000).toISOString()

async function calendar(start: string, end: string): Promise<CalendarDay[]> {
  const key = `c/calendar/${start}_${end}`
  const hit = readCache<CalendarDay[]>(key)
  if (hit) return hit
  const rows = await fetchJson<CalendarDay[]>(`${ALPACA_TRADING_URL}/v2/calendar?start=${start}&end=${end}`, 'calendar')
  writeCache(key, rows)
  return rows
}

/** 15:29-15:31 bars for the four ETFs on one day (one request). */
async function closingMinutes(day: string): Promise<Record<string, RawBar[]>> {
  const key = `c/minute-1529/${day}`
  const hit = readCache<Record<string, RawBar[]>>(key)
  if (hit) return hit
  const q = new URLSearchParams({ symbols: C.symbols.join(','), timeframe: '1Min', start: etIso(day, C.signalMinute), end: etIso(day, C.lateEntryMinute, 59), feed: HISTORICAL_FEED, adjustment: 'raw', limit: '10000', sort: 'asc' })
  const payload = await fetchJson<{ bars?: Record<string, RawBar[]> }>(`${ALPACA_DATA_URL}/v2/stocks/bars?${q}`, 'c-minute')
  const out = payload.bars ?? {}
  writeCache(key, out)
  return out
}

/** The closing-condition trades (M or 6, any exchange) printed 16:00:00-16:00:59 for one symbol and day. */
async function closingTrades(symbol: string, day: string): Promise<Trade[]> {
  const key = `c/close-trades/${symbol}/${day}`
  const hit = readCache<Trade[]>(key)
  if (hit) return hit
  const out: Trade[] = []
  let token: string | undefined
  do {
    const q = new URLSearchParams({ start: etIso(day, 16 * 60), end: etIso(day, 16 * 60, 59), feed: HISTORICAL_FEED, limit: '10000', sort: 'asc' })
    if (token) q.set('page_token', token)
    const payload = await fetchJson<{ trades?: Trade[] | null; next_page_token?: string | null }>(`${ALPACA_DATA_URL}/v2/stocks/${symbol}/trades?${q}`, 'c-close-trades')
    for (const t of payload.trades ?? []) if ((t.c ?? []).some((c) => c === 'M' || c === '6')) out.push({ t: t.t, x: t.x, p: t.p, s: t.s, c: t.c })
    token = payload.next_page_token ?? undefined
  } while (token)
  writeCache(key, out)
  return out
}

async function vixCloses(start: string, end: string): Promise<Map<string, number> | null> {
  const key = `c/fmp-vix/${start}_${end}`
  let rows = readCache<Array<{ date: string; price?: number; close?: number }>>(key)
  if (!rows) {
    try {
      rows = await fetchJson(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=%5EVIX&from=${start}&to=${end}&apikey=${process.env.FMP_API_KEY?.trim()}`, 'fmp-vix', 'fmp')
      writeCache(key, rows)
    } catch (error) {
      console.log(`[c] VIX from FMP unavailable: ${error instanceof Error ? error.message.slice(0, 120) : error}`)
      return null
    }
  }
  return new Map((rows ?? []).map((r) => [r.date.slice(0, 10), Number(r.price ?? r.close)]).filter(([, v]) => Number.isFinite(v)) as Array<[string, number]>)
}

async function probe(out: string) {
  const t0 = Date.now()
  const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`
  const end = C.passFail[1]
  const cal = await calendar(C.dataStart, end)
  const windows = { consistency: C.consistency, passFail: C.passFail }
  const inWindow = (d: string) => (d >= C.consistency[0] && d <= C.consistency[1]) || (d >= C.passFail[0] && d <= C.passFail[1])
  const sessions = cal.filter((d) => inWindow(d.date))
  console.log(`[c] PROBE (coverage only, no returns): ${sessions.length} sessions in the two windows; calendar ${cal.length} sessions from ${C.dataStart} (${mins()})`)

  const symbols = [...C.symbols]
  const [raw, divAdj] = [await getDailyBars(symbols, C.dataStart, end), await getDailyBarsAdjusted(symbols, C.dataStart, end, 'dividend')]
  const closes = (rows: RawBar[] | undefined) => new Map((rows ?? []).map((b) => [toEasternDay(b.t), b.c]))
  const rawBy = Object.fromEntries(symbols.map((s) => [s, closes(raw[s])])), adjBy = Object.fromEntries(symbols.map((s) => [s, closes(divAdj[s])]))
  console.log(`[c] daily bars loaded (${mins()}, Alpaca ${apiStats.alpaca})`)

  type Row = { sessions: number; halfDays: number; noPriorClose: number; miss1529: number; miss1530: number; miss1531: number; printM: number; print6: number; printNone: number; diffs: number[]; exDiv: number; noDailyClose: number }
  const row = (): Row => ({ sessions: 0, halfDays: 0, noPriorClose: 0, miss1529: 0, miss1530: 0, miss1531: 0, printM: 0, print6: 0, printNone: 0, diffs: [], exDiv: 0, noDailyClose: 0 })
  const table: Record<string, Record<string, Row>> = {}
  for (const w of Object.keys(windows)) table[w] = Object.fromEntries(symbols.map((s) => [s, row()]))
  const dates = cal.map((d) => d.date)
  let done = 0
  for (const day of sessions) {
    const w = day.date <= C.consistency[1] ? 'consistency' : 'passFail'
    const half = isHalfDay(day)
    const minutes = half ? {} : await closingMinutes(day.date)
    const tradesBy = half ? {} : Object.fromEntries(await Promise.all(symbols.map(async (s) => [s, await closingTrades(s, day.date)] as const)))
    const prevDate = dates[dates.indexOf(day.date) - 1]
    for (const s of symbols) {
      const r = table[w][s]
      r.sessions += 1
      if (half) { r.halfDays += 1; continue }
      const bars = minutes[s] ?? []
      const at = (m: number) => bars.some((b) => Math.round((Date.parse(b.t) - easternMidnight(day.date)) / 60_000) === m)
      if (!at(C.signalMinute)) r.miss1529 += 1
      if (!at(C.entryMinute)) r.miss1530 += 1
      if (!at(C.lateEntryMinute)) r.miss1531 += 1
      if (!prevDate || rawBy[s].get(prevDate) == null) r.noPriorClose += 1
      const daily = rawBy[s].get(day.date)
      if (daily == null) r.noDailyClose += 1
      const print = closingPrint(tradesBy[s] ?? [], C.primary[s])
      if (!print) r.printNone += 1
      else { if (print.kind === 'M') r.printM += 1; else r.print6 += 1; if (daily != null) r.diffs.push(Math.abs(print.price - daily)) }
      if (prevDate) {
        const f = dividendFactor(rawBy[s].get(prevDate) ?? NaN, adjBy[s].get(prevDate) ?? NaN, daily ?? NaN, adjBy[s].get(day.date) ?? NaN)
        if (f < 1) r.exDiv += 1
      }
    }
    done += 1
    if (done % 250 === 0) console.log(`[c]   ${done}/${sessions.length} sessions (${mins()}, Alpaca ${apiStats.alpaca})`)
  }
  const vix = await vixCloses(C.dataStart, end)

  console.log('\n[c] ===== STRATEGY C DATA COVERAGE (no returns computed) =====')
  console.log('[c] window       ETF   sessions  half-days  no 15:29  no 15:30  no 15:31  no prior close  auction print M / 6 / none   |auction - daily close| <=$0.005 / <=$0.01 / >$0.01 (max)  ex-div days')
  const summary: Record<string, unknown> = {}
  for (const w of Object.keys(windows)) for (const s of symbols) {
    const r = table[w][s]
    const d = r.diffs
    const a = d.filter((x) => x <= 0.005).length, b = d.filter((x) => x <= 0.01).length
    console.log(`[c] ${w.padEnd(12)} ${s.padEnd(4)} ${String(r.sessions).padStart(9)} ${String(r.halfDays).padStart(10)} ${String(r.miss1529).padStart(9)} ${String(r.miss1530).padStart(9)} ${String(r.miss1531).padStart(9)} ${String(r.noPriorClose).padStart(15)}   ${`${r.printM} / ${r.print6} / ${r.printNone}`.padStart(22)}   ${`${a} / ${b} / ${d.length - b} (${d.length ? Math.max(...d).toFixed(3) : 'n/a'})`.padStart(40)}  ${String(r.exDiv).padStart(11)}`)
    summary[`${w}|${s}`] = { ...r, diffs: undefined, diffLe0005: a, diffLe001: b, diffGt001: d.length - b, diffMax: d.length ? Math.max(...d) : null }
  }
  const tradingDays = sessions.filter((d) => !isHalfDay(d)).map((d) => d.date)
  const vixMissing = vix ? tradingDays.filter((d) => { const i = dates.indexOf(d); return i < 1 || !vix.has(dates[i - 1]) }).length : null
  console.log(`[c] VIX (prior-day close, FMP): ${vix ? `${vix.size} daily closes; ${vixMissing} of ${tradingDays.length} full sessions have no prior-day VIX` : 'unavailable'}`)
  console.log(`[c] Alpaca requests ${apiStats.alpaca} (cached ${apiStats.alpacaCached}); everything is now cached for the run.`)
  mkdirSync(join(out, 'probe'), { recursive: true })
  writeFileSync(join(out, 'probe', 'coverage.json'), JSON.stringify({ ranAt: new Date().toISOString(), windows, summary, vix: vix ? { closes: vix.size, sessionsWithoutPriorDayVix: vixMissing } : null }, null, 1))
  console.log(`[c] wrote ${join(out, 'probe', 'coverage.json')} (not a locked run). Send this output to Claude. Done in ${mins()}.`)
}

/** The 15:59 bar for the four ETFs on one day (one request), cached. */
async function lastMinute(day: string): Promise<Record<string, RawBar[]>> {
  const key = `c/minute-1559/${day}`
  const hit = readCache<Record<string, RawBar[]>>(key)
  if (hit) return hit
  const q = new URLSearchParams({ symbols: C.symbols.join(','), timeframe: '1Min', start: etIso(day, 15 * 60 + 59), end: etIso(day, 15 * 60 + 59, 59), feed: HISTORICAL_FEED, adjustment: 'raw', limit: '10000', sort: 'asc' })
  const payload = await fetchJson<{ bars?: Record<string, RawBar[]> }>(`${ALPACA_DATA_URL}/v2/stocks/bars?${q}`, 'c-minute-1559')
  const out = payload.bars ?? {}
  writeCache(key, out)
  return out
}

// D2 follow-up (Oct 25, 2026): on days where the auction print and the daily bar close differ by more than $0.01,
// which one is right? Reference: the 15:59 bar's close (the official close is normally within cents of it).
// Also: which exchanges carry the closing-condition trades for each ETF (QQQ found no primary print before 2020).
async function closeCheck(out: string) {
  const t0 = Date.now()
  const end = C.passFail[1]
  const cal = await calendar(C.dataStart, end)
  const inWindow = (d: string) => (d >= C.consistency[0] && d <= C.consistency[1]) || (d >= C.passFail[0] && d <= C.passFail[1])
  const sessions = cal.filter((d) => inWindow(d.date) && !isHalfDay(d))
  const symbols = [...C.symbols]
  const raw = await getDailyBars(symbols, C.dataStart, end)
  const rawBy = Object.fromEntries(symbols.map((s) => [s, new Map((raw[s] ?? []).map((b) => [toEasternDay(b.t), b.c]))]))
  type R = { mismatch: number; nearer: Record<string, number>; dailyVs1559: number[]; printVs1559: number[]; worst: Array<Record<string, unknown>>; exchanges: Record<string, number>; conds: Record<string, number> }
  const res: Record<string, R> = {}
  for (const w of ['consistency', 'passFail']) for (const s of symbols) res[`${w}|${s}`] = { mismatch: 0, nearer: { print: 0, daily: 0, tie: 0, 'no 15:59 bar': 0 }, dailyVs1559: [], printVs1559: [], worst: [], exchanges: {}, conds: {} }
  let n = 0
  for (const day of sessions) {
    const w = day.date <= C.consistency[1] ? 'consistency' : 'passFail'
    let last: Record<string, RawBar[]> | null = null
    for (const s of symbols) {
      const r = res[`${w}|${s}`]
      const trades = await closingTrades(s, day.date)
      for (const t of trades) { r.exchanges[t.x] = (r.exchanges[t.x] ?? 0) + 1; for (const c of t.c ?? []) if (c === 'M' || c === '6') r.conds[`${t.x}:${c}`] = (r.conds[`${t.x}:${c}`] ?? 0) + 1 }
      const print = closingPrint(trades, C.primary[s])
      const daily = rawBy[s].get(day.date)
      if (!print || daily == null || Math.abs(print.price - daily) <= 0.01) continue
      r.mismatch += 1
      last ??= await lastMinute(day.date)
      const ref = last[s]?.[0]?.c
      if (ref == null) { r.nearer['no 15:59 bar'] += 1; continue }
      r.nearer[closerTo(ref, print.price, daily)] += 1
      r.dailyVs1559.push(Math.abs(daily - ref)); r.printVs1559.push(Math.abs(print.price - ref))
      const own = trades.filter((t) => t.x === C.primary[s])
      r.worst.push({ day: day.date, kind: print.kind, print: print.price, daily, close1559: ref, primaryClosingTrades: own.length, primaryPriceRange: own.length ? [Math.min(...own.map((t) => t.p)), Math.max(...own.map((t) => t.p))] : null, largestSize: own.length ? Math.max(...own.map((t) => t.s)) : null })
    }
    n += 1
    if (n % 500 === 0) console.log(`[c]   ${n}/${sessions.length} sessions (${((Date.now() - t0) / 60_000).toFixed(1)} min, Alpaca ${apiStats.alpaca})`)
  }
  const med = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null }
  console.log('\n[c] ===== D2 CLOSE CHECK (no returns computed) =====')
  console.log('[c] window       ETF   mismatch days (>$0.01)   nearer the 15:59 close: print / daily / tie / no bar   median |x - 15:59 close|: print / daily')
  const summary: Record<string, unknown> = {}
  for (const [k, r] of Object.entries(res)) {
    const [w, s] = k.split('|')
    console.log(`[c] ${w.padEnd(12)} ${s.padEnd(4)} ${String(r.mismatch).padStart(22)}   ${`${r.nearer.print} / ${r.nearer.daily} / ${r.nearer.tie} / ${r.nearer['no 15:59 bar']}`.padStart(46)}   ${`${med(r.printVs1559)?.toFixed(3) ?? 'n/a'} / ${med(r.dailyVs1559)?.toFixed(3) ?? 'n/a'}`.padStart(30)}`)
    console.log(`[c]      closing-condition trades by exchange:condition: ${Object.entries(r.conds).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, v]) => `${c} ${v}`).join(', ') || 'none'}`)
    r.worst.sort((a, b) => Math.abs((b.print as number) - (b.daily as number)) - Math.abs((a.print as number) - (a.daily as number)))
    for (const x of r.worst.slice(0, 3)) console.log(`[c]      e.g. ${x.day}: print ${x.kind} ${x.print}, daily ${x.daily}, 15:59 close ${x.close1559}, ${x.primaryClosingTrades} primary closing trades ${JSON.stringify(x.primaryPriceRange)}`)
    summary[k] = { mismatch: r.mismatch, nearer: r.nearer, medianPrintVs1559: med(r.printVs1559), medianDailyVs1559: med(r.dailyVs1559), conds: r.conds, worst: r.worst.slice(0, 25) }
  }
  console.log(`[c] Alpaca requests ${apiStats.alpaca} (cached ${apiStats.alpacaCached})`)
  mkdirSync(join(out, 'probe'), { recursive: true })
  writeFileSync(join(out, 'probe', 'close-check.json'), JSON.stringify({ ranAt: new Date().toISOString(), summary }, null, 1))
  console.log(`[c] wrote ${join(out, 'probe', 'close-check.json')} (not a locked run). Send this output to Claude. Done in ${((Date.now() - t0) / 60_000).toFixed(1)} min.`)
}

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true'] as const }))
  for (const k of ['ALPACA_API_KEY', 'FMP_API_KEY']) if (!process.env[k]?.trim()) throw new Error(`Set ${k} in this window first.`)
  const out = join(process.cwd(), args.get('out') ?? 'backtests/strategy-c')
  if (args.get('probe') === 'true') return probe(out)
  if (args.get('close-check') === 'true') return closeCheck(out)
  throw new Error('Only --probe is built so far. The run is added after the probe coverage is recorded in the spec (D15).')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error('[c] failed', error); process.exitCode = 1 })
}
