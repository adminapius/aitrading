// SP-Runner v3 sanity check - BACKTEST ONLY, cached data, INFORMATION ONLY (not a pass test).
// v3 = v2 exactly (docs/sp-runner-v2-spec.md) with one change: no stop raise before 9:45 (spec: docs/sp-runner-v3-spec.md).
//
//   npx tsx scripts/backtest/rulebook/runner-v3.ts --out=backtests/sp-runner-v3
//
// One run over tuning + holdout (Oct 14, 2024 - Oct 13, 2026), reported beside v2 and Step 2b, with and without WLDS 2025-09-10.
// Runs once (lock file). If v3 is not positive in-sample (WLDS left out), the SP-Runner idea stops here.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { easternMidnight } from '../market'
import { RULEBOOK } from './config'
import { loadReference, setFifteenWindow, MINUTE } from './data'
import { et, metrics, writeOutputs, buildRunReport } from './report'
import type { TradeRecord } from './engine'
import { addDays, loadDay, parseArgs, RUNNER, runnerSignal, simulateBracket, type Signal } from './runner'
import { simulateV2, V2, type V2Trade } from './runner-v2'

export const V3 = { raiseStopFrom: 9 * 60 + 45 } as const
export const OUTLIER = { date: '2025-09-10', ticker: 'WLDS' } as const

type Row = TradeRecord & { extra?: V2Trade }
const VARIANTS = [
  { id: 'SPR2B', label: 'Step 2b' },
  { id: 'SPV2', label: 'v2 (full)' },
  { id: 'SPV3', label: 'v3 (no stop raise before 9:45)' },
] as const

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const isOutlier = (t: TradeRecord) => t.date === OUTLIER.date && t.ticker === OUTLIER.ticker

