import { join } from 'node:path'
import { strategyGuardrails } from '../../lib/strategy'
import { elliottWaveConfig } from '../../lib/elliott-wave-config'
import { apiStats, flushQuoteCache, HISTORICAL_FEED, setCacheOnly } from './data'
import { loadDay, prefetchDay, TOP_GAINERS } from './market'
import { writeReport } from './report'
import { createRunState, DEFAULT_SLIPPAGE_OVER5, DEFAULT_SLIPPAGE_SUB5, LIQUIDITY_CAP_FRACTION, simulateDay, type RunSpec } from './simulate'
import { buildUniverse } from './universe'
import { ruleVariantSpecs } from './variants'

const args = new Map<string, string>()
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.replace(/^--/, '').split('=')
  args.set(key, value ?? 'true')
}

const PERIOD_START = args.get('from') ?? '2026-04-08'
const PERIOD_END = args.get('to') ?? '2026-10-07'
const OUTPUT_DIR = join(process.cwd(), args.get('out') ?? 'backtests/2026-10-6m')
const cacheOnly = args.get('cache-only') === 'true'
const maxDays = Number(args.get('days') ?? Infinity)

function assertOutsideMarketHours() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const minute = Number(value('hour')) * 60 + Number(value('minute'))
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(value('weekday'))
  if (weekday && minute >= 7 * 60 && minute < 16 * 60) {
    throw new Error('Refusing to call Alpaca between 07:00 and 16:00 ET on a weekday so the backtest never competes with the live scanner. Rerun after 16:00 ET, or pass --cache-only to use cached data only.')
  }
}

const specs: RunSpec[] = [
  { id: 'A', strategy: 'A', slippageMultiplier: 1, label: 'A. Current rule' },
  { id: 'B', strategy: 'B', slippageMultiplier: 1, label: 'B. Current rule + wave-5 exhaustion filter' },
  { id: 'C', strategy: 'C', slippageMultiplier: 1, label: 'C. Elliott wave 3 entry' },
  { id: 'D', strategy: 'D', slippageMultiplier: 1, label: 'D. Elliott wave 4 re-entry' },
  { id: 'A-x2', strategy: 'A', slippageMultiplier: 2, label: 'A at 2x slippage' },
  { id: 'A-x3', strategy: 'A', slippageMultiplier: 3, label: 'A at 3x slippage' },
  { id: 'C-x2', strategy: 'C', slippageMultiplier: 2, label: 'C at 2x slippage' },
  { id: 'C-x3', strategy: 'C', slippageMultiplier: 3, label: 'C at 3x slippage' },
]

