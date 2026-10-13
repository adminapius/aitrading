import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { scanConfig } from '../../lib/scan-config'
import { strategyGuardrails, strategyRegime } from '../../lib/strategy'
import { firstMiddaySignal, MIDDAY_VARIANTS, middayConfig, middayEntryLevels, middayShares, type MiddayBar, type MiddayVariant } from '../../lib/strategies/midday-momentum'
import { apiStats, CACHE_ROOT, flushQuoteCache, getLatestQuote, getMinuteBarsForDay, HISTORICAL_FEED, type RawBar } from './data'
import { daySymbolSets, easternMidnight, MINUTE, TOP_GAINERS } from './market'
import { buildUniverse } from './universe'

/**
 * Strategy M backtest: Alpaca SIP 1-minute bars + historical NBBO quotes, 11:00-15:30 ET entries, 15:55 flatten.
 * Usage: pnpm exec tsx scripts/backtest/strategy-m.ts [--cache-only] [--out=backtests/strategy-m]
 */

const args = new Map<string, string>()
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.replace(/^--/, '').split('=')
  args.set(key, value ?? 'true')
}
const OUTPUT_DIR = join(process.cwd(), args.get('out') ?? 'backtests/strategy-m')
const HISTORY_LOOKBACK_DAYS = 57
const BASE_SLIPPAGE = 0.0005
const LIQUIDITY_CAP_FRACTION = 0.05
const SESSION_OPEN_MINUTE = 9 * 60 + 30

// Segments line up with the universes already cached by scripts/backtest/run.ts so the SIP downloads are reused.
const PERIODS = {
  design: [
    { from: '2025-10-01', to: '2026-03-31' },
    { from: '2026-04-01', to: '2026-10-07' },
  ],
  holdout: [{ from: '2025-04-01', to: '2025-09-30' }],
} as const
type PeriodName = keyof typeof PERIODS

type ExitKind = 'stop' | 'gap' | 'target' | 'flatten'
type RunSpec = { id: string; label: string; variants: readonly MiddayVariant[]; slippageMultiplier: number }
type Trade = {
  run: string; period: PeriodName; date: string; symbol: string; variant: MiddayVariant
  entryAt: string; exitAt: string; entry: number; exit: number; shares: number; stop: number; target: number
  exitKind: ExitKind; pnl: number; r: number; spreadPct: number; reason: string
}
type Position = {
  symbol: string; variant: MiddayVariant; entryAt: number; entry: number; shares: number; stop: number; target: number
  risk: number; exitCost: number; spreadPct: number; reason: string
}
type RunState = { spec: RunSpec; equity: number; peak: number; maxDrawdownPct: number; trades: Trade[]; counters: Record<string, number> }

const specs: RunSpec[] = [
  ...MIDDAY_VARIANTS.map((variant) => ({ id: `M-${variant}`, label: `M ${variant}`, variants: [variant] as const, slippageMultiplier: 1 })),
  { id: 'M-all', label: 'M all variants combined', variants: MIDDAY_VARIANTS, slippageMultiplier: 1 },
  { id: 'M-all-x2', label: 'M combined at 2x slippage', variants: MIDDAY_VARIANTS, slippageMultiplier: 2 },
  { id: 'M-all-x3', label: 'M combined at 3x slippage', variants: MIDDAY_VARIANTS, slippageMultiplier: 3 },
]

function bump(state: RunState, key: string) {
  state.counters[key] = (state.counters[key] ?? 0) + 1
}

/** Union of every cached SIP minute batch for the day (cached by earlier runs under different float modes). */
function cachedMinuteDay(day: string) {
  const dir = join(CACHE_ROOT, 'minute', day)
  const out: Record<string, RawBar[]> = {}
  if (!existsSync(dir)) return out
  for (const file of readdirSync(dir)) {
    const batch = JSON.parse(gunzipSync(readFileSync(join(dir, file))).toString('utf8')) as Record<string, RawBar[]>
    for (const [symbol, bars] of Object.entries(batch)) if (!out[symbol]?.length) out[symbol] = bars
  }
  return out
}