async function main() {
  const args = parseArgs()
  const P = RULEBOOK.period
  const out = join(process.cwd(), args.get('out') ?? 'backtests/sp-runner-v3')
  const lock = join(out, 'RUN-LOCK.json')
  if (existsSync(lock)) throw new Error(`v3 has already been run (${lock}). The sanity check runs once.`)
  setFifteenWindow(addDays(P.start, -45), P.end)
  const ref = await loadReference(addDays(P.start, -420), P.start, P.end)
  const days = ref.periodDays
  const state = new Map(VARIANTS.map((v) => [v.id, { equity: RULEBOOK.account.startingEquity as number, trades: [] as Row[], equityByDay: [] as Array<{ day: string; equity: number }>, skipped: {} as Record<string, number> }]))
  for (const [index, day] of days.entries()) {
    const midnight = easternMidnight(day)
    const inputs = await loadDay(ref, day)
    const signals = inputs.map((input) => runnerSignal(input, day, midnight, { entryEnd: RUNNER.bracket.entryEnd, structuralStop: false })).filter((item): item is Signal => item != null)
      .sort((left, right) => left.minute - right.minute || left.symbol.localeCompare(right.symbol))
    for (const variant of VARIANTS) {
      const st = state.get(variant.id)!
      const riskDollars = st.equity * (variant.id === 'SPR2B' ? RUNNER.risk : V2.risk)
      for (const signal of signals) {
        const result = variant.id === 'SPR2B'
          ? simulateBracket(signal, midnight, riskDollars, st.equity)
          : simulateV2(signal, day, midnight, riskDollars, st.equity, 'full', variant.id === 'SPV3' ? { raiseStopFrom: V3.raiseStopFrom } : {})
        if ('skip' in result) { st.skipped[result.skip!] = (st.skipped[result.skip!] ?? 0) + 1; continue }
        const t = result.trade
        st.equity += t.pnl
        st.trades.push({ run: variant.id, date: day, ticker: signal.symbol, version: 'SP', setup: 'runner-v3', entryIndex: 1, ...t, equityAfter: st.equity, roomR: Infinity,
          gapPct: signal.trigger / signal.input.prevClose - 1, rvol: null, note: `VWAP reclaim ${et(midnight + (signal.minute - 1) * MINUTE)}; base low ${signal.baseLow.toFixed(2)}`,
          extra: variant.id === 'SPR2B' ? undefined : (t as V2Trade) })
        break
      }
      st.equityByDay.push({ day, equity: st.equity })
    }
    if (index % 50 === 0) console.log(`[v3] ${day} (${index + 1}/${days.length}) v3 trades ${state.get('SPV3')!.trades.length}, equity $${state.get('SPV3')!.equity.toFixed(0)}`)
  }

  const reports = VARIANTS.map((v) => buildRunReport({ id: v.id, label: v.label, versions: ['SP'], spSlippageMultiplier: 1 }, state.get(v.id)!.trades, state.get(v.id)!.equityByDay, { skipped: state.get(v.id)!.skipped }, P))
  writeOutputs(out, reports, new Map(VARIANTS.map((v) => [v.id, state.get(v.id)!.trades.map(({ extra, ...rest }) => rest as TradeRecord)])), {
    generatedAt: new Date().toISOString(), sourceCommit: 'sp-runner-v3', tradingDays: days.length,
    notes: ['SP-Runner v3 sanity check (information only): v2 with no stop raise before 9:45. Spec: docs/sp-runner-v3-spec.md.'],
  })

  const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d))
  const stats = (list: TradeRecord[]) => {
    const m = metrics(list, RULEBOOK.account.startingEquity)
    return `${String(m.trades).padStart(4)} trades, win ${m.winRate == null ? 'n/a' : (m.winRate * 100).toFixed(0)}%, avg win ${fmt(m.avgWinR)}R / loss ${fmt(m.avgLossR)}R, exp ${fmt(m.expectancyR)}R, PF ${fmt(m.profitFactor)}, max DD ${m.maxDrawdownR.toFixed(1)}R, total ${list.reduce((s, t) => s + t.rResult, 0).toFixed(1)}R`
  }
  const windows: Array<[string, (t: TradeRecord) => boolean]> = [
    ['tuning', (t) => t.date <= P.tuningEnd],
    ['holdout', (t) => t.date >= P.holdoutStart],
    ['tuning + holdout', () => true],
  ]
  console.log(`\n[v3] ===== SANITY CHECK (information only) ${P.start} to ${P.end} (${days.length} trading days) =====`)
  for (const [name, inWindow] of windows) {
    for (const withOutlier of [true, false]) {
      console.log(`[v3] --- ${name}, ${withOutlier ? 'all trades' : `WLDS ${OUTLIER.date} left out`} ---`)
      for (const v of VARIANTS) console.log(`[v3]   ${v.label.padEnd(32)} ${stats(state.get(v.id)!.trades.filter((t) => inWindow(t) && (withOutlier || !isOutlier(t))))}`)
    }
  }
  const v3 = state.get('SPV3')!.trades
  const v3Clean = v3.filter((t) => !isOutlier(t))
  const total = v3Clean.reduce((s, t) => s + t.rResult, 0)
  const exp = v3Clean.length ? total / v3Clean.length : Number.NaN
  console.log(`[v3] IN-SAMPLE CHECK (tuning + holdout, WLDS ${OUTLIER.date} left out): v3 total ${total.toFixed(1)}R, expectancy ${fmt(exp)}R -> ${total > 0 ? 'POSITIVE (step 2 may go ahead)' : 'NOT POSITIVE (stop here)'}`)

  const group = (name: string, list: Row[]) => {
    const sum = list.reduce((s, t) => s + t.rResult, 0)
    console.log(`[v3] v3 ${name}: ${list.length} trades, total ${sum.toFixed(1)}R, avg ${list.length ? (sum / list.length).toFixed(2) : 'n/a'}R`)
  }
  group('exited before 9:30', v3.filter((t) => !t.extra!.heldPast930))
  group('held past 9:30', v3.filter((t) => t.extra!.heldPast930))
  group('with an add', v3.filter((t) => t.extra!.added))
  console.log(`[v3] v3 exits by reason: ${JSON.stringify(v3.reduce((acc, t) => ({ ...acc, [t.exitReason]: (acc[t.exitReason] ?? 0) + 1 }), {} as Record<string, number>))}`)
  console.log('[v3] v3 exit times (15-min buckets): count, avg R')
  const buckets = new Map<number, number[]>()
  for (const t of v3) { const b = Math.floor(t.extra!.exitMinute / 15) * 15; buckets.set(b, [...(buckets.get(b) ?? []), t.rResult]) }
  for (const b of [...buckets.keys()].sort((x, y) => x - y)) { const rs = buckets.get(b)!; console.log(`      ${hhmm(b)}-${hhmm(b + 15)}  ${String(rs.length).padStart(4)}  ${(rs.reduce((s, x) => s + x, 0) / rs.length).toFixed(2)}R`) }
  group('exits 10:35-10:45', v3.filter((t) => t.extra!.exitMinute >= 10 * 60 + 35 && t.extra!.exitMinute < 10 * 60 + 45))
  console.log('[v3] by month: v3 / v2 / Step 2b total R')
  const months = [...new Set(v3.map((t) => t.date.slice(0, 7)))].sort()
  const monthR = (id: (typeof VARIANTS)[number]['id'], month: string) => state.get(id)!.trades.filter((t) => t.date.startsWith(month)).reduce((s, t) => s + t.rResult, 0)
  for (const month of months) console.log(`      ${month}  ${monthR('SPV3', month).toFixed(2).padStart(7)}R  ${monthR('SPV2', month).toFixed(2).padStart(7)}R  ${monthR('SPR2B', month).toFixed(2).padStart(7)}R`)

  const key = (t: TradeRecord) => `${t.date}|${t.ticker}`
  const maps = new Map(VARIANTS.map((v) => [v.id, new Map(state.get(v.id)!.trades.map((t) => [key(t), t]))]))
  const keys = [...new Set(VARIANTS.flatMap((v) => state.get(v.id)!.trades.map(key)))].sort()
  const rows = ['date,ticker,window,r_2b,exit_2b,r_v2,exit_v2,exit_time_v2,r_v3,exit_v3,exit_time_v3,v3_added,v3_held_past_930,r_diff_v3_minus_v2']
  for (const k of keys) {
    const [date, ticker] = k.split('|')
    const b = maps.get('SPR2B')!.get(k)
    const two = maps.get('SPV2')!.get(k)
    const three = maps.get('SPV3')!.get(k)
    rows.push([date, ticker, date <= P.tuningEnd ? 'tuning' : 'holdout', b?.rResult.toFixed(3) ?? '', b?.exitReason ?? '', two?.rResult.toFixed(3) ?? '', two?.exitReason ?? '', two ? et(two.exitTime) : '',
      three?.rResult.toFixed(3) ?? '', three?.exitReason ?? '', three ? et(three.exitTime) : '', three ? String(three.extra!.added) : '', three ? String(three.extra!.heldPast930) : '',
      two && three ? (three.rResult - two.rResult).toFixed(3) : ''].join(','))
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'comparison.csv'), rows.join('\n') + '\n')
  writeFileSync(lock, JSON.stringify({ ranAt: new Date().toISOString(), v3Trades: v3.length, inSampleTotalRNoOutlier: total }, null, 2))
  console.log(`[v3] wrote ${out}: comparison.csv, trades.csv, report.html, summary.json, RUN-LOCK.json`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[v3] failed', error)
    process.exitCode = 1
  })
}
