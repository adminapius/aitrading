// ARCHIVED Oct 25, 2026 (parked; FAIL or parked verdict in its spec). Kept for the record; not run by anything.
// Strategy E-J backtest - BACKTEST ONLY. Spec (LOCKED Oct 24, 2026): docs/strategy-ej-spec.md
//
//   $env:ALPACA_API_KEY / $env:ALPACA_API_SECRET / $env:FMP_API_KEY ; $env:NODE_OPTIONS="--max-old-space-size=8192"
//   npx tsx scripts/backtest/strategy-ej.ts --probe                                  (data size only, no trades)
//   npx tsx scripts/backtest/strategy-ej.ts --window=tuning  --out=backtests/strategy-ej
//   npx tsx scripts/backtest/strategy-ej.ts --window=holdout --out=backtests/strategy-ej
//
// Entries are Strategy E's live rules, decided only at the scan times (7:00-8:00 every 15 min, then every 5 min).
// The E-current portfolio run (3 slots, E's sizing, 15:55 flatten as live) fixes the entry list (D5); E-J,
// E-J without adds and E-current at 15:30 manage exactly those entries. E-J with its own slot timing is information.
// Each window runs once (lock file), tuning before holdout. Live Strategy E is not touched.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decideEntry, simulatedMarginBuyingPower, strategyGuardrails, strategyRegime } from '../../../lib/strategy'
import { cleanMomentumBlockReason } from '../../../lib/strategies/clean-momentum'
import { scanConfig } from '../../../lib/scan-config'
import { apiStats, CACHE_ROOT, flushQuoteCache, getLatestQuote, hashKey } from '../data'
import { daySymbolSets, loadDay, MINUTE, prefetchDay, setFifteenMinuteWindow, type DayMarket, type MinuteCandidate } from '../market'
import { buildUniverse } from '../universe'
import { EJ, sellFees, simulateTrade, slipAt, type Entry, type Mode, type TradeResult } from '../ej-engine'

export { EJW, SCAN_MINUTES } from '../windows'
import { EJW, SCAN_MINUTES } from '../windows'

type Mark = { bid: number; ask: number; mid: number; spreadPct: number }
async function executableQuote(market: DayMarket, candidate: MinuteCandidate, now: number): Promise<Mark | null> {
  const quote = await getLatestQuote(market.day, candidate.symbol, new Date(now), scanConfig.maxQuoteAgeSeconds)
  if (!quote || !(quote.bp > 0) || !(quote.ap >= quote.bp)) return null
  const mid = (quote.bp + quote.ap) / 2
  const tolerance = mid * 0.005
  if (candidate.price < quote.bp - tolerance || candidate.price > quote.ap + tolerance) return null
  return { bid: quote.bp, ask: quote.ap, mid, spreadPct: ((quote.ap - quote.bp) / mid) * 100 }
}
function scannerSpreadPasses(mark: Mark, candidate: MinuteCandidate, now: number) {
  const regime = strategyRegime(new Date(now))
  return mark.spreadPct <= Math.min(scanConfig.maxSpreadPercent, regime.spread * 100) && (candidate.volume ?? 0) * mark.mid >= regime.dollarVolume && mark.mid >= scanConfig.minPrice
}

// Position state over time from a finished trade's fills (fills happen during their bar; counted from the bar's end).
const doneBy = (t: number, now: number) => t + MINUTE <= now
function heldAt(res: TradeResult, now: number) {
  let shares = 0, cost = 0, realized = 0
  for (const f of res.fills) {
    if (!doneBy(f.t, now)) continue
    if (f.side === 'buy') { shares += f.shares; cost += f.shares * f.price } else {
      const avg = shares > 0 ? cost / shares : 0
      realized += f.shares * (f.price - avg)
      cost -= f.shares * avg
      shares -= f.shares
    }
  }
  return { shares, cost, realized }
}

export type DayRun = { trades: TradeResult[]; blocks: Record<string, number> }

