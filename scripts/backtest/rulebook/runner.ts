// "SP-Runner" (premarket news runner) research - BACKTEST ONLY, cached data.
//
//   Step 1 (fact check, no trades):  npx tsx scripts/backtest/rulebook/runner.ts --step=1 --out=backtests/sp-runner
//   Step 2 (SP-Runner rules):        npx tsx scripts/backtest/rulebook/runner.ts --step=2 --out=backtests/sp-runner [--upload]
//
// Period: RULEBOOK.period (Oct 14, 2024 - Oct 13, 2026); tuning and holdout reported separately.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { easternMidnight } from '../market'
import { RULEBOOK } from './config'
import { minuteIn, minuteMaps } from './common'
import { baselineCumulative, fifteenVolumes, getDayBars, loadReference, newsBetween, priorDays, setFifteenWindow, strategySPCandidates, MINUTE } from './data'
import { aggregate, atr, sessionVwap, type Bar } from './indicators'
import { buildRunReport, et, writeOutputs } from './report'
import { runScanner, type ScanSymbol } from './strategy-sp'
import type { TradeRecord } from './engine'
import { uploadRulebook } from './upload'

const SP = RULEBOOK.SP
export const RUNNER = {
  factWindowStart: 7 * 60, // a "scanner day" qualifies at any minute 7:00-9:29
  factWindowEnd: 9 * 60 + 30,
  refStart: 8 * 60 + 30, // reference = first 1-min close above VWAP between 8:30 and 9:00
  refEnd: 9 * 60,
  thresholds: [0.2, 0.3, 0.5],
  fadeMinute: 15 * 60 + 30,
  // Step 2 rules (Jose, Oct 15, 2026)
  scanStart: 7 * 60,
  scanEnd: 8 * 60 + 30,
  entryStart: 8 * 60 + 30,
  entryEnd: 9 * 60 + 15,
  baseStart: 7 * 60, // premarket base = lowest low 7:00-8:29
  pullbackLookback: 10, // pullback: within the last 10 bars a bar traded down to VWAP (low ≤ VWAP)
  stopBufferAtr: 0.25,
  maxStopPct: 0.2,
  risk: 0.005,
  addStart: 9 * 60 + 30,
  addEnd: 9 * 60 + 45,
  trailStart: 9 * 60 + 45,
  sellersStart: 10 * 60,
  sellersEnd: 11 * 60 + 30,
  sellersBars: 5,
  hardExit: 11 * 60 + 30,
  // Step 2b (Jose, Oct 16, 2026): fixed bracket, declared before seeing any results. No changes after.
  bracket: { entryEnd: 9 * 60, stopPct: 0.1, targetPct: 0.2, timeExit: 11 * 60 + 30 },
}

function parseArgs() {
  return new Map(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || 'true'] as const }))
}
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

type DayInput = { symbol: string; prevClose: number; bars: Bar[]; prior: Bar[]; newsTimes: number[]; eligible: Uint8Array }

async function loadDay(ref: Awaited<ReturnType<typeof loadReference>>, day: string): Promise<DayInput[]> {
  const midnight = easternMidnight(day)
  const prevDay = priorDays(ref, day, 1).at(-1) ?? null
  const candidates = strategySPCandidates(ref, day)
  const symbols = candidates.map((entry) => entry.symbol)
  const today = await getDayBars(day, symbols)
  const prior = prevDay ? await getDayBars(prevDay, symbols) : new Map<string, Bar[]>()
  const newsStart = prevDay ? easternMidnight(prevDay) + 16 * 60 * MINUTE : midnight
  const news = await newsBetween(day, symbols, newsStart, midnight + 16 * 60 * MINUTE)
  const baselineSessions = priorDays(ref, day, SP.scanner.rvolSessions)
  const scanInputs: ScanSymbol[] = []
  for (const entry of candidates) {
    const bars = today.get(entry.symbol) ?? []
    if (!bars.length) continue
    const volumes = await fifteenVolumes(entry.symbol)
    const withData = baselineSessions.filter((session) => volumes.has(session))
    scanInputs.push({ symbol: entry.symbol, prevClose: entry.prevClose, midnight, todayBars: bars, newsTimes: (news.get(entry.symbol) ?? []).map((item) => item.at),
      baselineAt: (minute) => (withData.length ? baselineCumulative(volumes, baselineSessions, minute) : 0) })
  }
  const scanner = runScanner(scanInputs)
  return scanInputs.map((input) => ({ symbol: input.symbol, prevClose: input.prevClose, bars: input.todayBars, prior: prior.get(input.symbol) ?? [], newsTimes: input.newsTimes, eligible: scanner.get(input.symbol)!.eligible }))
}

