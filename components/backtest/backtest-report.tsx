import { EquityChart } from './equity-chart'

export type BacktestMetrics = {
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
  exitMix: Record<'stop' | 'target' | 'flatten' | 'gap', number> & { time?: number }
}

type TradeNote = { date: string; symbol: string; pnl: number; r: number; exitKind: string; regime: string; reason: string }

export type BacktestRun = {
  id: string
  strategy: string
  label: string
  slippageMultiplier: number
  endingEquity: number
  returnPct: number
  summary: BacktestMetrics
  monthly: Record<string, BacktestMetrics>
  byRegime: Record<string, BacktestMetrics>
  best: TradeNote[]
  worst: TradeNote[]
  equityCurve: Array<{ date: string; equity: number }>
}

export type BacktestSummary = {
  generatedAt: string
  startingEquity: number
  sourceCommit: string
  period: { start: string; end: string; tradingDays: number; session: string }
  universe: { symbols: number; inactiveOrDelisted: number; averageSymbolsLoadedPerDay: number }
  api: { alpaca: number; alpacaCached: number; fmp: number; runtimeSeconds: number }
  runs: BacktestRun[]
  sensitivity: Array<{ strategy: string; verdict: string; variants: Array<{ slippageMultiplier: number; trades: number; expectancy: number | null; totalPnl: number; profitFactor: number | null; maxDrawdownPct: number }> }>
  limitations: string[]
  adapterDifferences: string[]
}

const money = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const pct = (value: number | null | undefined, digits = 1) => value == null ? '—' : `${(value * 100).toFixed(digits)}%`
const num = (value: number | null | undefined, digits = 2) => value == null ? '—' : value.toFixed(digits)
const tone = (value: number | null | undefined) => value == null || value === 0 ? '' : value > 0 ? 'text-primary' : 'text-destructive'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-sm uppercase tracking-widest text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

function MetricsTable({ rows }: { rows: Array<{ key: string; label: string; metrics: BacktestMetrics }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            {['', 'Trades', 'Win %', 'Avg win', 'Avg loss', 'Avg R', 'Expectancy', 'PF', 'P&L', 'Max DD', 'Max DD %', 'Lose streak', 'Avg hold', 'Stop/Tgt/Flat/Gap'].map((heading) => (
              <th key={heading} scope="col" className="whitespace-nowrap px-2 py-2 font-normal">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, label, metrics }) => (
            <tr key={key} className="border-b border-border/60">
              <th scope="row" className="whitespace-nowrap px-2 py-2 font-normal">{label}</th>
              <td className="px-2 py-2">{metrics.trades}</td>
              <td className="px-2 py-2">{pct(metrics.winRate)}</td>
              <td className="px-2 py-2">{money(metrics.averageWin)}</td>
              <td className="px-2 py-2">{money(metrics.averageLoss)}</td>
              <td className={`px-2 py-2 ${tone(metrics.averageR)}`}>{num(metrics.averageR)}</td>
              <td className={`px-2 py-2 ${tone(metrics.expectancy)}`}>{money(metrics.expectancy)}</td>
              <td className="px-2 py-2">{num(metrics.profitFactor)}</td>
              <td className={`px-2 py-2 ${tone(metrics.totalPnl)}`}>{money(metrics.totalPnl)}</td>
              <td className="px-2 py-2">{money(metrics.maxDrawdown)}</td>
              <td className="px-2 py-2">{pct(metrics.maxDrawdownPct)}</td>
              <td className="px-2 py-2">{metrics.longestLosingStreak}</td>
              <td className="whitespace-nowrap px-2 py-2">{metrics.averageHoldMinutes == null ? '—' : `${metrics.averageHoldMinutes}m`}</td>
              <td className="whitespace-nowrap px-2 py-2">{[metrics.exitMix.stop, metrics.exitMix.target, metrics.exitMix.flatten, metrics.exitMix.gap].map((value) => pct(value, 0)).join(' / ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TradeList({ title, trades }: { title: string; trades: TradeNote[] }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <h4 className="text-xs uppercase tracking-widest text-muted-foreground">{title}</h4>
      {trades.length === 0 ? <p className="text-sm text-muted-foreground">No trades.</p> : (
        <ul className="flex flex-col gap-2">
          {trades.map((trade) => (
            <li key={`${trade.date}-${trade.symbol}-${trade.pnl}`} className="flex flex-col gap-1 border-b border-border/60 pb-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>{trade.date} · <strong className="font-semibold">{trade.symbol}</strong></span>
                <span className={tone(trade.pnl)}>{money(trade.pnl)} ({num(trade.r)}R)</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground text-pretty">{trade.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function BacktestReport({ summary }: { summary: BacktestSummary }) {
  const baseRuns = summary.runs.filter((run) => run.slippageMultiplier === 1)
  return (
    <div className="flex flex-col gap-4 p-6">
      <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
        {summary.period.start} → {summary.period.end} · {summary.period.tradingDays} trading days · {summary.period.session} · source {summary.sourceCommit} · {money(summary.startingEquity)} simulated account per run · {summary.universe.symbols.toLocaleString()} symbols ({summary.universe.inactiveOrDelisted.toLocaleString()} inactive/delisted) · {summary.api.alpaca.toLocaleString()} Alpaca calls · runtime {Math.round(summary.api.runtimeSeconds / 60)} min · float = current, not point-in-time
      </p>

      <Section title="Summary">
        <MetricsTable rows={summary.runs.map((run) => ({ key: run.id, label: run.label, metrics: run.summary }))} />
      </Section>

      <Section title="Equity curve">
        <EquityChart runs={baseRuns.map((run) => ({ id: run.id, label: run.label, points: run.equityCurve }))} startingEquity={summary.startingEquity} />
      </Section>

      <Section title="Slippage sensitivity">
        <ul className="flex flex-col gap-1 text-sm">
          {summary.sensitivity.map((item) => <li key={item.strategy}>{item.verdict}</li>)}
        </ul>
      </Section>

      {baseRuns.map((run) => (
        <Section key={run.id} title={run.label}>
          <h3 className="text-xs uppercase tracking-widest text-muted-foreground">Monthly</h3>
          <MetricsTable rows={Object.entries(run.monthly).map(([month, metrics]) => ({ key: month, label: month, metrics }))} />
          <h3 className="text-xs uppercase tracking-widest text-muted-foreground">By regime</h3>
          <MetricsTable rows={Object.entries(run.byRegime).map(([regime, metrics]) => ({ key: regime, label: regime, metrics }))} />
          <div className="flex flex-col gap-4 md:flex-row">
            <TradeList title="Best 5" trades={run.best} />
            <TradeList title="Worst 5" trades={run.worst} />
          </div>
        </Section>
      ))}

      <Section title="Biases and limitations">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed">
          {summary.limitations.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </Section>

      <Section title="Adapter differences vs live">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed">
          {summary.adapterDifferences.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </Section>
    </div>
  )
}
