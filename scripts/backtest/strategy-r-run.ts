// Strategy R ("Ross-type": H1 / H2 / H3) - the LOCKED run. BACKTEST ONLY. Spec (LOCKED Oct 25, 2026):
// docs/strategy-r-spec.md
//
//   $env:ALPACA_API_KEY / $env:ALPACA_API_SECRET / $env:FMP_API_KEY / $env:SEC_USER_AGENT="Your Name you@example.com"
//   $env:NODE_OPTIONS="--max-old-space-size=8192"
//   npx tsx scripts/backtest/strategy-r-run.ts --run      (runs ONCE; writes backtests/strategy-r/run)
//
// Three passes over Oct 14, 2024 - Oct 16, 2026:
//   A. setups and their entry quotes (cached by the probe) -> the median quoted spreads for the no-quote line;
//   B. the full simulation, fetching the exit quotes it needs; nothing is printed or written;
//   -> RUN-LOCK.json is written here, before any result is shown;
//   C. the same simulation from the cache only, and the report.
// A crash in A or B leaves no lock and no result, so it can be rerun (the cache makes it faster).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apiStats, flushQuoteCache, getLatestQuote, getMinuteBarsForDay, getNewsForDay, setCacheOnly, type RawBar } from './data'
import { easternMidnight } from './market'
import { RULEBOOK } from './rulebook/config'
import { addCoverage, cov, coverageShare, filterAt, findBreaks, haltResumes, loadR, minuteOf, planEntry, R, type Bar, type Break, type Cov, type LineName } from './strategy-r'
import type { FloatResult } from './edgar-float'

export const RR = {
  window: ['2024-10-14', '2026-10-16'] as [string, string],
  parts: { tuning: ['2024-10-14', '2026-07-31'], holdout: ['2026-08-01', '2026-10-16'] } as Record<'tuning' | 'holdout', [string, string]>,
  targetR: 2, // R9
  flattenMinute: 15 * 60 + 30,
  dailyLossPct: 0.04,
  pass: { minTrades: 30, minExpectancyR: 0.15, minPf: 1.4 }, // section 8 (LOCKED Oct 25)
}
const C = RULEBOOK.costs
export const sellFees = (price: number, shares: number) => price * shares * C.secFeePerDollar + Math.min(shares * C.finraTafPerShare, C.finraTafMaxPerTrade)
export const partOf = (day: string) => (day <= RR.parts.tuning[1] ? 'tuning' : 'holdout') as 'tuning' | 'holdout'
export const phaseOf = (minute: number) => (minute < R.rthOpen ? 'pre' : 'rth') as 'pre' | 'rth'

// ---------------- pure helpers (tested) ----------------

/**
 * Section 5-6 exit check on one bar (not the 15:30 flatten). Stop before target. On the entry bar only the stop, and
 * only if the bar closes at or below it. On a bar after a halt: an open at or below the stop fills there (the gap is
 * taken in full); an open at or above the target fills at the target. Returns the base price before the half spread
 * and slippage (stop) or the limit price (target). Pure.
 */
export function exitOnBar(p: { stop: number; target: number }, bar: Bar, o: { entryBar?: boolean; resume?: boolean } = {}): { reason: 'stop' | 'target'; base: number } | null {
  if (o.entryBar) return bar.c <= p.stop ? { reason: 'stop', base: p.stop } : null
  if (o.resume && bar.o >= p.target) return { reason: 'target', base: p.target }
  if (bar.l <= p.stop) return { reason: 'stop', base: Math.min(p.stop, bar.o) }
  if (bar.h >= p.target + R.tick - 1e-9) return { reason: 'target', base: p.target }
  return null
}

/** Sell price: a target is a limit (no slippage); a stop or a flatten pays half the spread and $0.01. Pure. */
export const sellPrice = (reason: string, base: number, halfSpread: number) => (reason === 'target' ? base : Math.max(0.01, base - halfSpread - R.slippage))

export type Trade = {
  line: LineName; variant: string; part: 'tuning' | 'holdout'; day: string; symbol: string; u1: boolean; entryMinute: number; fill: number; stop: number; target: number
  shares: number; riskPerShare: number; spreadPct: number; noQuote: boolean; exitMinute: number; exitPrice: number; reason: string; exitQuoteFallback: boolean
  fees: number; pnl: number; r: number; haltsWhileOpen: number
}