// ---------------- Step 1: fact check ----------------
type FactRow = { day: string; symbol: string; hodMinute: number; hod: number; ref: number | null; refMinute: number | null; gainPct: number | null; shakeoutPct: number | null; fadePct: number | null }

function factCheck(day: string, input: DayInput, midnight: number): FactRow | null {
  const { byMinute } = minuteMaps(input.bars, midnight)
  // Qualifies: at some minute 7:00-9:29 the last price is $1-$10, gap 20-50%, news already out (float < 10M from the daily list).
  let qualifies = false
  let last = Number.NaN
  for (let m = 4 * 60; m < RUNNER.factWindowEnd && !qualifies; m += 1) {
    const bar = byMinute[m]
    if (bar) last = bar.c
    if (m < RUNNER.factWindowStart || !Number.isFinite(last)) continue
    const gap = last / input.prevClose - 1
    const newsOut = input.newsTimes.some((at) => at <= midnight + (m + 1) * MINUTE)
    if (last >= SP.scanner.minPrice && last <= SP.scanner.maxPrice && gap >= SP.scanner.minGap && gap <= SP.scanner.maxGap && newsOut) qualifies = true
  }
  if (!qualifies) return null
  let hod = -Infinity
  let hodMinute = -1
  for (const bar of input.bars) if (bar.h > hod) { hod = bar.h; hodMinute = minuteIn(midnight, bar.t) }
  const vwap = sessionVwap(input.bars, () => day, () => true)
  let refIndex = -1
  for (let i = 0; i < input.bars.length; i += 1) {
    const m = minuteIn(midnight, input.bars[i].t)
    if (m >= RUNNER.refStart && m < RUNNER.refEnd && vwap[i] != null && input.bars[i].c > vwap[i]!) { refIndex = i; break }
  }
  const fadeBar = input.bars.filter((bar) => minuteIn(midnight, bar.t) <= RUNNER.fadeMinute).at(-1)
  const fadePct = fadeBar ? 1 - fadeBar.c / hod : null
  if (refIndex < 0) return { day, symbol: input.symbol, hodMinute, hod, ref: null, refMinute: null, gainPct: null, shakeoutPct: null, fadePct }
  const ref = input.bars[refIndex].c
  let postHigh = -Infinity
  let postHighIndex = refIndex
  for (let i = refIndex + 1; i < input.bars.length; i += 1) if (input.bars[i].h > postHigh) { postHigh = input.bars[i].h; postHighIndex = i }
  let low = Infinity
  for (let i = refIndex + 1; i <= postHighIndex; i += 1) low = Math.min(low, input.bars[i].l)
  return { day, symbol: input.symbol, hodMinute, hod, ref, refMinute: minuteIn(midnight, input.bars[refIndex].t),
    gainPct: Number.isFinite(postHigh) ? postHigh / ref - 1 : 0, shakeoutPct: Number.isFinite(low) ? Math.min(0, low / ref - 1) : 0, fadePct }
}

function quantile(values: number[], q: number) {
  if (!values.length) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]
}

