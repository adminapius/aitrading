// Strategy S & SP rulebook backtest. BACKTEST ONLY: nothing here touches live or paper order execution.
//
//   npx tsx scripts/backtest/rulebook/run.ts --out=backtests/rulebook [--runs=A,B,C,D,E] [--from=2024-10-14] [--to=2026-10-13] [--upload]
//
// Runs: A = S alone, B = SP alone, C = S + SP on the same $2,000, D = SP with slippage doubled, E = SP variant (config.variants.E).
// Needs ALPACA_API_KEY / ALPACA_API_SECRET (SIP) and FMP_API_KEY; --upload also needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { apiStats } from '../data'
import { easternMidnight } from '../market'
import { RULEBOOK } from './config'
import { baselineCumulative, dailyPivotHighs, fifteenVolumes, getDayBars, loadReference, newsBetween, priorDays, setFifteenWindow, strategySList, strategySPCandidates, MINUTE } from './data'
import { Account, type RunConfig, type TradeRecord } from './engine'
import { roomLog } from './common'
import { writeFileSync } from 'node:fs'
import { buildRunReport, et, writeOutputs } from './report'
import { buildS, sFunnel } from './strategy-s'
import { buildSP, runScanner, spFunnel, type ScanSymbol } from './strategy-sp'
import type { SymbolDay } from './types'
import { uploadRulebook } from './upload'
import { runSwing } from './swing'

export const RUNS: RunConfig[] = [
  { id: 'A', label: 'S alone (long only)', versions: ['S'], spSlippageMultiplier: 1 },
  { id: 'B', label: 'SP alone', versions: ['SP'], spSlippageMultiplier: 1 },
  { id: 'C', label: 'S + SP on the same $2,000', versions: ['S', 'SP'], spSlippageMultiplier: 1 },
  { id: 'D', label: 'SP with slippage doubled (stress test)', versions: ['SP'], spSlippageMultiplier: 2 },
  { id: 'E', label: 'SP variant E: R-trail on 5-min closes, time stop only below entry, stop ≥ 1.0 ATR', versions: ['SP'], spSlippageMultiplier: 1, variant: 'E' },
  { id: 'F', label: 'Run C + F: S Setup A also accepts a bullish close above the 20 EMA and the prior high; breakout volume 1.5× (tuning window only)', versions: ['S', 'SP'], spSlippageMultiplier: 1, variant: 'F' },
  { id: 'RS', label: 'Room shadow (S): only the S signals blocked by the room rule alone, run C rules otherwise (tuning window only)', versions: ['S'], spSlippageMultiplier: 1, variant: 'RS' },
  { id: 'RSP', label: 'Room shadow (SP): only the SP signals blocked by the room rule alone, run C rules otherwise (tuning window only)', versions: ['SP'], spSlippageMultiplier: 1, variant: 'RSP' },
  { id: 'G', label: 'G: SP with run C rules + entries 7:00-9:59 AM ET + RVOL ≥ 100× (one-shot holdout test)', versions: ['SP'], spSlippageMultiplier: 1, variant: 'G' },
  { id: 'H', label: 'H: S-Swing by the course - daily bars, long only, 3rd MA touch or 20-day breakout, 2N stop, 10-day-low / 50 SMA exits', versions: ['S'], spSlippageMultiplier: 1, swing: true },
]

const NOTES = [
  'Bars: Alpaca SIP 1-minute bars, raw (unadjusted) prices, 4:00 AM-4:00 PM ET; active and delisted assets included.',
  'Decisions use completed bars only. Entries: a later 1-min bar trading through the trigger fills at max(trigger, open) + slippage; no fill if that is above the limit (trigger + 0.2% S / + 0.5% SP); orders live 5 minutes.',
  'Stops are held by the backtester: a 1-min low touching the stop fills at the stop − slippage; a bar opening beyond the stop fills at that open − slippage. On the entry bar the stop counts only if the bar closes at or below it.',
  'Scale-out targets are resting limits filled at the target (or the open if it gapped above) once the bar trades 1 cent through. Close-based exits fill at the next 1-min open − slippage.',
  'Slippage: S 0.05%; SP 0.5% (1.0% before 9:30 AM); run D doubles SP slippage. Commission $0; SEC fee $20.60 per $1M sold and FINRA TAF $0.000195/share (max $9.79) on every sell.',
  'Fills larger than 10% of that 1-min bar\'s volume are rejected. Position size also capped at 1% of the stock\'s volume so far that day and (under $10k) 100% of equity, no leverage.',
  'S is long-only in this backtest (shorts off by decision). S daily list uses prior-day data at 9:00 ET; gap and premarket volume from 15-minute bars up to 9:00.',
  'Catalyst = news from Alpaca\'s news feed (Benzinga) since the prior 4:00 PM close. Stocktwits history is not available to the backtest, so social-only movers are missed.',
  'Float: FMP current float scaled back with quarterly share-count history (not true historical float). Symbols without an FMP float are excluded from SP.',
  'Halts are not in the data: "not halted in the last 5 minutes" = no 5+ minute hole in regular-hours bars. Premarket halts cannot be detected.',
  'Relative volume = volume since 4:00 AM ÷ the average over the prior 20 sessions at the same time of day (15-minute buckets, partial bucket prorated). No history = treated as passing.',
  'Sector data is not loaded: the normal-mode same-sector cap (only active above $10,000 equity) is not enforced.',
  'Run E (SP variant, [adapted] only): R-trail/breakeven moves on 5-min closes instead of 1-min highs; the 15-minute time stop exits only if the last close is below entry; the smart stop is at least 1.0 × ATR(5m) (a tighter stop is widened and the position sized off the wider stop, not skipped).',
  'Pass rule trade counts: ≥100 for the full period; each window needs the same rate, prorated by its share of trading days. Profitable months: ≥ 4/6 of months (14th-13th months for the full period, calendar months per window).',
  'Lesson 3.3 (breakouts) is still pending: Setup 1 (SP) and Setup B (S) may change when it arrives.',
]

