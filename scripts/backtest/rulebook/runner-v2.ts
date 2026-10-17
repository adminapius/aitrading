// SP-Runner v2: buying/selling-pressure trade management - BACKTEST ONLY, cached data.
// Locked spec: docs/sp-runner-v2-spec.md (approved Oct 16, 2026, before any result). No changes after a run.
//
//   npx tsx scripts/backtest/rulebook/runner-v2.ts --window=tuning --out=backtests/sp-runner-v2
//   npx tsx scripts/backtest/rulebook/runner-v2.ts --window=holdout --out=backtests/sp-runner-v2
//
// Each window runs once (a lock file in <out>/<window>/ refuses a second run). Same entries as Step 2b.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { easternMidnight } from '../market'
import { RULEBOOK } from './config'
import { minuteIn, minuteMaps } from './common'
import { loadReference, setFifteenWindow, MINUTE } from './data'
import { aggregate, atr, sessionVwap, type Bar } from './indicators'
import { buildRunReport, et, metrics, writeOutputs } from './report'
import type { TradeRecord } from './engine'
import { addDays, loadDay, parseArgs, RUNNER, runnerSignal, simulateBracket, type Signal } from './runner'

const SP = RULEBOOK.SP

export const V2 = {
  stopBufferAtr: 0.25,
  maxStopPct: 0.15,
  risk: 0.005,
  pivotSide: 3,
  trailBufferAtr: 0.25,
  addStart: 9 * 60 + 30,
  addEnd: 9 * 60 + 45, // add signal on bars closing 9:30-9:44
  backstop: 15 * 60 + 30,
  p5: 5,
  p15: 15,
  minHoldoutTrades: 25,
  minPf: 1.5,
} as const

export type V2Mode = 'full' | 'noAdd' | 'stopOnly'

/** Signed volume of one bar: volume x ((close - low) - (high - close)) / (high - low); 0 when high = low. */
export function signedVolume(bar: Pick<Bar, 'h' | 'l' | 'c' | 'v'>) {
  const range = bar.h - bar.l
  return range > 0 ? (bar.v * ((bar.c - bar.l) - (bar.h - bar.c))) / range : 0
}

/** Per-minute pressure sums over the session (minutes without a bar count as 0). */
export function pressureSeries(byMinute: Array<Bar | undefined>) {
  const signed = new Array(1440).fill(0)
  for (let m = 0; m < 1440; m += 1) if (byMinute[m]) signed[m] = signedVolume(byMinute[m]!)
  const window = (m: number, size: number, f: (x: number) => number) => {
    let total = 0
    for (let k = Math.max(0, m - size + 1); k <= m; k += 1) total += f(signed[k])
    return total
  }
  return {
    p5: (m: number) => window(m, V2.p5, (x) => x),
    p15: (m: number) => window(m, V2.p15, (x) => x),
    sell5: (m: number) => window(m, 5, (x) => (x < 0 ? -x : 0)),
    sell5Prev: (m: number) => (m - 5 >= 0 ? window(m - 5, 5, (x) => (x < 0 ? -x : 0)) : 0),
  }
}

export type V2Trade = Omit<TradeRecord, 'run' | 'date' | 'ticker' | 'version' | 'setup' | 'entryIndex' | 'equityAfter' | 'roomR' | 'gapPct' | 'rvol' | 'note'> & { added: boolean; heldPast930: boolean; exitMinute: number }

/** v3 (Oct 16, 2026): the stop may only be raised from this minute on (9:45). v2 has no limit (0). */
export type V2Options = { raiseStopFrom?: number }