type SymbolSession = { symbol: string; prevClose: number; all: MiddayBar[]; session: MiddayBar[]; cumVolume: number[]; byStart: Map<number, MiddayBar> }

async function loadSessions(universe: Awaited<ReturnType<typeof buildUniverse>>, day: string) {
  const { pool, prev } = daySymbolSets(universe, day)
  const midnight = easternMidnight(day)
  const raw = cachedMinuteDay(day)
  const missing = pool.filter((symbol) => !(symbol in raw))
  if (missing.length) {
    Object.assign(raw, await getMinuteBarsForDay(day, missing, new Date(midnight + 4 * 60 * MINUTE).toISOString(), new Date(midnight + 16 * 60 * MINUTE).toISOString()))
  }
  const sessions = new Map<string, SymbolSession>()
  for (const symbol of pool) {
    const info = prev.get(symbol)
    const list = raw[symbol]
    if (!info || !list?.length) continue
    const all = list.map((bar) => ({ t: Date.parse(bar.t), o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, vw: bar.vw }))
      .filter((bar) => bar.t >= midnight + 4 * 60 * MINUTE && bar.t < midnight + 16 * 60 * MINUTE)
      .sort((left, right) => left.t - right.t)
    const cumVolume: number[] = []
    let volume = 0
    for (const bar of all) cumVolume.push((volume += bar.v))
    sessions.set(symbol, {
      symbol,
      prevClose: info.prevClose,
      all,
      session: all.filter((bar) => bar.t >= midnight + SESSION_OPEN_MINUTE * MINUTE),
      cumVolume,
      byStart: new Map(all.map((bar) => [bar.t, bar])),
    })
  }
  return { midnight, sessions, missingFetched: missing.length }
}

function closedCount(bars: MiddayBar[], now: number) {
  let low = 0
  let high = bars.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (bars[mid].t <= now - MINUTE) low = mid + 1
    else high = mid
  }
  return low
}