function parseArgs() {
  return new Map(process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=')
    return [key, rest.join('=') || 'true'] as const
  }))
}

function addDays(day: string, days: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

async function main() {
  const args = parseArgs()
  const from = args.get('from') ?? RULEBOOK.period.start
  const to = args.get('to') ?? RULEBOOK.period.end
  const period = { ...RULEBOOK.period, start: from, end: to }
  const out = join(process.cwd(), args.get('out') ?? 'backtests/rulebook')
  const runIds = (args.get('runs') ?? 'A,B,C,D,E').split(',').map((id) => id.trim().toUpperCase())
  const runs = RUNS.filter((run) => runIds.includes(run.id))
  if (!runs.length) throw new Error(`No runs selected (${runIds.join(',')}); use --runs=A,B,C,D,E`)
  const intradayRuns = runs.filter((run) => !run.swing)
  const needS = intradayRuns.some((run) => run.versions.includes('S'))
  const needSP = intradayRuns.some((run) => run.versions.includes('SP'))
  const needE = runs.some((run) => run.variant === 'E')
  const needF = runs.some((run) => run.variant === 'F')
  const historyStart = addDays(from, -420) // 200-day SMA + 52-week high
  setFifteenWindow(addDays(from, -45), to)
  console.log(`[rulebook] loading reference data ${historyStart} → ${to}`)
  const ref = await loadReference(historyStart, from, to)
  console.log(`[rulebook] ${ref.periodDays.length} trading days, runs ${runs.map((run) => run.id).join(',')}`)
  const accounts = intradayRuns.map((run) => new Account(run))

  for (const [dayIndex, day] of (accounts.length ? ref.periodDays : []).entries()) {
    const midnight = easternMidnight(day)
    const frames: SymbolDay[] = []
    const framesE: SymbolDay[] = [] // SP frames built with variant E's stop rule
    const framesF: SymbolDay[] = [] // S + SP frames built with variant F's rules (tuning window only)
    const prev = priorDays(ref, day, Math.max(RULEBOOK.S.warmupSessions, 1))
    const prevDay = prev.at(-1) ?? null
    if (needS) {
      const list = await strategySList(ref, day)
      const symbols = list.map((entry) => entry.symbol)
      const today = await getDayBars(day, symbols)
      const priorBars = await Promise.all(prev.map(async (session) => ({ day: session, midnight: easternMidnight(session), bars: await getDayBars(session, symbols) })))
      for (const entry of list) {
        const bars = today.get(entry.symbol) ?? []
        if (!bars.length) continue
        const sInput = {
          symbol: entry.symbol, day, midnight, prevClose: entry.prevClose, todayBars: bars,
          priorSessions: priorBars.map((session) => ({ day: session.day, midnight: session.midnight, bars: session.bars.get(entry.symbol) ?? [] })),
          dailyPivotHighs: dailyPivotHighs(ref, entry.symbol, day),
        }
        frames.push(buildS(sInput))
        if (needF && day <= RULEBOOK.period.tuningEnd) {
          const F = RULEBOOK.variants.F
          framesF.push(buildS(sInput, { confirmBullishAboveEmaAndPriorHigh: F.sConfirmBullishAboveEmaAndPriorHigh, breakoutVolumeMult: F.breakoutVolumeMult, countFunnel: false }))
        }
      }
    }
    if (needSP) {
      const candidates = strategySPCandidates(ref, day)
      const symbols = candidates.map((entry) => entry.symbol)
      const today = await getDayBars(day, symbols)
      const prior = prevDay ? await getDayBars(prevDay, symbols) : new Map()
      const newsStart = prevDay ? easternMidnight(prevDay) + 16 * 60 * MINUTE : midnight
      const news = await newsBetween(day, symbols, newsStart, midnight + 16 * 60 * MINUTE)
      const baselineSessions = priorDays(ref, day, RULEBOOK.SP.scanner.rvolSessions)
      const scanInputs: ScanSymbol[] = []
      for (const entry of candidates) {
        const bars = today.get(entry.symbol) ?? []
        if (!bars.length) continue
        const volumes = await fifteenVolumes(entry.symbol)
        const sessionsWithData = baselineSessions.filter((session) => volumes.has(session))
        scanInputs.push({
          symbol: entry.symbol, prevClose: entry.prevClose, midnight, todayBars: bars,
          newsTimes: (news.get(entry.symbol) ?? []).map((item) => item.at),
          baselineAt: (minute) => (sessionsWithData.length ? baselineCumulative(volumes, baselineSessions, minute) : 0),
        })
      }
      const scanner = runScanner(scanInputs)
      for (const entry of candidates) {
        const bars = today.get(entry.symbol) ?? []
        const state = scanner.get(entry.symbol)
        if (!bars.length || !state || !state.eligible.some((flag) => flag === 1)) {
          // Never in the top 3 today: no new entries possible, and no position can exist without an entry.
          continue
        }
        const spInput = {
          symbol: entry.symbol, day, midnight, prevClose: entry.prevClose, float: entry.float, todayBars: bars,
          prior: prevDay ? { day: prevDay, midnight: easternMidnight(prevDay), bars: prior.get(entry.symbol) ?? [] } : null,
          dailyPivotHighs: dailyPivotHighs(ref, entry.symbol, day), scanner: state,
        }
        frames.push(buildSP(spInput))
        if (needE) {
          const E = RULEBOOK.variants.E
          framesE.push(buildSP({ ...spInput, stopMinWidthAtr: E.spStopMinWidthAtr, widenTightStop: E.widenTightStop, countFunnel: false }))
        }
        if (needF && day <= RULEBOOK.period.tuningEnd) {
          framesF.push(buildSP({ ...spInput, breakoutVolumeMult: RULEBOOK.variants.F.breakoutVolumeMult, countFunnel: false }))
        }
      }
    }
    for (const account of accounts) {
      const variant = account.run.variant ? RULEBOOK.variants[account.run.variant] : null
      if (variant?.window === 'tuning' && day > period.tuningEnd) continue // holdout stays untouched
      if (variant?.window === 'holdout' && day < period.holdoutStart) continue // one-shot holdout test
      const own = account.run.variant === 'E' ? [...frames.filter((frame) => frame.version === 'S'), ...framesE]
        : account.run.variant === 'F' ? framesF : frames
      account.simulateDay(day, own)
    }
    const summary = accounts.map((account) => `${account.run.id} $${account.equity.toFixed(0)} (${account.trades.length})`).join(' · ')
    console.log(`[rulebook] ${day} (${dayIndex + 1}/${ref.periodDays.length}) S ${frames.filter((frame) => frame.version === 'S').length} / SP ${frames.filter((frame) => frame.version === 'SP').length} symbols · ${summary}`)
  }

  const generatedAt = new Date().toISOString()
  let sourceCommit = 'unknown'
  try { sourceCommit = execSync('git rev-parse --short HEAD').toString().trim() } catch { /* not a git checkout */ }
  const tradesByRun = new Map<string, TradeRecord[]>(accounts.map((account) => [account.run.id, account.trades]))
  const reports = accounts.map((account) => buildRunReport(account.run, account.trades, account.equityByDay, account.stats, period))
  for (const run of runs.filter((item) => item.swing)) {
    const swing = await runSwing(ref, { start: from, end: to }, run.id)
    console.log(`[swing] signals ${swing.stats.signals}, outside universe ${swing.stats.notInUniverse}, room-blocked ${swing.stats.roomBlocked}, filled ${swing.stats.filled}, slots full ${swing.stats.slotsFull}, open-risk cap ${swing.stats.riskCap}, cash cap ${swing.stats.cashCap}`)
    tradesByRun.set(run.id, swing.trades)
    reports.push(buildRunReport(run, swing.trades, swing.equityByDay, swing.stats, period))
  }
  const funnel = { S: sFunnel, SP: spFunnel }
  const meta = { generatedAt, sourceCommit, tradingDays: ref.periodDays.length, notes: NOTES, period: { start: from, end: to }, apiStats, funnel }
  for (const [version, counts] of Object.entries(funnel)) {
    console.log(`[rulebook] ${version} funnel:`)
    for (const [key, value] of Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))) console.log(`    ${key.padEnd(48)} ${value}`)
  }
  for (const account of accounts) console.log(`[rulebook] run ${account.run.id} skipped: ${JSON.stringify(account.stats.skipped)}`)
  writeOutputs(out, reports, tradesByRun, meta)
  writeRoomDiagnostic(out)
  console.log(`[rulebook] wrote ${out}/report.html, summary.json, trades.csv (+ run-*/ folders)`)
  for (const report of reports) {
    const m = report.full.metrics
    if (report.window) {
      const w = report.window === 'tuning' ? report.tuning : report.holdout
      const t = w.metrics
      console.log(`[rulebook] run ${report.id} (${report.window} window only): ${t.trades} trades, win ${t.winRate == null ? 'n/a' : (t.winRate * 100).toFixed(0)}%, expectancy ${t.expectancyR?.toFixed(2) ?? 'n/a'}R, PF ${t.profitFactor?.toFixed(2) ?? 'n/a'}, max DD ${t.maxDrawdownR.toFixed(1)}R, final $${t.finalEquity.toFixed(2)} · ${report.window} ${w.pass ? 'PASS' : 'FAIL'}`)
      continue
    }
    const h = report.holdout.metrics
    console.log(`[rulebook] run ${report.id}: ${m.trades} trades, win ${m.winRate == null ? 'n/a' : (m.winRate * 100).toFixed(0)}%, expectancy ${m.expectancyR?.toFixed(2) ?? 'n/a'}R, PF ${m.profitFactor?.toFixed(2) ?? 'n/a'}, max DD ${m.maxDrawdownR.toFixed(1)}R, final $${m.finalEquity.toFixed(2)} · full ${report.full.pass ? 'PASS' : 'FAIL'} / tuning ${report.tuning.pass ? 'PASS' : 'FAIL'} / holdout ${report.holdout.pass ? 'PASS' : 'FAIL'} (holdout: ${h.trades} trades, ${h.expectancyR?.toFixed(2) ?? 'n/a'}R, PF ${h.profitFactor?.toFixed(2) ?? 'n/a'})`)
  }
  if (args.get('upload') === 'true') await uploadRulebook(out, args.get('label') ?? 'rulebook-s-sp')
}