function printFacts(rows: FactRow[], out: string) {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`
  const label = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  console.log(`[runner] STEP 1 - ${rows.length} SP scanner days (gap 20-50%, float < 10M, news, $1-$10 at some minute 7:00-9:29)`)
  console.log('[runner] Time of the day\'s high (15-min buckets):')
  const before = rows.filter((row) => row.hodMinute < 7 * 60).length
  console.log(`    before 07:00   ${String(before).padStart(5)}  ${pct(before / rows.length)}`)
  for (let start = 7 * 60; start < 16 * 60; start += 15) {
    const count = rows.filter((row) => row.hodMinute >= start && row.hodMinute < start + 15).length
    console.log(`    ${label(start)}-${label(start + 15)}  ${String(count).padStart(5)}  ${pct(count / rows.length)}  ${'#'.repeat(Math.round((count / rows.length) * 100))}`)
  }
  const cluster = rows.filter((row) => row.hodMinute >= 9 * 60 + 30 && row.hodMinute < 11 * 60).length
  const premarket = rows.filter((row) => row.hodMinute < 9 * 60 + 30).length
  console.log(`    => high made 9:30-11:00 on ${pct(cluster / rows.length)} of days; before 9:30 on ${pct(premarket / rows.length)}; after 11:00 on ${pct(1 - (cluster + premarket) / rows.length)}`)
  const withRef = rows.filter((row) => row.ref != null)
  console.log(`[runner] From the first 8:30-9:00 1-min close above VWAP (${withRef.length} of ${rows.length} days had one):`)
  for (const threshold of RUNNER.thresholds) {
    const reached = withRef.filter((row) => (row.gainPct ?? 0) >= threshold)
    const shake = reached.map((row) => row.shakeoutPct ?? 0)
    console.log(`    reached +${(threshold * 100).toFixed(0)}%: ${reached.length} (${pct(reached.length / Math.max(withRef.length, 1))}) - shakeout before the high: median ${pct(quantile(shake, 0.5))}, worst quarter ${pct(quantile(shake, 0.25))}, worst ${pct(quantile(shake, 0))}`)
  }
  const gains = withRef.map((row) => row.gainPct ?? 0)
  const shakeAll = withRef.map((row) => row.shakeoutPct ?? 0)
  console.log(`    max gain after the reference: median ${pct(quantile(gains, 0.5))}, top quarter ${pct(quantile(gains, 0.75))}`)
  console.log(`    drawdown before that high (all days): median ${pct(quantile(shakeAll, 0.5))}, worst quarter ${pct(quantile(shakeAll, 0.25))}`)
  const fades = rows.map((row) => row.fadePct).filter((value): value is number => value != null)
  console.log(`[runner] Fall from the day's high to 15:30: median ${pct(quantile(fades, 0.5))}, quartiles ${pct(quantile(fades, 0.25))} / ${pct(quantile(fades, 0.75))}`)
  mkdirSync(out, { recursive: true })
  const csv = ['day,symbol,hod_time,hod,ref_time,ref,gain_pct,shakeout_pct,fade_to_1530_pct',
    ...rows.map((row) => [row.day, row.symbol, label(row.hodMinute), row.hod.toFixed(4), row.refMinute == null ? '' : label(row.refMinute), row.ref?.toFixed(4) ?? '',
      row.gainPct == null ? '' : (row.gainPct * 100).toFixed(2), row.shakeoutPct == null ? '' : (row.shakeoutPct * 100).toFixed(2), row.fadePct == null ? '' : (row.fadePct * 100).toFixed(2)].join(','))].join('\n') + '\n'
  writeFileSync(join(out, 'step1-days.csv'), csv)
  console.log(`[runner] wrote ${join(out, 'step1-days.csv')}`)
}

// ---------------- Step 2: SP-Runner rules ----------------
type Signal = { symbol: string; minute: number; trigger: number; stop: number; baseLow: number; pmh: number | null; input: DayInput }