async function simulateDay(state: RunState, period: PeriodName, day: string, midnight: number, sessions: Map<string, SymbolSession>) {
  const { spec } = state
  const positions: Position[] = []
  const cooldownUntil = new Map<string, number>()
  const dayStartEquity = state.equity
  let realizedToday = 0

  const close = (position: Position, kind: ExitKind, rawPrice: number, at: number) => {
    const exit = rawPrice * (1 - position.exitCost)
    const pnl = (exit - position.entry) * position.shares
    state.trades.push({
      run: spec.id, period, date: day, symbol: position.symbol, variant: position.variant,
      entryAt: new Date(position.entryAt).toISOString(), exitAt: new Date(at).toISOString(),
      entry: position.entry, exit, shares: position.shares, stop: position.stop, target: position.target,
      exitKind: kind, pnl, r: position.risk > 0 ? (exit - position.entry) / position.risk : 0, spreadPct: position.spreadPct, reason: position.reason,
    })
    realizedToday += pnl
    state.equity += pnl
    state.peak = Math.max(state.peak, state.equity)
    state.maxDrawdownPct = Math.max(state.maxDrawdownPct, ((state.peak - state.equity) / state.peak) * 100)
    cooldownUntil.set(position.symbol, at + strategyGuardrails.reentryCooldownMinutes * MINUTE)
    positions.splice(positions.indexOf(position), 1)
    bump(state, `exit_${kind}`)
  }

  for (let minute = SESSION_OPEN_MINUTE + 1; minute <= middayConfig.flattenMinute; minute += 1) {
    const now = midnight + minute * MINUTE

    for (const position of [...positions]) {
      const data = sessions.get(position.symbol)!
      const bar = data.byStart.get(now - MINUTE)
      if (bar && bar.t >= position.entryAt) {
        // A bar that opens through the stop is the first real trade after the gap (or LULD halt): fill there, not at the stop.
        if (bar.o <= position.stop) { close(position, 'gap', bar.o, bar.t); continue }
        if (bar.l <= position.stop) { close(position, 'stop', position.stop, bar.t + MINUTE); continue }
        if (bar.h >= position.target) { close(position, 'target', Math.max(position.target, bar.o), bar.t + MINUTE); continue }
      }
      if (minute === middayConfig.flattenMinute) {
        const last = data.all[closedCount(data.all, now) - 1]
        close(position, 'flatten', last && last.t >= position.entryAt ? last.c : position.entry, now)
      }
    }
    if (minute < middayConfig.entryStartMinute || minute >= middayConfig.entryEndMinute) continue

    const regime = strategyRegime(new Date(now))
    const exposure = positions.reduce((sum, position) => sum + position.entry * position.shares, 0)
    if (realizedToday <= -strategyGuardrails.maxDailyLossFraction * dayStartEquity) { bump(state, 'daily_loss_minutes'); continue }

    // Top gainers by last fresh 1-minute close vs prior close, with the regime's volume / dollar-volume floors.
    const ranked: Array<{ data: SymbolSession; change: number; count: number }> = []
    for (const data of sessions.values()) {
      const count = closedCount(data.all, now)
      if (!count) continue
      const bar = data.all[count - 1]
      if (bar.t !== now - MINUTE) continue
      const change = (bar.c / data.prevClose - 1) * 100
      const volume = data.cumVolume[count - 1]
      if (change < middayConfig.minChangePercent || bar.c < scanConfig.minPrice) continue
      if (volume < Math.max(scanConfig.minVolume, regime.volume) || volume * bar.c < regime.dollarVolume) continue
      ranked.push({ data, change, count })
    }
    ranked.sort((left, right) => right.change - left.change)

    for (const { data } of ranked.slice(0, TOP_GAINERS)) {
      if (positions.length >= strategyGuardrails.maxOpenPositions) break
      if (positions.some((position) => position.symbol === data.symbol)) continue
      if ((cooldownUntil.get(data.symbol) ?? 0) > now) continue
      const closed = data.session.slice(0, closedCount(data.session, now))
      const signal = firstMiddaySignal(spec.variants, closed, data.prevClose)
      if (!signal) continue
      bump(state, 'signals')
      // No fill during a halt: the next 1-minute bar must exist (a missing bar means no prints that minute).
      const fillBar = data.byStart.get(now)
      if (!fillBar) { bump(state, 'skip_no_fill_bar'); continue }
      const quote = await getLatestQuote(day, data.symbol, new Date(now), scanConfig.maxQuoteAgeSeconds)
      if (!quote || !(quote.bp > 0) || !(quote.ap >= quote.bp)) { bump(state, 'skip_no_quote'); continue }
      const mid = (quote.bp + quote.ap) / 2
      const spreadPct = ((quote.ap - quote.bp) / mid) * 100
      if (spreadPct > Math.min(scanConfig.maxSpreadPercent, regime.spread * 100)) { bump(state, 'skip_spread'); continue }
      const halfSpread = (quote.ap - quote.bp) / 2 / mid
      const extra = spec.slippageMultiplier - 1
      // Buy at the ask (or the fill bar's open plus half-spread if the market moved up), plus slippage.
      const ask = Math.max(quote.ap, fillBar.o * (1 + halfSpread)) * (1 + halfSpread * extra)
      const levels = middayEntryLevels(signal, ask, BASE_SLIPPAGE * spec.slippageMultiplier)
      const room = Math.max(0, state.equity * strategyGuardrails.maxAggregateExposureFraction - exposure)
      const shares = Math.min(middayShares(state.equity, levels.fill, signal.riskPerShare), Math.floor(room / levels.fill), Math.floor(fillBar.v * LIQUIDITY_CAP_FRACTION))
      if (shares < 1) { bump(state, 'skip_size'); continue }
      positions.push({
        symbol: data.symbol, variant: signal.variant, entryAt: fillBar.t, entry: levels.fill, shares,
        stop: levels.stop, target: levels.target, risk: signal.riskPerShare,
        // Sell at the bid: every exit pays the entry half-spread plus slippage.
        exitCost: halfSpread * spec.slippageMultiplier + BASE_SLIPPAGE * spec.slippageMultiplier,
        spreadPct, reason: signal.reason,
      })
      bump(state, 'entries')
    }
  }
}