async function main() {
  const startedAt = Date.now()
  if (cacheOnly) setCacheOnly(true)
  else assertOutsideMarketHours()

  const universe = await buildUniverse({ historyStart: '2026-02-10', end: PERIOD_END, periodStart: PERIOD_START })
  // --sim-from/--sim-to narrow the simulated days while keeping the full-period universe (and its bar cache) intact.
  const simFrom = args.get('sim-from') ?? PERIOD_START
  const simTo = args.get('sim-to') ?? PERIOD_END
  const days = universe.tradingDays.filter((day) => day >= simFrom && day <= simTo).slice(0, maxDays)
  console.log(`[backtest] ${universe.symbols.length} symbols (${universe.delisted.size} inactive/delisted), ${days.length} trading days ${days[0]}..${days.at(-1)}`)

  if (!cacheOnly) {
    let next = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < days.length) {
        const day = days[next++]
        await prefetchDay(universe, day)
      }
    }))
    console.log(`[backtest] minute bars cached in ${Math.round((Date.now() - startedAt) / 1000)}s, Alpaca calls so far ${apiStats.alpaca}`)
  }

  const selected = args.get('runs')?.split(',')
  const allSpecs = [...specs, ...ruleVariantSpecs]
  const runs = (selected ? allSpecs.filter((spec) => selected.includes(spec.id)) : specs).map(createRunState)
  if (!runs.length) throw new Error(`No runs matched --runs=${args.get('runs')}`)
  let tracked = 0
  for (const [index, day] of days.entries()) {
    if (!cacheOnly) assertOutsideMarketHours()
    const market = await loadDay(universe, day)
    tracked += market.symbols.size
    const shared = { analyses: new Map() }
    for (const run of runs) await simulateDay(run, market, shared)
    flushQuoteCache()
    console.log(`[backtest] ${day} (${index + 1}/${days.length}) symbols=${market.symbols.size} ${runs.slice(0, 4).map((run) => `${run.spec.id}=$${run.equity.toFixed(0)}/${run.trades.length}`).join(' ')} calls=${apiStats.alpaca}`)
  }

  const runtimeSeconds = Math.round((Date.now() - startedAt) / 1000)
  const summary = writeReport({
    outputDir: OUTPUT_DIR,
    runs,
    meta: {
      period: { start: days[0], end: days.at(-1), tradingDays: days.length, session: '07:00-15:55 ET decisions, 15:55 flatten' },
      sourceCommit: process.env.BACKTEST_SOURCE_COMMIT ?? '925bdc9',
      feed: HISTORICAL_FEED,
      universe: { symbols: universe.symbols.length, inactiveOrDelisted: universe.delisted.size, averageSymbolsLoadedPerDay: Math.round(tracked / Math.max(1, days.length)) },
      assumptions: {
        topGainers: TOP_GAINERS,
        liquidityCapFraction: LIQUIDITY_CAP_FRACTION,
        defaultSlippageSub5: DEFAULT_SLIPPAGE_SUB5,
        defaultSlippageOver5: DEFAULT_SLIPPAGE_OVER5,
        guardrails: strategyGuardrails,
        elliott: { trackingWindowMinutes: elliottWaveConfig.trackingWindowMinutes, minimumConfidence: elliottWaveConfig.minimumConfidence },
      },
      api: { ...apiStats, runtimeSeconds, cacheOnly },
    },
    limitations: [
      'Float = current FMP float, not point-in-time. Stocks whose float grew after offerings may be wrongly excluded; stocks that later reverse-split may be wrongly included.',
      'Decisions run at 1-minute resolution (live scans every 15-30s). Each decision only sees bars that closed before that minute; entries fill at the next bar open.',
      'Spread comes from the latest historical NBBO quote at decision time (fetched only when every other entry gate passes). Exits reuse the entry half-spread as slippage because no exit quote is fetched. When no quote exists the entry is skipped, as live does.',
      'Top-25 gainer ranking is rebuilt from symbols whose daily high was at least 10% above the prior close, plus every float<=10M symbol up more than 2%. Symbols outside that set are assumed never to rank in the top 25. The Alpaca movers screener methodology is not public, so ranking may differ.',
      'changePercent uses the last closed 1-minute close vs the prior daily close. Live uses snapshot dailyBar.c, which in premarket can still be the previous session\'s bar.',
      'News uses Alpaca historical news created_at (published before the decision minute only). Timestamp accuracy for premarket wires is limited to what Alpaca recorded.',
      'Same-time RVOL uses the same 15-minute, 10-session, 22-calendar-day baseline and 10,000-share minimum as live (the task text mentioned 20 sessions; live code uses 10, and the backtest follows the live code).',
      'Halts are inferred from missing 1-minute bars; positions are held and filled at the first bar after the gap. LULD halts with prints can still appear as normal bars.',
      'A stop and target hit inside the same bar always resolve to the stop. A bar that opens through the stop fills at the open (gap).',
      'Shares are capped at 5% of the fill bar\'s volume. Very thin premarket bars can make positions smaller than live sizing.',
      'Daily-loss, cooldown, max-position, and exposure checks are re-implemented from the paper RPC contract (the RPC itself runs in Postgres and is not called).',
      'Elliott tracking eligibility skips the scanner spread check (no quote is fetched for every tracked minute); the spread is checked at entry instead.',
      'Corporate actions: bars are unadjusted (as live). A split during the period distorts the prior-close change for that one day.',
    ],
    adapterDifferences: [
      'Scanner (loadEnrichedCandidates) is rebuilt from historical bars: same filters, regime-based volume/dollar-volume/spread minimums, and the same catalyst regex. Network calls and snapshots are replaced by cached history.',
      'decideEntry, scoreCandidate, strategyRegime, simulatedMarginBuyingPower, and strategyGuardrails are imported unchanged from lib/strategy.ts.',
      'Strategy A/B stop/target levels come from paperExitLevels and the trigger test from paperExitReason (lib/paper-exits.ts), checked against bar low (stop) then bar high (target) instead of a single quote mark.',
      'Exit fills: stop fills at the stop price, target fills at max(target, open), and gaps fill at the open, all minus the slippage estimate. Live fills at bid*(1-0.05%). The live 0.05% slippage is replaced by the measured half-spread.',
      'Entry fill = next bar open + half spread (live: ask*(1+0.05%)). Stop/target are still fill -/+ ATR exactly as the worker sets them.',
      'Strategy B blocks an entry when getElliottAllowedUses(regime).exhaustionFilter and isWave5FilterActive(analyzeElliottWave(...)) are both true.',
      'Strategies C/D take entries from createElliottSignalDrafts (ew_wave3 / ew_wave4) with the live 45-minute tracking window and invalidation rules. Shares come from the draft (live calculateShares), then are capped by liquidity and exposure.',
      'C/D exits mirror advanceShadowOutcome: wave 3 sells half at T1, moves the stop to max(entry, latest swing low), ratchets it, and exits the rest at T2; wave 4 exits fully at T1. They are evaluated on bar low/high with the same stop-first rule.',
      'Strategies C and D run as standalone accounts that use the same position/exposure/daily-loss guardrails as A.',
    ],
  })
  console.log(JSON.stringify(summary.runs.map((run) => ({ id: run.id, trades: run.summary.trades, winRate: run.summary.winRate, expectancy: run.summary.expectancy, pf: run.summary.profitFactor, pnl: run.summary.totalPnl, ddPct: run.summary.maxDrawdownPct })), null, 2))
  console.log(`[backtest] done in ${runtimeSeconds}s; Alpaca calls=${apiStats.alpaca} cached=${apiStats.alpacaCached} fmp=${apiStats.fmp}`)
}

main().catch((error) => {
  console.error('[backtest] failed', error)
  process.exitCode = 1
})