/** Section 8 pass rule on one line's trades (whole window), with the tuning and holdout parts. Pure. */
export function verdict(trades: Trade[], coverageOk: boolean) {
  const stats = (t: Trade[]) => {
    const rs = t.map((x) => x.r)
    const pos = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0), neg = -rs.filter((r) => r < 0).reduce((a, b) => a + b, 0)
    return { n: t.length, expectancy: t.length ? rs.reduce((a, b) => a + b, 0) / t.length : 0, pf: neg > 0 ? pos / neg : pos > 0 ? Infinity : 0, pnl: t.reduce((a, x) => a + x.pnl, 0), winPct: t.length ? (100 * t.filter((x) => x.pnl > 0).length) / t.length : 0, totalR: rs.reduce((a, b) => a + b, 0) }
  }
  const all = stats(trades), tuning = stats(trades.filter((x) => x.part === 'tuning')), holdout = stats(trades.filter((x) => x.part === 'holdout'))
  const rules = [
    { rule: 1, text: 'at least 30 trades', value: String(all.n), pass: all.n >= RR.pass.minTrades },
    { rule: 2, text: 'expectancy > +0.15R', value: `${all.expectancy.toFixed(3)}R`, pass: all.expectancy > RR.pass.minExpectancyR },
    { rule: 3, text: 'profit factor > 1.4', value: Number.isFinite(all.pf) ? all.pf.toFixed(2) : 'inf', pass: all.pf > RR.pass.minPf },
    { rule: 4, text: 'positive dollars', value: `$${all.pnl.toFixed(2)}`, pass: all.pnl > 0 },
    { rule: 5, text: 'positive expectancy in the tuning part and in the holdout part', value: `tuning ${tuning.expectancy.toFixed(3)}R (${tuning.n}), holdout ${holdout.expectancy.toFixed(3)}R (${holdout.n})`, pass: tuning.n > 0 && holdout.n > 0 && tuning.expectancy > 0 && holdout.expectancy > 0 },
  ]
  return { all, tuning, holdout, rules, pass: coverageOk && rules.every((r) => r.pass), coverageOk }
}

/** R13 (kept by Jose): which passing line goes to paper. Pure. */
export function paperPick(passing: LineName[]): string {
  if (!passing.length) return 'none: no line passed'
  if (passing.length === 1) return `${passing[0]} (the only line that passed) -> a locked 30-trade paper test`
  return passing.includes('H1') ? `H1 (R13: more than one line passed: ${passing.join(', ')}) -> a locked 30-trade paper test` : `R13: ${passing.join(', ')} passed but not H1; Jose decides before any paper test`
}

// ---------------- day data ----------------

export type SymbolDay = { symbol: string; u1: boolean; bars: Bar[]; cumVolume: number[]; resumes: Set<number>; floatResult: FloatResult; candidate: boolean; setups: Record<LineName, Break[]> }

async function buildDay(day: string, list: Array<{ symbol: string; prevClose: number }>, floatAt: (s: string, d: string) => FloatResult): Promise<SymbolDay[]> {
  const midnight = easternMidnight(day)
  const iso = (m: number) => new Date(midnight + m * 60_000).toISOString()
  const raw = await getMinuteBarsForDay(day, list.map((x) => x.symbol), iso(4 * 60), iso(16 * 60))
  const news = await getNewsForDay(day, list.map((x) => x.symbol), iso(R.lines.H1[0] - R.newsMinutes), iso(R.lines.H1[1]))
  const newsBy = new Map<string, number[]>()
  for (const s of news) for (const sym of s.symbols ?? []) if (s.created_at) newsBy.set(sym, [...(newsBy.get(sym) ?? []), Date.parse(s.created_at)])
  const out: SymbolDay[] = []
  for (const { symbol, prevClose } of list) {
    const bars: Bar[] = ((raw[symbol] ?? []) as RawBar[]).map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw ?? b.c }))
      .filter((b) => b.t >= midnight + 4 * 3_600_000 && b.t < midnight + 16 * 3_600_000).sort((a, b) => a.t - b.t)
    if (!bars.length) continue
    const cumVolume: number[] = []
    let v = 0
    for (const b of bars) { v += b.v; cumVolume.push(v) }
    const ctx = { prevClose, cumVolume, newsTimes: newsBy.get(symbol) ?? [] }
    const resumes = haltResumes(bars, midnight)
    let candidate = false
    for (let i = 1; i < bars.length && !candidate; i += 1) if (!resumes.has(i) && filterAt(bars, i, ctx, R.lines.H1, midnight) === null) candidate = true
    const f = floatAt(symbol, day)
    const floatOk = f.filer !== 'foreign' && 'shares' in f && f.shares <= R.maxFloat
    const breaks = findBreaks(bars, midnight, resumes)
    const setups = { H1: [], H2: [], H3: [] } as Record<LineName, Break[]>
    if (floatOk) for (const line of Object.keys(R.lines) as LineName[]) setups[line] = breaks.filter((br) => filterAt(bars, br.i, ctx, R.lines[line], midnight) === null)
    out.push({ symbol, u1: symbol.includes('@'), bars, cumVolume, resumes, floatResult: f, candidate, setups })
  }
  return out
}