export function simulateV2(signal: Signal, day: string, midnight: number, riskDollars: number, equity: number, mode: V2Mode, options: V2Options = {}): { skip: string } | { trade: V2Trade } {
  const raiseStopFrom = options.raiseStopFrom ?? 0
  const C = RULEBOOK.costs
  const A = RULEBOOK.account
  const slip = (m: number) => (m < SP.regularOpenMinute ? SP.slippagePremarket : SP.slippage)
  const bars = signal.input.bars
  const { byMinute, cumVolume } = minuteMaps(bars, midnight)
  const vwap = sessionVwap(bars, () => day, () => true)
  const vwapAt = new Map(bars.map((bar, i) => [minuteIn(midnight, bar.t), vwap[i]]))
  const all = [...signal.input.prior, ...bars]
  const five = aggregate(all, 5, (t) => (t >= midnight ? minuteIn(midnight, t) : minuteIn(midnight - 86_400_000, t)), (t) => (t >= midnight ? day : 'prior'))
  const atr5 = atr(five, SP.atrPeriod)
  const atrAt = (time: number) => {
    let k = -1
    for (let x = 0; x < five.length && five[x].end <= time; x += 1) k = x
    return k >= 0 ? atr5[k] : null
  }
  const pressure = pressureSeries(byMinute)
  const barIndex = new Map(bars.map((bar, i) => [minuteIn(midnight, bar.t), i]))

  // Initial stop: min(base low, VWAP at the signal bar) - 0.25 ATR(5m), capped at 15% below the fill.
  const signalBarMinute = signal.minute - 1
  const vwapSignal = vwapAt.get(signalBarMinute)
  const atrSignal = atrAt(midnight + signal.minute * MINUTE)
  if (vwapSignal == null || atrSignal == null) return { skip: 'no VWAP/ATR at signal' }
  const structural = Math.min(signal.baseLow, vwapSignal) - V2.stopBufferAtr * atrSignal

  // Entry: identical fill model to Step 2b.
  const limit = signal.trigger * (1 + SP.entryLimitOffset)
  let entry: { price: number; minute: number; shares: number; stop: number } | null = null
  for (let m = signal.minute; m < signal.minute + RULEBOOK.fills.entryValidMinutes; m += 1) {
    const bar = byMinute[m]
    if (!bar || bar.h < signal.trigger) continue
    const price = Math.max(signal.trigger, bar.o)
    if (price > limit) continue
    const fill = price * (1 + slip(m))
    const stop = Math.max(structural, fill * (1 - V2.maxStopPct))
    if (!(stop < fill)) return { skip: 'stop not below fill' }
    let shares = Math.floor(riskDollars / (fill - stop) + 1e-9)
    shares = Math.min(shares, Math.floor(equity / fill), Math.floor(A.maxShareOfDayVolume * cumVolume[signal.minute - 1]))
    if (shares < 1 || shares * (fill - stop) < A.minRiskFractionAfterCaps * riskDollars) return { skip: 'caps-below-half-R' }
    if (shares > C.rejectFillAboveBarVolumeShare * bar.v) return { skip: 'fill > 10% of bar volume' }
    entry = { price: fill, minute: m, shares, stop }
    break
  }
  if (!entry) return { skip: 'not filled' }

  const initialStop = entry.stop
  const oneR = entry.shares * (entry.price - initialStop)
  let stop = initialStop
  let shares = entry.shares
  let cost = entry.shares * entry.price
  let maxShares = shares
  let added = false
  let addOrder: { trigger: number; limit: number; expires: number } | null = null
  let addTried = false
  let pendingExit = false
  let lastPivot: number | null = null
  let lastHL: number | null = null
  let maxHigh = entry.price
  let minLow = entry.price
  const target = entry.price * (1 + RUNNER.bracket.targetPct)
  const exits: Array<{ shares: number; price: number }> = []
  let exitMinute = -1
  let reason = ''
  const sellAll = (price: number, minute: number, why: string) => {
    exits.push({ shares, price })
    exitMinute = minute
    reason = why
  }
  const entryBar = byMinute[entry.minute]!
  if (entryBar.c <= stop) sellAll(stop * (1 - slip(entry.minute)), entry.minute + 1, 'stop')
  const pmh = signal.pmh

  for (let m = entry.minute + 1; m < 16 * 60 && exitMinute < 0; m += 1) {
    const bar = byMinute[m]
    if (!bar) continue
    const s = slip(m)
    const stopReason = stop > initialStop + 1e-9 ? 'trail-stop' : 'stop'
    if (mode === 'stopOnly') {
      if (m >= RUNNER.bracket.timeExit) { sellAll(bar.o * (1 - s), m, 'time-exit-11:30'); break }
    } else if (m >= V2.backstop) { sellAll(bar.o * (1 - s), m, 'backstop-15:30'); break }
    if (pendingExit) { sellAll(bar.o * (1 - s), m, 'pressure-exit'); break }
    if (bar.o <= stop) { sellAll(bar.o * (1 - s), m, `gap-${stopReason}`); break }
    if (mode === 'stopOnly' && bar.o >= target) { sellAll(bar.o, m, 'target'); break }
    if (bar.l <= stop) { sellAll(stop * (1 - s), m + 1, stopReason); break }
    if (mode === 'stopOnly' && bar.h >= target + RULEBOOK.fills.targetThroughTicks) { sellAll(target, m + 1, 'target'); break }
    // Add order (full mode): same fill model as the entry; sized so total risk stays within 1R.
    if (addOrder && m < addOrder.expires && bar.h >= addOrder.trigger) {
      const price = Math.max(addOrder.trigger, bar.o)
      if (price <= addOrder.limit) {
        const fill = price * (1 + s)
        const openRisk = shares * (cost / shares - stop)
        let addShares = fill > stop ? Math.floor((oneR - openRisk) / (fill - stop) + 1e-9) : 0
        addShares = Math.min(addShares, Math.floor((equity - cost) / fill), Math.floor(A.maxShareOfDayVolume * cumVolume[m - 1]) - shares)
        if (addShares >= 1 && addShares <= C.rejectFillAboveBarVolumeShare * bar.v) {
          shares += addShares
          cost += addShares * fill
          maxShares = shares
          added = true
        }
        addOrder = null
      }
    }
    if (addOrder && m >= addOrder.expires) addOrder = null
    maxHigh = Math.max(maxHigh, bar.h)
    minLow = Math.min(minLow, bar.l)

    // ---- at this bar's close ----
    // Pivot low confirmed 3 bars later; higher low = above the previous confirmed pivot low, both after the entry bar.
    // Pivots use the bar sequence (a minute with no trade has no bar), 3 bars on each side.
    const j = barIndex.get(m)! - V2.pivotSide
    const pivot = j >= V2.pivotSide ? bars[j] : undefined
    if (pivot && minuteIn(midnight, pivot.t) > entry.minute) {
      let isPivot = true
      for (let k = 1; k <= V2.pivotSide && isPivot; k += 1) {
        if (!(pivot.l < bars[j - k].l) || !(pivot.l < bars[j + k].l)) isPivot = false
      }
      if (isPivot) {
        if (lastPivot != null && pivot.l > lastPivot) {
          lastHL = pivot.l
          const atrNow = atrAt(midnight + (m + 1) * MINUTE)
          if (atrNow != null) {
            const raised = pivot.l - V2.trailBufferAtr * atrNow
            // the raise takes effect from the next bar (m + 1); v3 allows it only from 9:45 on
            if (raised > stop && m + 1 >= raiseStopFrom) stop = raised
          }
        }
        lastPivot = pivot.l
      }
    }
    if (mode !== 'stopOnly') {
      if (pressure.p5(m) < 0 && pressure.sell5(m) > pressure.sell5Prev(m) && lastHL != null && bar.c < lastHL) pendingExit = true
      if (mode === 'full' && !addTried && m >= V2.addStart && m < V2.addEnd && pmh != null && bar.c > pmh && pressure.p5(m) > 0) {
        addTried = true
        addOrder = { trigger: bar.c, limit: bar.c * (1 + SP.entryLimitOffset), expires: m + 1 + RULEBOOK.fills.entryValidMinutes }
      }
    }
  }
  if (exitMinute < 0) {
    const last = bars.at(-1)!
    sellAll(last.c * (1 - slip(959)), 960, mode === 'stopOnly' ? 'time-exit-11:30' : 'backstop-15:30')
  }
  const proceeds = exits.reduce((sum, e) => sum + e.shares * e.price, 0)
  const fees = proceeds * C.secFeePerDollar + Math.min(shares * C.finraTafPerShare, C.finraTafMaxPerTrade)
  const pnl = proceeds - cost - fees
  const rps = entry.price - initialStop
  return {
    trade: {
      entryTime: midnight + entry.minute * MINUTE, entryPrice: entry.price, avgCost: cost / shares, shares: entry.shares, maxShares, units: added ? 2 : 1,
      exitTime: midnight + exitMinute * MINUTE, exitPrice: proceeds / shares, exitReason: reason, partials: added ? `add to ${maxShares}` : '', pnl, fees,
      rResult: pnl / oneR, riskDollars: oneR, stop: initialStop, mfeR: (maxHigh - entry.price) / rps, maeR: (minLow - entry.price) / rps,
      holdMinutes: exitMinute - entry.minute, added, heldPast930: exitMinute > SP.regularOpenMinute, exitMinute,
    },
  }
}