// Room diagnostic: every signal the room-to-resistance rule blocked, with the nearest level and its type.
function writeRoomDiagnostic(out: string) {
  const rows = roomLog
  const header = 'version,day,time_et,ticker,setup,entry,stop,nearest_level,level_type,room_r,needed_r,other_blockers'
  const csv = [header, ...rows.map((row) => [row.version, row.day, et(row.time), row.ticker, row.setup, row.entry.toFixed(4), row.stop.toFixed(4),
    row.level === Infinity ? '' : row.level.toFixed(4), row.type, row.roomR === Infinity ? 'inf' : row.roomR.toFixed(2), row.minRoomR, `"${row.otherBlockers}"`].join(','))].join('\n') + '\n'
  writeFileSync(join(out, 'room-blocked.csv'), csv)
  for (const version of ['S', 'SP']) {
    const list = rows.filter((row) => row.version === version)
    const onlyRoom = list.filter((row) => !row.otherBlockers)
    const byType = new Map<string, [number, number]>()
    for (const row of list) {
      const entry = byType.get(row.type) ?? [0, 0]
      entry[0] += 1
      if (!row.otherBlockers) entry[1] += 1
      byType.set(row.type, entry)
    }
    console.log(`[rulebook] ${version} room-blocked signals: ${list.length} (${onlyRoom.length} blocked by room alone) - nearest resistance type:`)
    for (const [type, [all, alone]] of [...byType.entries()].sort((left, right) => right[1][0] - left[1][0])) console.log(`    ${type.padEnd(40)} ${String(all).padStart(5)}  (room alone: ${alone})`)
    const examples = (onlyRoom.length >= 5 ? onlyRoom : list)
    const step = Math.max(1, Math.floor(examples.length / 5))
    for (let index = 0; index < examples.length && index < step * 5; index += step) {
      const row = examples[index]
      console.log(`    e.g. ${row.ticker} ${et(row.time)} setup ${row.setup} entry ${row.entry.toFixed(2)} stop ${row.stop.toFixed(2)} → ${row.type} ${row.level.toFixed(2)} (${row.roomR.toFixed(2)}R < ${row.minRoomR}R)${row.otherBlockers ? ` [also: ${row.otherBlockers}]` : ''}`)
    }
  }
}

main().catch((error) => {
  console.error('[rulebook] failed', error)
  console.error('[rulebook] everything downloaded so far is cached - rerun the same command and it will fast-forward to where it stopped')
  process.exitCode = 1
})