export type QuoteFn = (day: string, symbol: string, t: number) => Promise<{ bp: number; ap: number } | null>
export type Account = { equity: number; trades: Trade[]; skips: Record<string, number>; peak: number; maxDd: number }

/** One line's account through one day: entries in time order (symbols alphabetical within a minute), exits on each bar. */
export async function simulateDay(day: string, data: SymbolDay[], line: LineName, variant: 'base' | 'fill-no-quote', acct: Account, quote: QuoteFn, medianSpread: Record<string, number>) {
  const midnight = easternMidnight(day)
  const part = partOf(day)
  const bump = (k: string) => { acct.skips[k] = (acct.skips[k] ?? 0) + 1 }
  type Open = { sd: SymbolDay; entryIndex: number; fill: number; stop: number; target: number; shares: number; risk: number; spreadPct: number; noQuote: boolean; halts: number }
  const open: Open[] = []
  const entered = new Set<string>()
  const dayStart = acct.equity
  let dayPnl = 0
  // every (minute, symbol, bar index), in time order
  const events: Array<{ m: number; sd: SymbolDay; i: number }> = []
  for (const sd of data) sd.bars.forEach((b, i) => events.push({ m: minuteOf(b.t, midnight), sd, i }))
  events.sort((a, b) => a.m - b.m || a.sd.symbol.localeCompare(b.sd.symbol))
  const close = async (o: Open, i: number, reason: string, base: number) => {
    const b = o.sd.bars[i]
    let half = (o.spreadPct * o.fill) / 2, fallback = true
    if (reason !== 'target') {
      const q = await quote(day, o.sd.symbol, b.t)
      if (q && q.ap >= q.bp && q.bp > 0) { half = (q.ap - q.bp) / 2; fallback = false }
    } else fallback = false
    const price = sellPrice(reason, base, half)
    const fees = sellFees(price, o.shares)
    const pnl = o.shares * (price - o.fill) - fees
    acct.equity += pnl
    dayPnl += pnl
    acct.peak = Math.max(acct.peak, acct.equity)
    acct.maxDd = Math.max(acct.maxDd, acct.peak - acct.equity)
    acct.trades.push({ line, variant, part, day, symbol: o.sd.symbol, u1: o.sd.u1, entryMinute: minuteOf(o.sd.bars[o.entryIndex].t, midnight), fill: o.fill, stop: o.stop, target: o.target, shares: o.shares, riskPerShare: o.risk, spreadPct: o.spreadPct, noQuote: o.noQuote, exitMinute: minuteOf(b.t, midnight), exitPrice: price, reason, exitQuoteFallback: fallback, fees, pnl, r: pnl / (o.shares * o.risk), haltsWhileOpen: o.halts })
    open.splice(open.indexOf(o), 1)
  }
  for (const ev of events) {
    const { m, sd, i } = ev
    const bar = sd.bars[i]
    // exits first
    for (const o of open.filter((x) => x.sd === sd && x.entryIndex < i)) {
      if (sd.resumes.has(i)) o.halts += 1
      if (m >= RR.flattenMinute) { await close(o, i, 'flatten 15:30', bar.o); continue }
      const ex = exitOnBar(o, bar, { resume: sd.resumes.has(i) })
      if (ex) await close(o, i, ex.reason, ex.base)
    }
    // entries
    const br = sd.setups[line].find((x) => x.i === i)
    if (!br || entered.has(sd.symbol)) continue
    if (dayPnl <= -RR.dailyLossPct * dayStart) { bump('daily loss limit'); continue }
    if (open.length >= R.maxOpen) { bump('3 positions open'); continue }
    let q = await quote(day, sd.symbol, bar.t)
    let noQuote = false
    if (!q || !(q.bp > 0) || !(q.ap > 0) || q.ap < q.bp) {
      if (variant === 'base') { bump('no quote within 120 s'); continue }
      const mid = Math.max(br.trigger, bar.o), s = medianSpread[`${partOf(day)}|${phaseOf(m)}`] ?? 0
      q = { bp: mid * (1 - s / 2), ap: mid * (1 + s / 2) }
      noQuote = true
    }
    const plan = planEntry(br, bar, q, sd.cumVolume[i - 1], acct.equity)
    if ('skip' in plan) { bump(plan.skip); continue }
    const committed = open.reduce((a, o) => a + o.shares * o.fill, 0)
    if (committed + plan.shares * plan.fill > acct.equity) { bump('no cash (no margin)'); continue }
    entered.add(sd.symbol)
    const o: Open = { sd, entryIndex: i, fill: plan.fill, stop: plan.stop, target: plan.fill + RR.targetR * plan.risk, shares: plan.shares, risk: plan.risk, spreadPct: plan.spreadPct, noQuote, halts: 0 }
    open.push(o)
    const ex = exitOnBar(o, bar, { entryBar: true })
    if (ex) await close(o, i, ex.reason, ex.base)
  }
  // still open after the last bar (no bar at or after 15:30): flatten at the last close
  for (const o of [...open]) await close(o, o.sd.bars.length - 1, 'flatten (no bar after 15:30)', o.sd.bars.at(-1)!.c)
}