/** One portfolio day: entries at the scan times with E's rules and slots; each entry is simulated with `mode`. */
export async function portfolioDay(market: DayMarket, mode: Mode, flatMinute: number, dayStartEquity: number): Promise<DayRun> {
  const trades: TradeResult[] = []
  const blocks: Record<string, number> = {}
  const bump = (k: string) => { blocks[k] = (blocks[k] ?? 0) + 1 }
  const entriesBySymbol = new Map<string, number>()
  const firstTrade = new Map<string, TradeResult>()
  for (const minute of SCAN_MINUTES) {
    const now = market.midnight + minute * MINUTE
    const regime = strategyRegime(new Date(now))
    if (regime.name === 'exits-only') continue
    const open = trades.filter((t) => !doneBy(t.exitT, now))
    let realized = 0, unrealized = 0, exposure = 0
    for (const t of trades) {
      const h = heldAt(t, now)
      realized += h.realized
      if (h.shares > 0) {
        const bar = market.lastClosedBar(t.entry.symbol, now)
        const mark = bar ? bar.c : t.entry.fill
        unrealized += h.shares * mark - h.cost
        exposure += h.shares * mark
      }
    }
    const fees = trades.reduce((s, t) => s + t.fills.filter((f) => f.side === 'sell' && doneBy(f.t, now)).reduce((x, f) => x + sellFees(f.price, f.shares), 0), 0)
    const equity = dayStartEquity + realized + unrealized - fees
    const cash = Math.max(0, equity - exposure)
    const dailyLossBlocked = equity - dayStartEquity <= -strategyGuardrails.maxDailyLossFraction * dayStartEquity
    let remaining = Math.min(Math.max(0, equity * strategyGuardrails.maxAggregateExposureFraction - exposure), simulatedMarginBuyingPower(equity, cash, exposure, strategyGuardrails.minimumMarginEquity))
    let slots = strategyGuardrails.maxOpenPositions - open.length
    for (const candidate of market.candidatesAt(minute)) {
      if (!candidate.scannerEligible || !candidate.entryEligibleSymbol) continue
      if (open.some((t) => t.entry.symbol === candidate.symbol)) continue
      const last = [...trades].reverse().find((t) => t.entry.symbol === candidate.symbol)
      if (last && last.exitT + MINUTE + strategyGuardrails.reentryCooldownMinutes * MINUTE > now) { bump('cooldown'); continue }
      if (slots <= 0) { bump('3 positions open'); continue }
      if (dailyLossBlocked) { bump('daily loss limit'); continue }
      const pre = decideEntry(candidate, equity, new Date(now), remaining)
      if (pre.action !== 'enter') continue
      const mark = await executableQuote(market, candidate, now)
      if (!mark) { bump('no executable quote'); continue }
      if (!scannerSpreadPasses(mark, candidate, now)) { bump('spread / dollar volume at the quote'); continue }
      const decision = decideEntry({ ...candidate, price: mark.ask, bid: mark.bid, ask: mark.ask, spreadPct: mark.spreadPct }, equity, new Date(now), remaining)
      if (decision.action !== 'enter') { bump('fails at the ask'); continue }
      const entryIndex = (entriesBySymbol.get(candidate.symbol) ?? 0) + 1
      const first = firstTrade.get(candidate.symbol)
      // D4: the first entry "reached its target" = price touched fill + 1.5 ATR while it was open, before now
      const data = market.symbols.get(candidate.symbol)!
      let firstHit = false
      if (first) for (let k = first.entry.fillIndex; k < data.bars.length && data.bars[k].t + MINUTE <= Math.min(now, first.exitT + MINUTE); k += 1) if (data.bars[k].h >= first.entry.fill + EJ.targetAtr * first.entry.atr) { firstHit = true; break }
      const blocked = cleanMomentumBlockReason({ changePercent: candidate.changePercent, price: candidate.price, spreadPct: mark.spreadPct, regime: regime.name, entryIndex, firstEntryHitTarget: firstHit })
      if (blocked) { bump(`E filter: ${blocked}`); continue }
      const fillBar = market.barAtOrAfter(candidate.symbol, now)
      if (!fillBar || fillBar.t >= market.midnight + flatMinute * MINUTE) { bump('no fill bar'); continue }
      const fi = data.bars.indexOf(fillBar)
      const fillMinute = Math.round((fillBar.t - market.midnight) / MINUTE)
      const fill = fillBar.o * (1 + slipAt(fillMinute))
      const atr = decision.riskPerShare
      const stop = fill - atr
      let shares = Math.min(decision.suggestedShares, Math.floor(remaining / fill), Math.floor(0.01 * (fi > 0 ? data.cumVolume[fi - 1] : 0)))
      if (shares < 1) { bump('size / volume cap < 1 share'); continue }
      if (shares > EJ.maxShareOfBarVolume * fillBar.v) { bump('fill > 10% of bar volume'); continue }
      if (!(fill > stop && stop > 0)) { bump('fill below stop'); continue }
      shares = Math.max(1, shares)
      const entry: Entry = { day: market.day, symbol: candidate.symbol, minute, fillIndex: fi, fill, shares, stop, atr, rank: candidate.rank, regime: regime.name, entryIndex }
      const res = simulateTrade(mode, data, market.midnight, entry, flatMinute)
      trades.push(res)
      if (!first) firstTrade.set(candidate.symbol, res)
      entriesBySymbol.set(candidate.symbol, entryIndex)
      remaining = Math.max(0, remaining - shares * fill)
      slots -= 1
    }
  }
  return { trades, blocks }
}