export function runnerSignal(input: DayInput, day: string, midnight: number, options: { entryEnd?: number; structuralStop?: boolean } = {}): Signal | null {
  const entryEnd = options.entryEnd ?? RUNNER.entryEnd
  const structuralStop = options.structuralStop !== false
  // Scanned 7:00-8:30 with the SP filters + news (top 3 included).
  let scanned = false
  for (let m = RUNNER.scanStart; m <= RUNNER.scanEnd; m += 1) if (input.eligible[m] === 1) { scanned = true; break }
  if (!scanned) return null
  const all = [...input.prior, ...input.bars]
  const five = aggregate(all, 5, (t) => (t >= midnight ? minuteIn(midnight, t) : minuteIn(midnight - 86_400_000, t)), (t) => (t >= midnight ? day : 'prior'))
  const atr5 = atr(five, SP.atrPeriod)
  const vwap = sessionVwap(input.bars, () => day, () => true)
  let baseLow = Infinity
  for (const bar of input.bars) {
    const m = minuteIn(midnight, bar.t)
    if (m >= RUNNER.baseStart && m < RUNNER.scanEnd) baseLow = Math.min(baseLow, bar.l)
  }
  if (!Number.isFinite(baseLow)) return null
  const premarket = input.bars.filter((bar) => minuteIn(midnight, bar.t) < SP.regularOpenMinute)
  const pmh = premarket.length ? Math.max(...premarket.map((bar) => bar.h)) : null
  for (let i = 1; i < input.bars.length; i += 1) {
    const bar = input.bars[i]
    const m = minuteIn(midnight, bar.t)
    if (m < RUNNER.entryStart) continue
    if (m >= entryEnd) break
    const v = vwap[i]
    if (v == null || !(bar.c > v) || !(input.bars[i - 1].c <= (vwap[i - 1] ?? Infinity))) continue // 1-min close back above VWAP
    let pullbackLow = Infinity
    let touched = false
    for (let k = Math.max(0, i - RUNNER.pullbackLookback); k < i; k += 1) {
      pullbackLow = Math.min(pullbackLow, input.bars[k].l)
      if (vwap[k] != null && input.bars[k].l <= vwap[k]!) touched = true
    }
    if (!touched || pullbackLow < baseLow) continue // pullback must reach VWAP and hold the premarket base
    const time = bar.t + MINUTE
    let k5 = -1
    for (let x = 0; x < five.length && five[x].end <= time; x += 1) k5 = x
    const range = k5 >= 0 ? atr5[k5] : null
    if (!structuralStop) return { symbol: input.symbol, minute: m + 1, trigger: bar.c, stop: Number.NaN, baseLow, pmh, input }
    if (range == null) continue
    const stop = Math.min(baseLow, pullbackLow) - RUNNER.stopBufferAtr * range
    if (!(stop < bar.c) || (bar.c - stop) / bar.c > RUNNER.maxStopPct) continue
    return { symbol: input.symbol, minute: m + 1, trigger: bar.c, stop, baseLow, pmh, input }
  }
  return null
}