// ---------------- run ----------------

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
const et = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

async function run(out: string) {
  const dir = join(out, 'run')
  if (existsSync(join(dir, 'RUN-LOCK.json'))) throw new Error('Strategy R has already been run. It runs once (spec section 8).')
  const t0 = Date.now()
  const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`
  const log: string[] = []
  const say = (s = '') => { console.log(s); log.push(s) }
  const { byDay, floatAt, tradingDays: allDays } = await loadR((s) => console.log(s ?? ''), mins, 'RUN (locked, runs once)')
  const days = allDays.filter((d) => d >= RR.window[0] && d <= RR.window[1])
  const lines = Object.keys(R.lines) as LineName[]
  const quoteFn: QuoteFn = (day, symbol, t) => getLatestQuote(day, symbol, new Date(t), R.quoteLookbackSec)

  // A. setups' quoted spreads by part and phase (median for the no-quote information line)
  const spreads: Record<string, number[]> = {}
  const seen = new Set<string>()
  let n = 0
  for (const day of days) {
    const list = byDay.get(day) ?? []
    if (list.length) {
      const midnight = easternMidnight(day)
      for (const sd of await buildDay(day, list, floatAt)) for (const line of lines) for (const br of sd.setups[line]) {
        const key = `${sd.symbol}|${br.i}`
        if (seen.has(`${day}|${key}`)) continue
        seen.add(`${day}|${key}`)
        const q = await quoteFn(day, sd.symbol, sd.bars[br.i].t)
        if (q && q.bp > 0 && q.ap >= q.bp) (spreads[`${partOf(day)}|${phaseOf(minuteOf(sd.bars[br.i].t, midnight))}`] ??= []).push((q.ap - q.bp) / ((q.ap + q.bp) / 2))
      }
      flushQuoteCache()
    }
    if (++n % 100 === 0) console.log(`[r] pass A ${n}/${days.length} days (${mins()}, Alpaca ${apiStats.alpaca})`)
  }
  const medianSpread = Object.fromEntries(Object.entries(spreads).map(([k, v]) => [k, median(v) ?? 0]))

  // B and C: the simulation (B fetches exit quotes; C reads the cache only and reports)
  const simulate = async (pass: string) => {
    const accounts: Record<string, Account> = {}
    for (const line of lines) for (const variant of ['base', 'fill-no-quote']) accounts[`${line}|${variant}`] = { equity: R.equity, trades: [], skips: {}, peak: R.equity, maxDd: 0 }
    const coverage = new Map<string, Cov>()
    let k = 0
    for (const day of days) {
      const list = byDay.get(day) ?? []
      if (list.length) {
        const data = await buildDay(day, list, floatAt)
        for (const sd of data) if (sd.candidate) for (const key of [`${day.slice(0, 4)}`, 'all']) { const c = coverage.get(key) ?? cov(); addCoverage(c, sd.floatResult, sd.u1); coverage.set(key, c) }
        for (const line of lines) for (const variant of ['base', 'fill-no-quote'] as const) await simulateDay(day, data, line, variant, accounts[`${line}|${variant}`], quoteFn, medianSpread)
        flushQuoteCache()
      }
      if (++k % 100 === 0) console.log(`[r] pass ${pass} ${k}/${days.length} days (${mins()}, Alpaca ${apiStats.alpaca})`)
    }
    return { accounts, coverage }
  }
  await simulate('B')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'RUN-LOCK.json'), JSON.stringify({ ranAt: new Date().toISOString(), spec: 'docs/strategy-r-spec.md (LOCKED Oct 25, 2026)', window: RR.window, parts: RR.parts }, null, 2))
  setCacheOnly(true)
  const { accounts, coverage } = await simulate('C')

  // report
  say('\n===== STRATEGY R RUN (LOCKED, runs once): H1 / H2 / H3, Oct 14, 2024 - Oct 16, 2026 =====')
  say('Spec: docs/strategy-r-spec.md. $2,000 per line, compounding; 1% risk, 25% cap, 3 open, 4% daily loss limit; 2R target, pullback-low stop, 15:30 flatten; fees on sells.')
  say('\n--- EDGAR float coverage, candidate stock-days (locked floor 75% per calendar year; base excludes foreign filers, R15) ---')
  const below: string[] = []
  for (const [key, c] of [...coverage].sort()) {
    const share = coverageShare(c)
    if (key !== 'all' && share < R.coverageFloor) below.push(`${key} ${(100 * share).toFixed(1)}%`)
    say(`${key.padEnd(5)} candidates ${c.n}, foreign ${c.foreign}, covered ${c.covered} -> ${(100 * share).toFixed(1)}% (incl. foreign ${(100 * c.covered / Math.max(1, c.n)).toFixed(1)}%); missing ${Object.entries(c.miss).map(([m, v]) => `${m} ${v}`).join(', ') || 'none'}`)
  }
  const coverageOk = below.length === 0
  say(coverageOk ? 'coverage: every year at or above 75%.' : `** COVERAGE UNDER 75% in ${below.join('; ')}: every line is information only and cannot pass. **`)
  say(`median quoted spread at setups (for the no-quote line): ${Object.entries(medianSpread).map(([k2, v]) => `${k2} ${(100 * v).toFixed(2)}%`).join(', ')}`)

  const verdicts: Record<string, ReturnType<typeof verdict>> = {}
  for (const variant of ['base', 'fill-no-quote'] as const) {
    say(`\n===== ${variant === 'base' ? 'JUDGED: base (no-quote setups skipped)' : 'INFORMATION: no-quote setups filled at the median spread'} =====`)
    say('line  part      trades  win %   expectancy   PF      total R    net $      ')
    for (const line of lines) {
      const a = accounts[`${line}|${variant}`]
      const v = verdict(a.trades, coverageOk)
      verdicts[`${line}|${variant}`] = v
      for (const [label, s] of [['whole', v.all], ['tuning', v.tuning], ['holdout', v.holdout]] as const) say(`${line}    ${label.padEnd(8)} ${String(s.n).padStart(6)}  ${s.winPct.toFixed(1).padStart(5)}  ${s.expectancy.toFixed(3).padStart(8)}R  ${(Number.isFinite(s.pf) ? s.pf.toFixed(2) : 'inf').padStart(5)}  ${s.totalR.toFixed(2).padStart(8)}R  ${s.pnl.toFixed(2).padStart(9)}`)
      const reasons: Record<string, number> = {}
      for (const t of a.trades) reasons[t.reason] = (reasons[t.reason] ?? 0) + 1
      say(`      end equity $${a.equity.toFixed(2)}, max drawdown $${a.maxDd.toFixed(2)}; exits: ${Object.entries(reasons).map(([r2, c]) => `${r2} ${c}`).join(', ') || 'none'}; trades with a halt while open ${a.trades.filter((t) => t.haltsWhileOpen > 0).length}; no-quote fills ${a.trades.filter((t) => t.noQuote).length}; exit-quote fallbacks ${a.trades.filter((t) => t.exitQuoteFallback).length}`)
      say(`      setups not taken: ${Object.entries(a.skips).sort((x, y) => y[1] - x[1]).map(([s2, c]) => `${s2} ${c}`).join(', ') || 'none'}`)
      const byPhase = (p: 'pre' | 'rth') => a.trades.filter((t) => phaseOf(t.entryMinute) === p)
      say(`      by entry: pre-market ${byPhase('pre').length} trades ${byPhase('pre').reduce((x, t) => x + t.r, 0).toFixed(2)}R; regular hours ${byPhase('rth').length} trades ${byPhase('rth').reduce((x, t) => x + t.r, 0).toFixed(2)}R; U1 entities ${a.trades.filter((t) => t.u1).length} trades`)
    }
  }
  say('\n===== PASS RULE (base, whole window; every condition; section 8) =====')
  const passing: LineName[] = []
  for (const line of lines) {
    const v = verdicts[`${line}|base`]
    for (const r of v.rules) say(`${line} rule ${r.rule} ${r.pass ? 'PASS' : 'FAIL'}: ${r.text}: ${r.value}`)
    say(`${line} VERDICT: ${v.pass ? 'PASS' : v.coverageOk ? 'FAIL' : 'INFORMATION ONLY (coverage under 75%)'}`)
    if (v.pass) passing.push(line)
  }
  say(`\nPAPER: ${paperPick(passing)}. A pass is not evidence enough for live money: a locked 30-trade paper test comes first (the rules were set from Ross's entries in this same window).`)

  const rows = ['line,variant,part,day,symbol,u1,entry_et,fill,stop,target,shares,risk_per_share,spread_pct,no_quote_fill,exit_et,exit_price,exit_reason,exit_quote_fallback,fees,pnl,r,halts_while_open']
  for (const a of Object.values(accounts)) for (const t of a.trades) rows.push([t.line, t.variant, t.part, t.day, t.symbol, t.u1, et(t.entryMinute), t.fill.toFixed(4), t.stop.toFixed(4), t.target.toFixed(4), t.shares, t.riskPerShare.toFixed(4), t.spreadPct.toFixed(5), t.noQuote, et(t.exitMinute), t.exitPrice.toFixed(4), t.reason, t.exitQuoteFallback, t.fees.toFixed(4), t.pnl.toFixed(4), t.r.toFixed(4), t.haltsWhileOpen].join(','))
  writeFileSync(join(dir, 'trades.csv'), rows.join('\n') + '\n')
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ranAt: new Date().toISOString(), window: RR.window, parts: RR.parts, coverage: Object.fromEntries(coverage), coverageOk, medianSpread, verdicts, paper: paperPick(passing) }, null, 1))
  writeFileSync(join(dir, 'report.txt'), log.join('\n') + '\n')
  console.log(`\n[r] wrote ${dir} (report.txt, summary.json, trades.csv, RUN-LOCK.json). Alpaca ${apiStats.alpaca} requests (cached ${apiStats.alpacaCached}). Done in ${mins()}. Send report.txt to Claude.`)
}

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true'] as const }))
  for (const k of ['ALPACA_API_KEY', 'FMP_API_KEY', 'SEC_USER_AGENT']) if (!process.env[k]?.trim()) throw new Error(`Set ${k} in this window first.`)
  const out = join(process.cwd(), args.get('out') ?? 'backtests/strategy-r')
  if (args.get('run') === 'true') return run(out)
  throw new Error('Pass --run (the locked run; it runs once).')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error('[r] failed', error); process.exitCode = 1 })
}