// ---------------- report ----------------

const band = (p: number) => (p < 5 ? '$3-5' : p < 10 ? '$5-10' : '$10+')
function stats(list: TradeResult[]) {
  const rs = list.map((t) => t.r)
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0)
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  let cum = 0, pk = 0, dd = 0, cumD = 0, pkD = 0, ddD = 0
  for (const t of [...list].sort((a, b) => a.exitT - b.exitT)) { cum += t.r; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); cumD += t.pnl; pkD = Math.max(pkD, cumD); ddD = Math.max(ddD, pkD - cumD) }
  const lossSum = Math.abs(sum(rs.filter((r) => r < 0)))
  return { n: list.length, win: list.length ? wins.length / list.length : null, avgWin: wins.length ? sum(wins) / wins.length : null, avgLoss: losses.length ? sum(losses) / losses.length : null,
    exp: list.length ? sum(rs) / list.length : null, pf: lossSum > 0 ? sum(wins) / lossSum : wins.length ? Infinity : null, ddR: dd, dd$: ddD, largest: rs.length ? Math.min(...rs) : null,
    totalR: sum(rs), total$: sum(list.map((t) => t.pnl)) }
}
const f2 = (x: number | null | undefined, d = 2) => (x == null || Number.isNaN(x) ? 'n/a' : x === Infinity ? 'inf' : x.toFixed(d))
const pc = (x: number | null) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`)
const line = (label: string, list: TradeResult[]) => {
  const s = stats(list)
  return `${label.padEnd(30)} ${String(s.n).padStart(4)} trades, win ${pc(s.win)}, avg win ${f2(s.avgWin)}R / loss ${f2(s.avgLoss)}R, exp ${f2(s.exp)}R, PF ${f2(s.pf)}, max DD ${f2(s.ddR, 1)}R / $${f2(s.dd$, 0)}, largest loss ${f2(s.largest)}R, total ${f2(s.totalR, 1)}R / $${f2(s.total$)}`
}

export function passCheck(ej: TradeResult[], ec: TradeResult[]) {
  const a = stats(ej), b = stats(ec)
  const checks: Array<[string, boolean]> = [
    [`E-J total R ${f2(a.totalR, 1)} > E-current ${f2(b.totalR, 1)}`, a.totalR > b.totalR],
    [`E-J $ ${f2(a.total$)} > E-current $ ${f2(b.total$)}`, a.total$ > b.total$],
    [`expectancy ${f2(a.exp)}R > +0.10R`, (a.exp ?? -Infinity) > 0.1],
    [`PF ${f2(a.pf)} > 1.3`, (a.pf ?? 0) > 1.3],
    [`trades ${a.n} >= 30`, a.n >= 30],
    [`dollars $${f2(a.total$)} > 0`, a.total$ > 0],
  ]
  return { pass: checks.every(([, ok]) => ok), text: checks.map(([t, ok]) => `${t} ${ok ? 'ok' : 'FAIL'}`).join('; ') }
}

function details(name: string, list: TradeResult[], log: (s: string) => void) {
  log(`[ej] --- ${name} ---`)
  log(`      ${line('all', list)}`)
  for (const b of ['$3-5', '$5-10', '$10+']) log(`      ${line(`price ${b}`, list.filter((t) => band(t.entry.fill) === b))}`)
  const n = Math.max(1, list.length)
  log(`      reached +$0.50: ${list.filter((t) => t.reached050).length} (${pc(list.filter((t) => t.reached050).length / n)}), +$1.00: ${list.filter((t) => t.reached100).length} (${pc(list.filter((t) => t.reached100).length / n)}), E target (+1.5 ATR): ${list.filter((t) => t.reachedTarget).length} (${pc(list.filter((t) => t.reachedTarget).length / n)})`)
  if (name.startsWith('E-J')) {
    const withAdds = list.filter((t) => t.adds > 0)
    log(`      scale-out 1 filled ${list.filter((t) => t.so1).length}, scale-out 2 filled ${list.filter((t) => t.so2).length}; adds: ${withAdds.length} trades, ${list.reduce((s, t) => s + t.adds, 0)} adds, add P&L $${f2(list.reduce((s, t) => s + t.addPnl, 0))}`)
  }
  const reasons = new Map<string, TradeResult[]>()
  for (const t of list) reasons.set(t.exitReason, [...(reasons.get(t.exitReason) ?? []), t])
  log(`      final exits: ${[...reasons].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `${k} ${v.length} (${f2(v.reduce((x, t) => x + t.r, 0), 1)}R)`).join(', ')}`)
  const months = new Map<string, TradeResult[]>()
  for (const t of list) months.set(t.entry.day.slice(0, 7), [...(months.get(t.entry.day.slice(0, 7)) ?? []), t])
  const keys = [...months.keys()].sort()
  log(`      by month (${keys.filter((k) => months.get(k)!.reduce((x, t) => x + t.pnl, 0) > 0).length} of ${keys.length} positive in $): ${keys.map((k) => `${k} ${months.get(k)!.length}/${f2(months.get(k)!.reduce((x, t) => x + t.r, 0), 1)}R/$${f2(months.get(k)!.reduce((x, t) => x + t.pnl, 0), 0)}`).join(', ')}`)
}

// ---------------- main ----------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const seg = (s: string) => { const c = s.replace(/[:*?"<>|]/g, '-'); return WINDOWS_RESERVED.test(c.split('.')[0]) ? `_${c}` : c }

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true'] as const }))
  const probe = args.get('probe') === 'true'
  const window = args.get('window') ?? ''
  if (!probe && !EJW.windows[window]) throw new Error('Pass --probe, --window=tuning or --window=holdout')
  const out = join(process.cwd(), args.get('out') ?? 'backtests/strategy-ej')
  if (!probe) {
    if (existsSync(join(out, window, 'RUN-LOCK.json'))) throw new Error(`Strategy E-J ${window} has already been run. Each window runs once.`)
    if (window === 'holdout' && !existsSync(join(out, 'tuning', 'RUN-LOCK.json'))) throw new Error('Run --window=tuning first.')
  }
  for (const k of ['ALPACA_API_KEY', 'FMP_API_KEY']) if (!process.env[k]?.trim()) throw new Error(`Set ${k} in this window first.`)
  const t0 = Date.now()
  const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`
  const log = (s: string) => console.log(s)
  const historyStart = new Date(Date.parse(`${EJW.start}T00:00:00Z`) - EJW.historyLookbackDays * 86_400_000).toISOString().slice(0, 10)
  setFifteenMinuteWindow(historyStart, EJW.end)
  const universe = await buildUniverse({ historyStart, end: EJW.end, periodStart: EJW.start, simFrom: EJW.start, simTo: EJW.end })
  const [from, to] = probe ? [EJW.start, EJW.end] : EJW.windows[window]
  const days = universe.tradingDays.filter((d) => d >= from && d <= to)
  log(`[ej] ${probe ? 'PROBE' : window} ${from} to ${to}: ${days.length} days, ${universe.symbols.length} symbols in the universe (${universe.delisted.size} delisted) (${mins()})`)

  if (probe) {
    let symbolDays = 0, batches = 0, cached = 0
    for (const d of days) {
      const { pool, entryCandidates } = daySymbolSets(universe, d)
      const list = [...new Set([...pool, ...entryCandidates])].sort()
      symbolDays += list.length
      for (let i = 0; i < list.length; i += 100) {
        batches += 1
        if (existsSync(join(CACHE_ROOT, 'minute', seg(d), `${hashKey(list.slice(i, i + 100))}.json.gz`))) cached += 1
      }
    }
    log(`[ej] minute data: ${symbolDays} symbol-days (gainer pools + float<=10M candidates), ${batches} day-batches of up to 100 symbols, ${cached} already cached`)
    const sample = Number(args.get('sample-days') ?? 3)
    const pick = Array.from({ length: sample }, (_, k) => days[Math.round((k * (days.length - 1)) / Math.max(1, sample - 1))])
    const r0 = apiStats.alpaca
    const s0 = Date.now()
    for (const d of pick) { await prefetchDay(universe, d); await loadDay(universe, d) }
    const req = apiStats.alpaca - r0
    const sec = (Date.now() - s0) / 1000
    log(`[ej] sample ${pick.join(', ')}: ${req} Alpaca requests in ${sec.toFixed(0)}s (minute bars, 15-minute RVOL baselines, news)`)
    log(`[ej] FULL ESTIMATE: about ${Math.round((req / sample) * days.length)} requests, about ${(((sec / sample) * days.length) / 3600).toFixed(1)} h (outside 06:45-16:05 ET on weekdays) plus quote look-ups at decisions; reruns are cache hits`)
    return
  }

  // prefetch (4 at a time), then simulate day by day
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < days.length) await prefetchDay(universe, days[next++]) }))
  log(`[ej] minute bars cached (${mins()}, Alpaca ${apiStats.alpaca})`)
  let eqE = EJW.equity
  let eqOwn = EJW.equity
  const runs: Record<string, TradeResult[]> = { 'E-current': [], 'E-current 15:30': [], 'E-J': [], 'E-J without adds': [], 'E-J own slots': [] }
  const blocks: Record<string, Record<string, number>> = { 'E-current': {}, 'E-J own slots': {} }
  const add = (target: Record<string, number>, src: Record<string, number>) => { for (const [k, v] of Object.entries(src)) target[k] = (target[k] ?? 0) + v }
  for (const [n, day] of days.entries()) {
    const market = await loadDay(universe, day)
    const base = await portfolioDay(market, 'E', EJW.flatE, eqE)
    add(blocks['E-current'], base.blocks)
    runs['E-current'].push(...base.trades)
    for (const t of base.trades) {
      const d = market.symbols.get(t.entry.symbol)!
      runs['E-current 15:30'].push(simulateTrade('E', d, market.midnight, t.entry, EJW.flat1530))
      runs['E-J'].push(simulateTrade('EJ', d, market.midnight, t.entry, EJW.flat1530))
      runs['E-J without adds'].push(simulateTrade('EJ-noadd', d, market.midnight, t.entry, EJW.flat1530))
    }
    eqE += base.trades.reduce((s, t) => s + t.pnl, 0)
    const own = await portfolioDay(market, 'EJ', EJW.flat1530, eqOwn)
    add(blocks['E-J own slots'], own.blocks)
    runs['E-J own slots'].push(...own.trades)
    eqOwn += own.trades.reduce((s, t) => s + t.pnl, 0)
    flushQuoteCache()
    if (n % 20 === 0) log(`[ej] ${day} (${n + 1}/${days.length}) E-current ${runs['E-current'].length} trades $${eqE.toFixed(0)}, E-J $${(EJW.equity + runs['E-J'].reduce((s, t) => s + t.pnl, 0)).toFixed(0)} (${mins()})`)
  }

  log(`\n[ej] ===== STRATEGY E-J ${window.toUpperCase()} ${from} to ${to} (${days.length} trading days) =====`)
  log('[ej] same entries (fixed by E-current, D5):')
  for (const k of ['E-current', 'E-current 15:30', 'E-J', 'E-J without adds']) log(`      ${line(k, runs[k])}`)
  log(`[ej] information, E-J with its own slot timing: ${line('E-J own slots', runs['E-J own slots'])}`)
  for (const k of ['E-current', 'E-J', 'E-J without adds']) details(k, runs[k], log)
  log(`[ej] entry blocks (E-current run): ${JSON.stringify(blocks['E-current'])}`)
  if (window === 'holdout') {
    const pc2 = passCheck(runs['E-J'], runs['E-current'])
    log(`[ej] PASS RULE (holdout): ${pc2.text} -> ${pc2.pass ? 'PASS' : 'FAIL'}`)
  } else log('[ej] tuning: report only (the pass rule is judged in the holdout)')
  log(`[ej] done in ${mins()}; Alpaca requests ${apiStats.alpaca} (cached ${apiStats.alpacaCached})`)

  mkdirSync(join(out, window), { recursive: true })
  const head = 'run,day,symbol,scan_minute,entry_index,regime,rank,fill,shares,stop,atr,price_band,r,pnl,fees,exit_reason,exit_et,reached_050,reached_100,reached_target,so1,so2,adds,add_pnl,fills'
  const et = (t: number) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' })
  const rows = Object.entries(runs).flatMap(([name, list]) => list.map((t) => [name, t.entry.day, t.entry.symbol, t.entry.minute, t.entry.entryIndex, t.entry.regime, t.entry.rank, t.entry.fill.toFixed(4), t.entry.shares, t.entry.stop.toFixed(4), t.entry.atr.toFixed(4), band(t.entry.fill),
    t.r.toFixed(3), t.pnl.toFixed(2), t.fees.toFixed(4), `"${t.exitReason}"`, et(t.exitT), t.reached050, t.reached100, t.reachedTarget, t.so1, t.so2, t.adds, t.addPnl.toFixed(2),
    `"${t.fills.map((f) => `${et(f.t)} ${f.side} ${f.shares}@${f.price.toFixed(3)} ${f.why}`).join(' | ')}"`].join(',')))
  writeFileSync(join(out, window, 'trades.csv'), [head, ...rows].join('\n') + '\n')
  writeFileSync(join(out, window, 'summary.json'), JSON.stringify({ window, from, to, days: days.length, runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, stats(v)])), blocks,
    pass: window === 'holdout' ? passCheck(runs['E-J'], runs['E-current']) : null }, (_k, v) => (v === Infinity ? 'inf' : v), 1))
  writeFileSync(join(out, window, 'RUN-LOCK.json'), JSON.stringify({ ranAt: new Date().toISOString(), window, trades: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.length])) }, null, 2))
  log(`[ej] wrote ${join(out, window)}: trades.csv (all runs), summary.json, RUN-LOCK.json`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[ej] failed', error)
    process.exitCode = 1
  })
}