export function simulateRunner(signal: Signal, day: string, midnight: number, riskDollars: number, equity: number, slipMult = 1) {
  const C = RULEBOOK.costs
  const slip = (m: number) => (m < SP.regularOpenMinute ? SP.slippagePremarket : SP.slippage) * slipMult
  const { byMinute, cumVolume } = minuteMaps(signal.input.bars, midnight)
  const vwap = sessionVwap(signal.input.bars, () => day, () => true)
  const vwapAt = new Map(signal.input.bars.map((bar, i) => [minuteIn(midnight, bar.t), vwap[i]]))
  const limit = signal.trigger * (1 + SP.entryLimitOffset)
  // Entry: approved fill model (trades through trigger → max(trigger, open) + slippage; no fill above the limit; 5 minutes).
  let entry: { price: number; minute: number; shares: number } | null = null
  for (let m = signal.minute; m < signal.minute + RULEBOOK.fills.entryValidMinutes; m += 1) {
    const bar = byMinute[m]
    if (!bar || bar.h < signal.trigger) continue
    const price = Math.max(signal.trigger, bar.o)
    if (price > limit) continue
    const fill = price * (1 + slip(m))
    let shares = Math.floor(riskDollars / (fill - signal.stop) + 1e-9)
    shares = Math.min(shares, Math.floor(equity / fill), Math.floor(RULEBOOK.account.maxShareOfDayVolume * cumVolume[signal.minute - 1]))
    if (shares < 1 || shares * (fill - signal.stop) < RULEBOOK.account.minRiskFractionAfterCaps * riskDollars) return { skip: 'caps-below-half-R' as const }
    if (shares > C.rejectFillAboveBarVolumeShare * bar.v) return { skip: 'fill > 10% of bar volume' as const }
    entry = { price: fill, minute: m, shares }
    break
  }
  if (!entry) return { skip: 'not filled' as const }
  let shares = entry.shares
  let cost = entry.price * shares
  let stop = signal.stop
  const riskPerShare = entry.price - signal.stop
  const initialRisk = shares * riskPerShare
  let added = 0
  let pending: string | null = null
  let maxHigh = entry.price
  let minLow = entry.price
  const partials: string[] = []
  // 5-min bars for the trail / VWAP closes (today only).
  const five = aggregate(signal.input.bars, 5, (t) => minuteIn(midnight, t), () => day)
  const fiveEnds = new Map(five.map((bar, i) => [minuteIn(midnight, bar.end), i]))
  let exit: { price: number; minute: number; reason: string } | null = null
  const entryBar = byMinute[entry.minute]!
  if (entryBar.c <= stop) exit = { price: stop * (1 - slip(entry.minute)), minute: entry.minute + 1, reason: 'stop' }
  for (let m = entry.minute + 1; m < 16 * 60 && !exit; m += 1) {
    const bar = byMinute[m]
    if (bar) {
      if (m >= RUNNER.hardExit) { exit = { price: bar.o * (1 - slip(m)), minute: m, reason: 'hard-exit-11:30' }; break }
      if (pending) { exit = { price: bar.o * (1 - slip(m)), minute: m, reason: pending }; break }
      const stopReason = stop > signal.stop + 1e-9 ? 'trail-stop' : 'stop'
      if (bar.o <= stop) { exit = { price: bar.o * (1 - slip(m)), minute: m, reason: `gap-${stopReason}` }; break }
      if (bar.l <= stop) { exit = { price: stop * (1 - slip(m)), minute: m + 1, reason: stopReason }; break }
      maxHigh = Math.max(maxHigh, bar.h)
      minLow = Math.min(minLow, bar.l)
      // Add: 9:30-9:45 only, 1-min close above the premarket high, same 0.5% risk to the current stop.
      if (!added && signal.pmh != null && m >= RUNNER.addStart && m < RUNNER.addEnd && bar.c > signal.pmh && byMinute[m - 1] && byMinute[m - 1]!.c <= signal.pmh) {
        const next = byMinute[m + 1]
        if (next && next.h >= bar.c) {
          const price = Math.max(bar.c, next.o)
          if (price <= bar.c * (1 + SP.entryLimitOffset)) {
            const fill = price * (1 + slip(m + 1))
            let addShares = Math.floor(riskDollars / (fill - stop) + 1e-9)
            addShares = Math.min(addShares, Math.floor((equity - cost) / fill), Math.floor(RULEBOOK.account.maxShareOfDayVolume * cumVolume[m]) - shares)
            if (addShares >= 1 && addShares <= C.rejectFillAboveBarVolumeShare * next.v) {
              shares += addShares
              cost += addShares * fill
              added = addShares
              partials.push(`add ${addShares}@${fill.toFixed(4)}`)
            }
          }
        }
      }
      // b) 10:00-11:30 sellers take over (1-min): lower high + lower low with red volume > green volume over the last 5 bars.
      if (m >= RUNNER.sellersStart && m < RUNNER.sellersEnd) {
        const prev = byMinute[m - 1]
        if (prev && bar.h < prev.h && bar.l < prev.l) {
          let red = 0
          let green = 0
          for (let k = m - RUNNER.sellersBars + 1; k <= m; k += 1) {
            const item = byMinute[k]
            if (!item) continue
            if (item.c < item.o) red += item.v
            else if (item.c > item.o) green += item.v
          }
          if (red > green) pending = 'sellers-take-over'
        }
      }
    }
    // 5-min closes: a) after 9:45 trail under the last confirmed 5-min swing low; b) 10:00-11:30 5-min close below VWAP.
    const closedFive = fiveEnds.get(m + 1)
    if (closedFive != null) {
      const fiveBar = five[closedFive]
      if (m + 1 > RUNNER.trailStart && closedFive >= 2) {
        for (let k = closedFive - 1; k >= 1; k -= 1) {
          if (five[k].l < five[k - 1].l && five[k].l < five[k + 1].l) {
            if (five[k].l > stop && five[k].l < fiveBar.c) stop = five[k].l
            break
          }
        }
      }
      const v = vwapAt.get(m)
      if (!pending && m + 1 > RUNNER.sellersStart && m + 1 <= RUNNER.sellersEnd && v != null && fiveBar.c < v) pending = '5m-close-below-vwap'
    }
  }
  if (!exit) {
    const last = signal.input.bars.at(-1)!
    exit = { price: last.c * (1 - slip(959)), minute: 960, reason: 'end-of-day' }
  }
  const proceeds = shares * exit.price
  const fees = proceeds * C.secFeePerDollar + Math.min(shares * C.finraTafPerShare, C.finraTafMaxPerTrade)
  const pnl = proceeds - cost - fees
  return {
    trade: {
      entryTime: midnight + entry.minute * MINUTE, entryPrice: entry.price, avgCost: cost / shares, shares: entry.shares, maxShares: shares, units: added ? 2 : 1,
      exitTime: midnight + exit.minute * MINUTE, exitPrice: exit.price, exitReason: exit.reason, partials: partials.join('; '), pnl, fees,
      rResult: pnl / initialRisk, riskDollars: initialRisk, stop: signal.stop, mfeR: (maxHigh - entry.price) / riskPerShare, maeR: (minLow - entry.price) / riskPerShare,
      holdMinutes: exit.minute - entry.minute,
    },
  }
}

