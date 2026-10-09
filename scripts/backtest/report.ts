import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STARTING_EQUITY, type RunState, type Trade } from './simulate'

export type Metrics = {
  trades: number
  winRate: number | null
  averageWin: number | null
  averageLoss: number | null
  averageR: number | null
  expectancy: number | null
  profitFactor: number | null
  totalPnl: number
  maxDrawdown: number
  maxDrawdownPct: number
  longestLosingStreak: number
  averageHoldMinutes: number | null
  exitMix: Record<'stop' | 'target' | 'flatten' | 'gap', number>
}

const round = (value: number | null, digits = 4) => value == null || !Number.isFinite(value) ? value : Number(value.toFixed(digits))

export function metrics(trades: Trade[], startEquity = STARTING_EQUITY): Metrics {
  const wins = trades.filter((trade) => trade.pnl > 0)
  const losses = trades.filter((trade) => trade.pnl <= 0)
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0))
  let equity = startEquity
  let peak = startEquity
  let maxDrawdown = 0
  let maxDrawdownPct = 0
  let streak = 0
  let longest = 0
  for (const trade of [...trades].sort((left, right) => left.exitAt.localeCompare(right.exitAt))) {
    equity += trade.pnl
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak : 0)
    streak = trade.pnl <= 0 ? streak + 1 : 0
    longest = Math.max(longest, streak)
  }
  const exitMix = { stop: 0, target: 0, flatten: 0, gap: 0 }
  for (const trade of trades) exitMix[trade.exitKind] += 1
  const share = (count: number) => trades.length ? round(count / trades.length)! : 0
  return {
    trades: trades.length,
    winRate: trades.length ? round(wins.length / trades.length) : null,
    averageWin: wins.length ? round(grossWin / wins.length, 2) : null,
    averageLoss: losses.length ? round(-grossLoss / losses.length, 2) : null,
    averageR: trades.length ? round(trades.reduce((sum, trade) => sum + trade.r, 0) / trades.length) : null,
    expectancy: trades.length ? round((grossWin - grossLoss) / trades.length, 2) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : wins.length ? null : null,
    totalPnl: round(grossWin - grossLoss, 2)!,
    maxDrawdown: round(maxDrawdown, 2)!,
    maxDrawdownPct: round(maxDrawdownPct)!,
    longestLosingStreak: longest,
    averageHoldMinutes: trades.length ? round(trades.reduce((sum, trade) => sum + trade.holdMinutes, 0) / trades.length, 1) : null,
    exitMix: { stop: share(exitMix.stop), target: share(exitMix.target), flatten: share(exitMix.flatten), gap: share(exitMix.gap) },
  }
}

function groupBy(trades: Trade[], key: (trade: Trade) => string) {
  const groups = new Map<string, Trade[]>()
  for (const trade of trades) groups.set(key(trade), [...(groups.get(key(trade)) ?? []), trade])
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, group]) => [name, metrics(group)]))
}

function describe(trade: Trade) {
  return {
    date: trade.date,
    symbol: trade.symbol,
    pnl: round(trade.pnl, 2),
    r: round(trade.r, 3),
    exitKind: trade.exitKind,
    regime: trade.regime,
    reason: `${trade.exitKind} after ${trade.holdMinutes}m in ${trade.regime}; entry ${trade.entryPrice.toFixed(4)} -> exit ${trade.exitPrice.toFixed(4)}${trade.liquidityCapped ? ' (liquidity-capped)' : ''}${trade.catalyst ? `; catalyst: ${trade.catalyst.slice(0, 120)}` : ''}`,
  }
}

const csvFields: Array<keyof Trade> = ['run', 'strategy', 'date', 'symbol', 'regime', 'rank', 'entryAt', 'entryPrice', 'shares', 'stop', 'target', 'exitAt', 'exitPrice', 'exitKind', 'pnl', 'r', 'holdMinutes', 'slippageFraction', 'spreadSource', 'liquidityCapped', 't1Hit', 'catalyst', 'reason']

function csvCell(value: unknown) {
  const text = value == null ? '' : typeof value === 'number' ? String(Number(value.toFixed(6))) : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function writeReport(input: { outputDir: string; runs: RunState[]; meta: Record<string, unknown>; limitations: string[]; adapterDifferences: string[] }) {
  mkdirSync(input.outputDir, { recursive: true })
  const allTrades = input.runs.flatMap((run) => run.trades)
  writeFileSync(join(input.outputDir, 'trades.csv'), [csvFields.join(','), ...allTrades.map((trade) => csvFields.map((field) => csvCell(trade[field])).join(','))].join('\n') + '\n')

  const runs = input.runs.map((run) => {
    const sorted = [...run.trades].sort((left, right) => right.pnl - left.pnl)
    return {
      id: run.spec.id,
      strategy: run.spec.strategy,
      label: run.spec.label,
      slippageMultiplier: run.spec.slippageMultiplier,
      endingEquity: round(run.equity, 2),
      returnPct: round(run.equity / STARTING_EQUITY - 1),
      summary: metrics(run.trades),
      monthly: groupBy(run.trades, (trade) => trade.date.slice(0, 7)),
      byRegime: groupBy(run.trades, (trade) => trade.regime),
      best: sorted.slice(0, 5).map(describe),
      worst: sorted.slice(-5).reverse().map(describe),
      equityCurve: run.equityCurve.map((point) => ({ date: point.date, equity: round(point.equity, 2) })),
      counters: run.counters,
    }
  })

  const base = (strategy: string) => runs.find((run) => run.strategy === strategy && run.slippageMultiplier === 1)
  const sensitivity = ['A', 'C'].map((strategy) => {
    const variants = runs.filter((run) => run.strategy === strategy).sort((left, right) => left.slippageMultiplier - right.slippageMultiplier)
    const edgeAtBase = (base(strategy)?.summary.expectancy ?? 0) > 0
    const edgeAtWorst = (variants.at(-1)?.summary.expectancy ?? 0) > 0
    const verdict = !edgeAtBase
      ? `Strategy ${strategy} has no positive expectancy even at base slippage.`
      : edgeAtWorst
        ? `Strategy ${strategy} keeps a positive expectancy at ${variants.at(-1)?.slippageMultiplier}x slippage.`
        : `Strategy ${strategy}'s edge disappears once slippage is raised to ${variants.find((run) => (run.summary.expectancy ?? 0) <= 0)?.slippageMultiplier}x.`
    return { strategy, verdict, variants: variants.map((run) => ({ slippageMultiplier: run.slippageMultiplier, trades: run.summary.trades, expectancy: run.summary.expectancy, totalPnl: run.summary.totalPnl, profitFactor: run.summary.profitFactor, maxDrawdownPct: run.summary.maxDrawdownPct })) }
  })

  const summary = { ...input.meta, generatedAt: new Date().toISOString(), startingEquity: STARTING_EQUITY, runs, sensitivity, limitations: input.limitations, adapterDifferences: input.adapterDifferences }
  writeFileSync(join(input.outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  return summary
}