type Variant = { id: string; label: string; mode: V2Mode | '2b' }
const VARIANTS: Variant[] = [
  { id: 'SPR2B', label: 'Step 2b (fixed bracket -10% / +20%, 11:30 exit)', mode: '2b' },
  { id: 'SPV2S', label: 'v2 stop only (v2 stop + 2b +20% target, 11:30 exit)', mode: 'stopOnly' },
  { id: 'SPV2NA', label: 'v2 no add (v2 stop + pressure exits)', mode: 'noAdd' },
  { id: 'SPV2', label: 'SP-Runner v2 (full: v2 stop + pressure exits + add)', mode: 'full' },
]

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

async function main() {
  const args = parseArgs()
  const window = args.get('window')
  if (window !== 'tuning' && window !== 'holdout') throw new Error('Pass --window=tuning or --window=holdout (each runs once).')
  const P = RULEBOOK.period
  const from = window === 'tuning' ? P.start : P.holdoutStart
  const to = window === 'tuning' ? P.tuningEnd : P.end
  const out = join(process.cwd(), args.get('out') ?? 'backtests/sp-runner-v2', window)
  const lock = join(out, 'RUN-LOCK.json')
  if (existsSync(lock)) throw new Error(`The ${window} window has already been run (${lock}). The spec allows one run per window.`)
  // Same reference/data range as Step 2b so everything comes from the existing cache.
  setFifteenWindow(addDays(P.start, -45), P.end)
  const ref = await loadReference(addDays(P.start, -420), P.start, P.end)
  const days = ref.periodDays.filter((day) => day >= from && day <= to)
  const state = new Map(VARIANTS.map((v) => [v.id, { equity: RULEBOOK.account.startingEquity as number, trades: [] as Array<TradeRecord & { extra?: V2Trade }>, equityByDay: [] as Array<{ day: string; equity: number }>, skipped: {} as Record<string, number> }]))
  for (const [index, day] of days.entries()) {
    const midnight = easternMidnight(day)
    const inputs = await loadDay(ref, day)
    const signals = inputs.map((input) => runnerSignal(input, day, midnight, { entryEnd: RUNNER.bracket.entryEnd, structuralStop: false })).filter((item): item is Signal => item != null)
      .sort((left, right) => left.minute - right.minute || left.symbol.localeCompare(right.symbol))
    for (const variant of VARIANTS) {
      const st = state.get(variant.id)!
      const riskDollars = st.equity * (variant.mode === '2b' ? RUNNER.risk : V2.risk)
      for (const signal of signals) {
        const result = variant.mode === '2b' ? simulateBracket(signal, midnight, riskDollars, st.equity) : simulateV2(signal, day, midnight, riskDollars, st.equity, variant.mode)
        if ('skip' in result) { st.skipped[result.skip!] = (st.skipped[result.skip!] ?? 0) + 1; continue }
        const t = result.trade
        st.equity += t.pnl
        const extra = variant.mode === '2b' ? undefined : (t as V2Trade)
        st.trades.push({ run: variant.id, date: day, ticker: signal.symbol, version: 'SP', setup: 'runner-v2', entryIndex: 1, ...t, equityAfter: st.equity, roomR: Infinity,
          gapPct: signal.trigger / signal.input.prevClose - 1, rvol: null, note: `VWAP reclaim ${et(midnight + (signal.minute - 1) * MINUTE)}; base low ${signal.baseLow.toFixed(2)}`, extra })
        break
      }
      st.equityByDay.push({ day, equity: st.equity })
    }
    if (index % 25 === 0) console.log(`[v2] ${window} ${day} (${index + 1}/${days.length}) v2 trades ${state.get('SPV2')!.trades.length}, equity $${state.get('SPV2')!.equity.toFixed(0)}`)
  }

  const period = { ...P, start: from, end: to }
  const reports = VARIANTS.map((v) => buildRunReport({ id: v.id, label: v.label, versions: ['SP'], spSlippageMultiplier: 1 }, state.get(v.id)!.trades, state.get(v.id)!.equityByDay, { skipped: state.get(v.id)!.skipped }, period))
  const clean = (list: Array<TradeRecord & { extra?: V2Trade }>) => list.map(({ extra, ...rest }) => rest as TradeRecord)
  writeOutputs(out, reports, new Map(VARIANTS.map((v) => [v.id, clean(state.get(v.id)!.trades)])), {
    generatedAt: new Date().toISOString(), sourceCommit: 'sp-runner-v2', tradingDays: days.length,
    notes: [`SP-Runner v2, ${window} window ${from} to ${to}, run once. Locked spec: docs/sp-runner-v2-spec.md (approved Oct 16, 2026).`],
  })

  // ---------- console report ----------
  const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d))
  const line = (name: string, list: TradeRecord[]) => {
    const m = metrics(list, RULEBOOK.account.startingEquity)
    return `${name.padEnd(44)} ${String(m.trades).padStart(4)} trades, win ${m.winRate == null ? 'n/a' : (m.winRate * 100).toFixed(0)}%, avg win ${fmt(m.avgWinR)}R / loss ${fmt(m.avgLossR)}R, exp ${fmt(m.expectancyR)}R, PF ${fmt(m.profitFactor)}, max DD ${m.maxDrawdownR.toFixed(1)}R, total ${list.reduce((s, t) => s + t.rResult, 0).toFixed(1)}R`
  }
  console.log(`\n[v2] ===== ${window.toUpperCase()} ${from} to ${to} (${days.length} trading days) =====`)
  for (const v of VARIANTS) console.log(`[v2] ${line(v.label, state.get(v.id)!.trades)}`)
  const v2 = state.get('SPV2')!.trades
  const m2 = metrics(v2, RULEBOOK.account.startingEquity)
  if (window === 'holdout') {
    const pass = m2.trades >= V2.minHoldoutTrades && (m2.expectancyR ?? -1) > 0 && (m2.profitFactor ?? 0) > V2.minPf
    console.log(`[v2] PASS RULE (holdout, v2 full): >= ${V2.minHoldoutTrades} trades (${m2.trades}), expectancy > 0 (${fmt(m2.expectancyR)}R), PF > ${V2.minPf} (${fmt(m2.profitFactor)}) -> ${pass ? 'PASS' : 'FAIL'}`)
  } else console.log('[v2] (pass rule is judged on the holdout run)')

  // Attribution ladder (total R; same entries, report only)
  const total = (id: string) => state.get(id)!.trades.reduce((s, t) => s + t.rResult, 0)
  const per = (id: string) => (state.get(id)!.trades.length ? total(id) / state.get(id)!.trades.length : 0)
  console.log(`[v2] what each part did (total R / per trade): Step 2b ${total('SPR2B').toFixed(1)}R (${per('SPR2B').toFixed(2)})`)
  console.log(`      + v2 stop  -> ${total('SPV2S').toFixed(1)}R (${per('SPV2S').toFixed(2)}) : stop ${(total('SPV2S') - total('SPR2B')) >= 0 ? '+' : ''}${(total('SPV2S') - total('SPR2B')).toFixed(1)}R`)
  console.log(`      + v2 exits -> ${total('SPV2NA').toFixed(1)}R (${per('SPV2NA').toFixed(2)}) : exits ${(total('SPV2NA') - total('SPV2S')) >= 0 ? '+' : ''}${(total('SPV2NA') - total('SPV2S')).toFixed(1)}R`)
  console.log(`      + add      -> ${total('SPV2').toFixed(1)}R (${per('SPV2').toFixed(2)}) : add ${(total('SPV2') - total('SPV2NA')) >= 0 ? '+' : ''}${(total('SPV2') - total('SPV2NA')).toFixed(1)}R`)

  const group = (name: string, list: typeof v2) => {
    const sum = list.reduce((s, t) => s + t.rResult, 0)
    console.log(`[v2] ${name}: ${list.length} trades, total ${sum.toFixed(1)}R, avg ${list.length ? (sum / list.length).toFixed(2) : 'n/a'}R`)
  }
  group('v2 exited before 9:30', v2.filter((t) => !t.extra!.heldPast930))
  group('v2 held past 9:30', v2.filter((t) => t.extra!.heldPast930))
  group('v2 trades with an add', v2.filter((t) => t.extra!.added))
  const reasons = v2.reduce((acc, t) => ({ ...acc, [t.exitReason]: (acc[t.exitReason] ?? 0) + 1 }), {} as Record<string, number>)
  console.log(`[v2] v2 exits by reason: ${JSON.stringify(reasons)}`)
  console.log('[v2] v2 exit times (15-min buckets): count, avg R')
  const buckets = new Map<number, number[]>()
  for (const t of v2) { const b = Math.floor(t.extra!.exitMinute / 15) * 15; buckets.set(b, [...(buckets.get(b) ?? []), t.rResult]) }
  for (const b of [...buckets.keys()].sort((x, y) => x - y)) { const rs = buckets.get(b)!; console.log(`      ${hhmm(b)}-${hhmm(b + 15)}  ${String(rs.length).padStart(4)}  ${(rs.reduce((s, x) => s + x, 0) / rs.length).toFixed(2)}R  ${'#'.repeat(rs.length)}`) }
  const cluster = v2.filter((t) => t.extra!.exitMinute >= 10 * 60 + 35 && t.extra!.exitMinute < 10 * 60 + 45)
  group('v2 exits 10:35-10:45', cluster)
  console.log('[v2] by month (v2 full vs Step 2b): trades, total R')
  const months = [...new Set([...v2, ...state.get('SPR2B')!.trades].map((t) => t.date.slice(0, 7)))].sort()
  for (const month of months) {
    const a = v2.filter((t) => t.date.startsWith(month))
    const b = state.get('SPR2B')!.trades.filter((t) => t.date.startsWith(month))
    console.log(`      ${month}  v2 ${String(a.length).padStart(3)} ${a.reduce((s, t) => s + t.rResult, 0).toFixed(2).padStart(7)}R   2b ${String(b.length).padStart(3)} ${b.reduce((s, t) => s + t.rResult, 0).toFixed(2).padStart(7)}R`)
  }
  for (const v of VARIANTS) console.log(`[v2] skipped ${v.id}: ${JSON.stringify(state.get(v.id)!.skipped)}`)

  // Trade-by-trade comparison
  const key = (t: TradeRecord) => `${t.date}|${t.ticker}`
  const maps = new Map(VARIANTS.map((v) => [v.id, new Map(state.get(v.id)!.trades.map((t) => [key(t), t]))]))
  const keys = [...new Set(VARIANTS.flatMap((v) => state.get(v.id)!.trades.map(key)))].sort()
  const rows = ['date,ticker,r_2b,exit_2b,exit_time_2b,r_v2,exit_v2,exit_time_v2,v2_added,v2_held_past_930,v2_entry,v2_stop,v2_shares,r_v2_no_add,r_v2_stop_only,r_diff_v2_minus_2b']
  for (const k of keys) {
    const [date, ticker] = k.split('|')
    const b = maps.get('SPR2B')!.get(k)
    const f = maps.get('SPV2')!.get(k)
    const na = maps.get('SPV2NA')!.get(k)
    const so = maps.get('SPV2S')!.get(k)
    rows.push([date, ticker, b?.rResult.toFixed(3) ?? '', b?.exitReason ?? '', b ? et(b.exitTime) : '', f?.rResult.toFixed(3) ?? '', f?.exitReason ?? '', f ? et(f.exitTime) : '',
      f ? String(f.extra!.added) : '', f ? String(f.extra!.heldPast930) : '', f?.entryPrice.toFixed(4) ?? '', f?.stop.toFixed(4) ?? '', f?.shares ?? '',
      na?.rResult.toFixed(3) ?? '', so?.rResult.toFixed(3) ?? '', b && f ? (f.rResult - b.rResult).toFixed(3) : ''].join(','))
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'comparison.csv'), rows.join('\n') + '\n')
  writeFileSync(lock, JSON.stringify({ window, from, to, ranAt: new Date().toISOString(), trades: m2.trades }, null, 2))
  console.log(`[v2] wrote ${out}: comparison.csv, trades.csv (all 4 variants), report.html, summary.json, RUN-LOCK.json`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[v2] failed', error)
    process.exitCode = 1
  })
}