// Step 2b: fixed bracket from the entry fill: stop -10%, target +20% (resting limit), time exit 11:30.
export function simulateBracket(signal: Signal, midnight: number, riskDollars: number, equity: number) {
  const C = RULEBOOK.costs
  const B = RUNNER.bracket
  const slip = (m: number) => (m < SP.regularOpenMinute ? SP.slippagePremarket : SP.slippage)
  const { byMinute, cumVolume } = minuteMaps(signal.input.bars, midnight)
  const limit = signal.trigger * (1 + SP.entryLimitOffset)
  let entry: { price: number; minute: number; shares: number } | null = null
  for (let m = signal.minute; m < signal.minute + RULEBOOK.fills.entryValidMinutes; m += 1) {
    const bar = byMinute[m]
    if (!bar || bar.h < signal.trigger) continue
    const price = Math.max(signal.trigger, bar.o)
    if (price > limit) continue
    const fill = price * (1 + slip(m))
    let shares = Math.floor(riskDollars / (fill * B.stopPct) + 1e-9)
    shares = Math.min(shares, Math.floor(equity / fill), Math.floor(RULEBOOK.account.maxShareOfDayVolume * cumVolume[signal.minute - 1]))
    if (shares < 1 || shares * fill * B.stopPct < RULEBOOK.account.minRiskFractionAfterCaps * riskDollars) return { skip: 'caps-below-half-R' as const }
    if (shares > C.rejectFillAboveBarVolumeShare * bar.v) return { skip: 'fill > 10% of bar volume' as const }
    entry = { price: fill, minute: m, shares }
    break
  }
  if (!entry) return { skip: 'not filled' as const }
  const stop = entry.price * (1 - B.stopPct)
  const target = entry.price * (1 + B.targetPct)
  let maxHigh = entry.price
  let minLow = entry.price
  let exit: { price: number; minute: number; reason: string } | null = null
  const entryBar = byMinute[entry.minute]!
  if (entryBar.c <= stop) exit = { price: stop * (1 - slip(entry.minute)), minute: entry.minute + 1, reason: 'stop' }
  for (let m = entry.minute + 1; m < 16 * 60 && !exit; m += 1) {
    const bar = byMinute[m]
    if (!bar) continue
    if (m >= B.timeExit) { exit = { price: bar.o * (1 - slip(m)), minute: m, reason: 'time-exit-11:30' }; break }
    if (bar.o <= stop) { exit = { price: bar.o * (1 - slip(m)), minute: m, reason: 'gap-stop' }; break }
    if (bar.o >= target) { exit = { price: bar.o, minute: m, reason: 'target' }; break }
    // Both inside one bar: the stop is assumed first (conservative).
    if (bar.l <= stop) { exit = { price: stop * (1 - slip(m)), minute: m + 1, reason: 'stop' }; break }
    if (bar.h >= target + RULEBOOK.fills.targetThroughTicks) { exit = { price: target, minute: m + 1, reason: 'target' }; break }
    maxHigh = Math.max(maxHigh, bar.h)
    minLow = Math.min(minLow, bar.l)
  }
  if (!exit) {
    const last = signal.input.bars.at(-1)!
    exit = { price: last.c * (1 - slip(959)), minute: 960, reason: 'time-exit-11:30' }
  }
  const riskPerShare = entry.price - stop
  const proceeds = entry.shares * exit.price
  const fees = proceeds * C.secFeePerDollar + Math.min(entry.shares * C.finraTafPerShare, C.finraTafMaxPerTrade)
  const pnl = proceeds - entry.shares * entry.price - fees
  return {
    trade: {
      entryTime: midnight + entry.minute * MINUTE, entryPrice: entry.price, avgCost: entry.price, shares: entry.shares, maxShares: entry.shares, units: 1,
      exitTime: midnight + exit.minute * MINUTE, exitPrice: exit.price, exitReason: exit.reason, partials: `target ${target.toFixed(4)}`, pnl, fees,
      rResult: pnl / (entry.shares * riskPerShare), riskDollars: entry.shares * riskPerShare, stop, mfeR: (maxHigh - entry.price) / riskPerShare, maeR: (minLow - entry.price) / riskPerShare,
      holdMinutes: exit.minute - entry.minute,
    },
  }
}