function summarize(trades: Trade[], maxDrawdownPct: number) {
  const wins = trades.filter((trade) => trade.pnl > 0)
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0)
  const grossLoss = -trades.filter((trade) => trade.pnl <= 0).reduce((sum, trade) => sum + trade.pnl, 0)
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0)
  return {
    trades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    avgR: trades.length ? trades.reduce((sum, trade) => sum + trade.r, 0) / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    pnl,
    maxDrawdownPct,
  }
}

function byMonth(trades: Trade[]) {
  const months = new Map<string, { trades: number; pnl: number }>()
  for (const trade of trades) {
    const key = trade.date.slice(0, 7)
    const entry = months.get(key) ?? { trades: 0, pnl: 0 }
    entry.trades += 1
    entry.pnl += trade.pnl
    months.set(key, entry)
  }
  return Object.fromEntries([...months.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

async function runPeriod(period: PeriodName) {
  const runs: RunState[] = specs.map((spec) => ({ spec, equity: middayConfig.startingEquity, peak: middayConfig.startingEquity, maxDrawdownPct: 0, trades: [], counters: {} }))
  let fetched = 0
  let days = 0
  for (const segment of PERIODS[period]) {
    const historyStart = new Date(Date.parse(`${segment.from}T00:00:00Z`) - HISTORY_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10)
    const universe = await buildUniverse({ historyStart, end: segment.to, periodStart: segment.from })
    for (const day of universe.tradingDays) {
      const { midnight, sessions, missingFetched } = await loadSessions(universe, day)
      fetched += missingFetched
      days += 1
      for (const run of runs) await simulateDay(run, period, day, midnight, sessions)
      flushQuoteCache()
      console.log(`[strategy-m] ${period} ${day} symbols=${sessions.size} ${runs.slice(0, 4).map((run) => `${run.spec.id}=$${run.equity.toFixed(0)}/${run.trades.length}`).join(' ')} alpaca=${apiStats.alpaca}`)
    }
  }
  return {
    period,
    tradingDays: days,
    poolSymbolsFetched: fetched,
    runs: runs.map((run) => ({ id: run.spec.id, label: run.spec.label, summary: summarize(run.trades, run.maxDrawdownPct), byMonth: byMonth(run.trades), byVariant: Object.fromEntries(MIDDAY_VARIANTS.map((variant) => [variant, summarize(run.trades.filter((trade) => trade.variant === variant), NaN)])), counters: run.counters, trades: run.trades })),
  }
}

async function main() {
  if (args.get('cache-only') === 'true') (await import('./data')).setCacheOnly(true)
  mkdirSync(OUTPUT_DIR, { recursive: true })
  const selected = (args.get('periods') ?? 'holdout,design').split(',') as PeriodName[]
  for (const period of selected) {
    const result = await runPeriod(period)
    writeFileSync(join(OUTPUT_DIR, `${period}.json`), `${JSON.stringify({ feed: HISTORICAL_FEED, config: middayConfig, api: apiStats, ...result }, null, 2)}\n`)
    console.log(JSON.stringify(result.runs.map((run) => ({ id: run.id, ...run.summary })), null, 2))
  }
  console.log(`[strategy-m] done; Alpaca calls=${apiStats.alpaca} cached=${apiStats.alpacaCached} retries=${apiStats.retries}`)
}

main().catch((error) => {
  console.error('[strategy-m] failed', error)
  process.exitCode = 1
})