async function main() {
  const args = parseArgs()
  const step = args.get('step') ?? '1'
  const from = args.get('from') ?? RULEBOOK.period.start
  const to = args.get('to') ?? RULEBOOK.period.end
  const period = { ...RULEBOOK.period, start: from, end: to }
  const out = join(process.cwd(), args.get('out') ?? 'backtests/sp-runner')
  setFifteenWindow(addDays(from, -45), to)
  const ref = await loadReference(addDays(from, -420), from, to)
  const facts: FactRow[] = []
  const trades: TradeRecord[] = []
  const equityByDay: Array<{ day: string; equity: number }> = []
  const skipped: Record<string, number> = {}
  let equity: number = RULEBOOK.account.startingEquity
  for (const [index, day] of ref.periodDays.entries()) {
    const midnight = easternMidnight(day)
    const inputs = await loadDay(ref, day)
    if (step === '1') {
      for (const input of inputs) {
        const row = factCheck(day, input, midnight)
        if (row) facts.push(row)
      }
      if (index % 25 === 0) console.log(`[runner] ${day} (${index + 1}/${ref.periodDays.length}) scanner days so far: ${facts.length}`)
      continue
    }
    // Step 2: one position per day under $10k (small-account mode); earliest signal wins, ties by scanner gap.
    const bracket = step === '2b'
    const signals = inputs.map((input) => runnerSignal(input, day, midnight, bracket ? { entryEnd: RUNNER.bracket.entryEnd, structuralStop: false } : {})).filter((item): item is Signal => item != null)
      .sort((left, right) => left.minute - right.minute || left.symbol.localeCompare(right.symbol))
    const riskDollars = equity * RUNNER.risk
    for (const signal of signals) {
      const result = bracket ? simulateBracket(signal, midnight, riskDollars, equity) : simulateRunner(signal, day, midnight, riskDollars, equity)
      if ('skip' in result) { skipped[result.skip!] = (skipped[result.skip!] ?? 0) + 1; continue }
      const t = result.trade
      equity += t.pnl
      trades.push({ run: bracket ? 'SPR2B' : 'SPR', date: day, ticker: signal.symbol, version: 'SP', setup: bracket ? 'runner-bracket' : 'runner', entryIndex: 1, ...t, equityAfter: equity, roomR: Infinity,
        gapPct: signal.trigger / signal.input.prevClose - 1, rvol: null, note: `VWAP reclaim ${et(midnight + (signal.minute - 1) * MINUTE)}; base low ${signal.baseLow.toFixed(2)}` })
      break
    }
    equityByDay.push({ day, equity })
    if (index % 25 === 0) console.log(`[runner] ${day} (${index + 1}/${ref.periodDays.length}) trades ${trades.length}, equity $${equity.toFixed(0)}`)
  }
  if (step === '1') return printFacts(facts, out)
  const isBracket = step === '2b'
  const runId = isBracket ? 'SPR2B' : 'SPR'
  const run = isBracket
    ? { id: runId, label: 'SP-Runner Step 2b: top 3 by 8:30, VWAP reclaim 8:30-9:00, stop -10% / target +20%, time exit 11:30', versions: ['SP' as const], spSlippageMultiplier: 1 }
    : { id: runId, label: 'SP-Runner: premarket news runner (VWAP reclaim 8:30-9:15, exits by 11:30)', versions: ['SP' as const], spSlippageMultiplier: 1 }
  const report = buildRunReport(run, trades, equityByDay, { skipped }, period)
  const notes = isBracket ? [
    'Step 2b, declared before results (Oct 16, 2026): in the SP scanner top 3 at some minute 7:00-8:30 (so it qualifies before the entry); entry 8:30-9:00 on a 1-min close back above VWAP after a pullback to VWAP that held the premarket base (lowest low 7:00-8:29).',
    'Fixed bracket from the entry fill: stop -10% (approved stop fill model), target +20% (resting limit, filled once traded 1 cent through, or at the open if gapped above), time exit at the 11:30 open. Stop and target inside the same 1-min bar: stop assumed first.',
    '0.5% risk per trade (position about 5% of equity); one trade per day; fills, slippage (1% before 9:30, 0.5% after), fees, 10%-of-bar and 1%-of-day volume caps as in the rulebook backtest. No changes after this run.',
  ] : [
    'SP-Runner rules as specified Oct 15, 2026. Scan 7:00-8:30 with SP filters + news (top 3); entry 8:30-9:15 on a 1-min close back above VWAP after a pullback to VWAP that held the premarket base (lowest low 7:00-8:29).',
    'Stop below min(premarket base low, pullback low) - 0.25 ATR(5m), max 20% wide; 0.5% risk; never widened. No time stop, no breakeven before 9:45. One add 9:30-9:45 on a close above the premarket high.',
    'Exits: after 9:45 trail under the last 5-min swing low; 10:00-11:30 sellers take over (1-min lower high + lower low with red volume > green over 5 bars) or a 5-min close below VWAP; hard exit 11:30.',
    'Fills, slippage (1% premarket, 0.5% after), fees, 10%-of-bar and 1%-of-day volume caps as in the rulebook backtest. One trade per day (small-account mode).',
  ]
  const meta = { generatedAt: new Date().toISOString(), sourceCommit: 'sp-runner', tradingDays: ref.periodDays.length, notes }
  writeOutputs(out, [report], new Map([[runId, trades]]), meta)
  const line = (name: string, r: typeof report.full) => {
    const m = r.metrics
    console.log(`[runner] ${name}: ${m.trades} trades, win ${m.winRate == null ? 'n/a' : (m.winRate * 100).toFixed(0)}%, avg win ${m.avgWinR?.toFixed(2) ?? 'n/a'}R / avg loss ${m.avgLossR?.toFixed(2) ?? 'n/a'}R, expectancy ${m.expectancyR?.toFixed(2) ?? 'n/a'}R, PF ${m.profitFactor?.toFixed(2) ?? 'n/a'}, max DD ${m.maxDrawdownR.toFixed(1)}R · ${r.pass ? 'PASS' : 'FAIL'}`)
  }
  const name = isBracket ? 'Step 2b' : 'SP-Runner'
  line(`${name} full`, report.full)
  line(`${name} tuning`, report.tuning)
  line(`${name} holdout`, report.holdout)
  if (isBracket) {
    const groups: Array<[string, TradeRecord[]]> = [['tuning', trades.filter((t) => t.date <= period.tuningEnd)], ['holdout', trades.filter((t) => t.date >= period.holdoutStart)]]
    for (const [window, list] of groups) {
      for (const kind of ['target', 'stop', 'time-exit-11:30']) {
        const group = list.filter((t) => (kind === 'stop' ? t.exitReason === 'stop' || t.exitReason === 'gap-stop' : t.exitReason === kind))
        const avg = group.length ? group.reduce((sum, t) => sum + t.rResult, 0) / group.length : Number.NaN
        const wins = group.filter((t) => t.rResult > 0).length
        console.log(`[runner] ${window} ${kind === 'time-exit-11:30' ? 'neither hit -> time exit 11:30' : kind === 'stop' ? 'stop (incl. gap-stop)' : 'target +20%'}: ${group.length} trades, avg ${Number.isNaN(avg) ? 'n/a' : avg.toFixed(2)}R, ${group.length ? ((wins / group.length) * 100).toFixed(0) : 'n/a'}% positive`)
      }
    }
  }
  console.log(`[runner] skipped: ${JSON.stringify(skipped)} · exits: ${JSON.stringify(trades.reduce((acc, t) => ({ ...acc, [t.exitReason]: (acc[t.exitReason] ?? 0) + 1 }), {} as Record<string, number>))}`)
  console.log(`[runner] wrote ${out}/report.html, trades.csv`)
  if (args.get('upload') === 'true') await uploadRulebook(out, isBracket ? 'sp-runner-2b' : 'sp-runner')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[runner] failed', error)
    process.exitCode = 1
  })
}
