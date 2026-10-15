// Metrics, rulebook pass/fail (full period, tuning window, holdout) and output files for the S & SP backtest.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RULEBOOK } from './config'
import type { RunConfig, TradeRecord } from './engine'

const P = RULEBOOK.period
const PC = RULEBOOK.passCriteria

export type Metrics = {
  trades: number
  winRate: number | null
  avgWinR: number | null
  avgLossR: number | null
  expectancyR: number | null
  profitFactor: number | null
  maxDrawdownR: number
  maxDrawdownPct: number
  largestLossR: number | null
  netPnl: number
  startEquity: number
  finalEquity: number
}

export function metrics(trades: TradeRecord[], startEquity: number): Metrics {
  const rs = trades.map((trade) => trade.rResult)
  const wins = rs.filter((r) => r > 0)
  const losses = rs.filter((r) => r <= 0)
  const sum = (list: number[]) => list.reduce((total, value) => total + value, 0)
  let cumulative = 0
  let peakR = 0
  let maxDrawdownR = 0
  let equity = startEquity
  let peakEquity = startEquity
  let maxDrawdownPct = 0
  for (const trade of trades) {
    cumulative += trade.rResult
    peakR = Math.max(peakR, cumulative)
    maxDrawdownR = Math.max(maxDrawdownR, peakR - cumulative)
    equity = trade.equityAfter
    peakEquity = Math.max(peakEquity, equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, peakEquity > 0 ? 1 - equity / peakEquity : 0)
  }
  const lossSum = Math.abs(sum(rs.filter((r) => r < 0)))
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    avgWinR: wins.length ? sum(wins) / wins.length : null,
    avgLossR: losses.length ? sum(losses) / losses.length : null,
    expectancyR: trades.length ? sum(rs) / trades.length : null,
    profitFactor: lossSum > 0 ? sum(wins) / lossSum : wins.length ? Infinity : null,
    maxDrawdownR,
    maxDrawdownPct,
    largestLossR: rs.length ? Math.min(...rs) : null,
    netPnl: sum(trades.map((trade) => trade.pnl)),
    startEquity,
    finalEquity: trades.length ? trades.at(-1)!.equityAfter : startEquity,
  }
}

export type Check = { metric: string; rule: string; value: string; pass: boolean }

function monthGroups(trades: TradeRecord[], key: (trade: TradeRecord) => string, allKeys: string[]) {
  const sums = new Map(allKeys.map((month) => [month, 0]))
  for (const trade of trades) sums.set(key(trade), (sums.get(key(trade)) ?? 0) + trade.rResult)
  return [...sums.entries()]
}

// Rulebook months for the full period: the 14th to the 13th (Apr 14-May 13 ... Sep 14-Oct 13) = exactly 6.
export function rulebookMonth(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const start = day >= P.rulebookMonthStartDay ? new Date(Date.UTC(year, month - 1, P.rulebookMonthStartDay)) : new Date(Date.UTC(year, month - 2, P.rulebookMonthStartDay))
  return start.toISOString().slice(0, 7)
}

function calendarMonths(from: string, to: string) {
  const out: string[] = []
  for (let cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); cursor.toISOString().slice(0, 10) <= to; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) out.push(cursor.toISOString().slice(0, 7))
  return out
}

export function passFail(trades: TradeRecord[], startEquity: number, window: 'full' | 'tuning' | 'holdout') {
  const m = metrics(trades, startEquity)
  const fmt = (value: number | null, digits = 2) => (value == null ? 'n/a' : value === Infinity ? '∞' : value.toFixed(digits))
  let months: Array<[string, number]>
  let neededMonths: number
  if (window === 'full') {
    const keys = calendarMonths(P.start, P.end).map((month) => month).filter((month) => month < P.end.slice(0, 7))
    months = monthGroups(trades, (trade) => rulebookMonth(trade.date), keys)
    neededMonths = PC.minProfitableMonths
  } else {
    const keys = window === 'tuning' ? calendarMonths(P.start, P.tuningEnd) : calendarMonths(P.holdoutStart, P.end)
    months = monthGroups(trades, (trade) => trade.date.slice(0, 7), keys)
    neededMonths = Math.ceil(keys.length * PC.windowProfitableMonthsFraction)
  }
  const profitable = months.filter(([, r]) => r > 0).length
  const minTrades = window === 'full' ? PC.minTrades : window === 'tuning' ? PC.minTradesTuning : PC.minTradesHoldout
  const checks: Check[] = [
    { metric: 'Trades', rule: `≥ ${minTrades}`, value: String(m.trades), pass: m.trades >= minTrades },
    { metric: 'Expectancy', rule: `> +${PC.minExpectancyR}R per trade`, value: `${fmt(m.expectancyR)}R`, pass: (m.expectancyR ?? -Infinity) > PC.minExpectancyR },
    { metric: 'Profit factor', rule: `> ${PC.minProfitFactor}`, value: fmt(m.profitFactor), pass: (m.profitFactor ?? 0) > PC.minProfitFactor },
    { metric: 'Max drawdown', rule: `< ${PC.maxDrawdownR}R`, value: `${fmt(m.maxDrawdownR)}R`, pass: m.maxDrawdownR < PC.maxDrawdownR },
    { metric: 'Largest single loss', rule: `< ${PC.maxSingleLossR}R`, value: `${fmt(m.largestLossR)}R`, pass: m.largestLossR == null || -m.largestLossR < PC.maxSingleLossR },
    { metric: 'Profitable months', rule: `≥ ${neededMonths} of ${months.length}`, value: `${profitable} of ${months.length}`, pass: profitable >= neededMonths },
  ]
  return { metrics: m, checks, pass: checks.every((check) => check.pass), months }
}

function group(trades: TradeRecord[], key: (trade: TradeRecord) => string | null, startEquity: number) {
  const map = new Map<string, TradeRecord[]>()
  for (const trade of trades) {
    const value = key(trade)
    if (value == null) continue
    if (!map.has(value)) map.set(value, [])
    map.get(value)!.push(trade)
  }
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, list]) => ({ name, ...metrics(list, startEquity) }))
}

export type RunReport = ReturnType<typeof buildRunReport>

export function buildRunReport(run: RunConfig, trades: TradeRecord[], equityByDay: Array<{ day: string; equity: number }>, stats: unknown) {
  const start = RULEBOOK.account.startingEquity
  const tuning = trades.filter((trade) => trade.date <= P.tuningEnd)
  const holdout = trades.filter((trade) => trade.date >= P.holdoutStart)
  const holdoutStart = tuning.length ? tuning.at(-1)!.equityAfter : start
  return {
    id: run.id,
    label: run.label,
    versions: run.versions,
    spSlippageMultiplier: run.spSlippageMultiplier,
    full: passFail(trades, start, 'full'),
    tuning: passFail(tuning, start, 'tuning'),
    holdout: passFail(holdout, holdoutStart, 'holdout'),
    byMonth: group(trades, (trade) => trade.date.slice(0, 7), start),
    bySetup: [
      ...group(trades, (trade) => `${trade.version} Setup ${trade.setup}`, start),
      ...group(trades.filter((trade) => trade.version === 'SP'), (trade) => (trade.entryIndex >= 2 ? 'SP re-entries (2nd/3rd entry in a ticker)' : null), start),
    ],
    byExit: group(trades, (trade) => trade.exitReason, start),
    equityByDay,
    stats,
  }
}

const etFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
export function et(ms: number) {
  return etFormat.format(new Date(ms)).replace(',', '')
}

const CSV_COLUMNS: Array<[string, (trade: TradeRecord) => unknown]> = [
  ['run', (t) => t.run], ['date', (t) => t.date], ['ticker', (t) => t.ticker], ['version', (t) => t.version], ['setup', (t) => t.setup],
  ['entry_time', (t) => et(t.entryTime)], ['entry_price', (t) => t.entryPrice.toFixed(4)], ['stop', (t) => t.stop.toFixed(4)], ['shares', (t) => t.shares],
  ['exit_time', (t) => et(t.exitTime)], ['exit_price', (t) => t.exitPrice.toFixed(4)], ['exit_reason', (t) => t.exitReason], ['r_result', (t) => t.rResult.toFixed(3)],
  ['pnl', (t) => t.pnl.toFixed(2)], ['equity_after', (t) => t.equityAfter.toFixed(2)],
  ['entry_index', (t) => t.entryIndex], ['units', (t) => t.units], ['max_shares', (t) => t.maxShares], ['avg_cost', (t) => t.avgCost.toFixed(4)],
  ['fees', (t) => t.fees.toFixed(4)], ['risk_dollars', (t) => t.riskDollars.toFixed(2)], ['mfe_r', (t) => t.mfeR.toFixed(2)], ['mae_r', (t) => t.maeR.toFixed(2)],
  ['hold_minutes', (t) => t.holdMinutes], ['room_r', (t) => (t.roomR === Infinity ? 'inf' : t.roomR.toFixed(2))],
  ['gap_pct', (t) => (t.gapPct == null ? '' : (t.gapPct * 100).toFixed(1))], ['rvol', (t) => (t.rvol == null ? '' : t.rvol === Infinity ? 'inf' : t.rvol.toFixed(1))],
  ['partials', (t) => t.partials], ['note', (t) => t.note],
]

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function tradesCsv(trades: TradeRecord[]) {
  return [CSV_COLUMNS.map(([name]) => name).join(','), ...trades.map((trade) => CSV_COLUMNS.map(([, pick]) => csvCell(pick(trade))).join(','))].join('\n') + '\n'
}

const pct = (value: number | null) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`)
const r2 = (value: number | null) => (value == null ? 'n/a' : value === Infinity ? '∞' : value.toFixed(2))
const esc = (text: string) => text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)

function equitySvg(points: Array<{ day: string; equity: number }>) {
  if (points.length < 2) return '<p class="muted">Not enough days for a chart.</p>'
  const width = 720
  const height = 220
  const pad = { l: 56, r: 12, t: 12, b: 28 }
  const values = points.map((point) => point.equity)
  const lo = Math.min(...values, RULEBOOK.account.startingEquity)
  const hi = Math.max(...values, RULEBOOK.account.startingEquity)
  const span = hi - lo || 1
  const x = (index: number) => pad.l + (index / (points.length - 1)) * (width - pad.l - pad.r)
  const y = (value: number) => pad.t + (1 - (value - lo) / span) * (height - pad.t - pad.b)
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.equity).toFixed(1)}`).join(' ')
  const holdoutIndex = points.findIndex((point) => point.day >= P.holdoutStart)
  const ticks = [lo, (lo + hi) / 2, hi]
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Equity curve">
  ${ticks.map((tick) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(tick)}" y2="${y(tick)}" class="grid"/><text x="${pad.l - 6}" y="${y(tick) + 4}" class="axis" text-anchor="end">$${tick.toFixed(0)}</text>`).join('')}
  <line x1="${pad.l}" x2="${width - pad.r}" y1="${y(RULEBOOK.account.startingEquity)}" y2="${y(RULEBOOK.account.startingEquity)}" class="base"/>
  ${holdoutIndex > 0 ? `<line x1="${x(holdoutIndex)}" x2="${x(holdoutIndex)}" y1="${pad.t}" y2="${height - pad.b}" class="split"/><text x="${x(holdoutIndex) + 4}" y="${pad.t + 10}" class="axis">holdout →</text>` : ''}
  <path d="${path}" class="line"/>
  <text x="${pad.l}" y="${height - 8}" class="axis">${points[0].day}</text><text x="${width - pad.r}" y="${height - 8}" class="axis" text-anchor="end">${points.at(-1)!.day}</text>
</svg>`
}

function metricsTable(rows: Array<{ name: string } & ReturnType<typeof metrics>>) {
  return `<table><thead><tr><th>Group</th><th>Trades</th><th>Win %</th><th>Avg win R</th><th>Avg loss R</th><th>Expectancy R</th><th>PF</th><th>Max DD R</th><th>Largest loss R</th><th>P&amp;L $</th></tr></thead><tbody>
${rows.map((row) => `<tr><td>${esc(row.name)}</td><td>${row.trades}</td><td>${pct(row.winRate)}</td><td>${r2(row.avgWinR)}</td><td>${r2(row.avgLossR)}</td><td>${r2(row.expectancyR)}</td><td>${r2(row.profitFactor)}</td><td>${r2(row.maxDrawdownR)}</td><td>${r2(row.largestLossR)}</td><td class="${row.netPnl >= 0 ? 'pos' : 'neg'}">${row.netPnl.toFixed(2)}</td></tr>`).join('\n')}
</tbody></table>`
}

function checksTable(title: string, result: ReturnType<typeof passFail>) {
  return `<div class="card"><h4>${title} <span class="badge ${result.pass ? 'ok' : 'bad'}">${result.pass ? 'PASS' : 'FAIL'}</span></h4>
<table><thead><tr><th>Metric</th><th>Rule</th><th>Result</th><th></th></tr></thead><tbody>
${result.checks.map((check) => `<tr><td>${check.metric}</td><td>${check.rule}</td><td>${check.value}</td><td class="${check.pass ? 'pos' : 'neg'}">${check.pass ? 'pass' : 'fail'}</td></tr>`).join('')}
</tbody></table></div>`
}

export function htmlReport(reports: RunReport[], meta: { generatedAt: string; sourceCommit: string; tradingDays: number; notes: string[]; funnel?: Record<string, Record<string, number>> }) {
  const sections = reports.map((report) => {
    const m = report.full.metrics
    return `<section id="run-${report.id}"><h2>Run ${report.id}: ${esc(report.label)}</h2>
<div class="tiles">
<div class="tile"><span>Final equity</span><b>$${m.finalEquity.toFixed(2)}</b></div>
<div class="tile"><span>Trades</span><b>${m.trades}</b></div>
<div class="tile"><span>Win rate</span><b>${pct(m.winRate)}</b></div>
<div class="tile"><span>Expectancy</span><b>${r2(m.expectancyR)}R</b></div>
<div class="tile"><span>Profit factor</span><b>${r2(m.profitFactor)}</b></div>
<div class="tile"><span>Max drawdown</span><b>${r2(m.maxDrawdownR)}R · ${pct(m.maxDrawdownPct)}</b></div>
<div class="tile"><span>Avg win / loss</span><b>${r2(m.avgWinR)}R / ${r2(m.avgLossR)}R</b></div>
<div class="tile"><span>Largest loss</span><b>${r2(m.largestLossR)}R</b></div>
</div>
${equitySvg(report.equityByDay)}
<div class="grid3">${checksTable('Full period (Apr 14 – Oct 13)', report.full)}${checksTable('Tuning window (Apr 14 – Jul 31)', report.tuning)}${checksTable('Holdout (Aug 1 – Oct 13)', report.holdout)}</div>
<h3>By month</h3>${metricsTable(report.byMonth)}
<h3>By setup</h3>${metricsTable(report.bySetup)}
<h3>By exit reason</h3>${metricsTable(report.byExit)}
</section>`
  }).join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Strategy S &amp; SP Backtest</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--card:#fff;--line:#e4e1d8;--accent:#2f6f5e;--pos:#1f7a4d;--neg:#b23a3a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--fg:#ecebe6;--muted:#9c9a92;--card:#1e1e1c;--line:#33322e;--accent:#6fbfa5;--pos:#5cc48c;--neg:#e07a7a}}
:root[data-theme="dark"]{--bg:#151514;--fg:#ecebe6;--muted:#9c9a92;--card:#1e1e1c;--line:#33322e;--accent:#6fbfa5;--pos:#5cc48c;--neg:#e07a7a}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 12px;border-top:1px solid var(--line);padding-top:24px}h3{font-size:15px;margin:20px 0 8px}h4{margin:0 0 8px;font-size:14px}
.muted{color:var(--muted)}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13px;display:block;overflow-x:auto}
th,td{text-align:right;padding:4px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th:first-child,td:first-child{text-align:left}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px}.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px}.tile span{display:block;color:var(--muted);font-size:12px}.tile b{font-size:16px}
.card table{display:table}.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px}
.badge{font-size:11px;padding:1px 6px;border-radius:4px;color:#fff}.ok{background:var(--pos)}.bad{background:var(--neg)}.pos{color:var(--pos)}.neg{color:var(--neg)}
svg{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}.line{fill:none;stroke:var(--accent);stroke-width:2}.grid{stroke:var(--line)}.base{stroke:var(--muted);stroke-dasharray:4 4}.split{stroke:var(--neg);stroke-dasharray:3 3}.axis{fill:var(--muted);font-size:11px}
nav a{color:var(--accent);margin-right:12px}ul{padding-left:18px}
</style></head><body>
<h1>Strategy S &amp; SP — rulebook backtest</h1>
<p class="muted">Apr 14 – Oct 13, 2026 · ${meta.tradingDays} trading days · $${RULEBOOK.account.startingEquity.toLocaleString()} start, compounding · generated ${meta.generatedAt} · commit ${meta.sourceCommit}</p>
<nav>${reports.map((report) => `<a href="#run-${report.id}">Run ${report.id}</a>`).join('')}</nav>
<h3>Run comparison</h3>
<table><thead><tr><th>Run</th><th>Trades</th><th>Expectancy R</th><th>PF</th><th>Max DD R</th><th>Final equity</th><th>Full</th><th>Tuning</th><th>Holdout</th></tr></thead><tbody>
${reports.map((report) => `<tr><td>${report.id}: ${esc(report.label)}</td><td>${report.full.metrics.trades}</td><td>${r2(report.full.metrics.expectancyR)}</td><td>${r2(report.full.metrics.profitFactor)}</td><td>${r2(report.full.metrics.maxDrawdownR)}</td><td>$${report.full.metrics.finalEquity.toFixed(2)}</td><td class="${report.full.pass ? 'pos' : 'neg'}">${report.full.pass ? 'PASS' : 'FAIL'}</td><td class="${report.tuning.pass ? 'pos' : 'neg'}">${report.tuning.pass ? 'PASS' : 'FAIL'}</td><td class="${report.holdout.pass ? 'pos' : 'neg'}">${report.holdout.pass ? 'PASS' : 'FAIL'}</td></tr>`).join('')}
</tbody></table>
${sections}
${meta.funnel ? `<h2>Signal funnel (where candidates stop)</h2>${Object.entries(meta.funnel).map(([version, counts]) => `<h3>${version}</h3><table><tbody>${Object.entries(counts).sort(([l], [r]) => l.localeCompare(r)).map(([key, value]) => `<tr><td>${esc(key)}</td><td>${value}</td></tr>`).join('')}</tbody></table>`).join('')}` : ''}
<h2>Assumptions and data limits</h2><ul>${meta.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>
</body></html>`
}

export function writeOutputs(outDir: string, reports: RunReport[], tradesByRun: Map<string, TradeRecord[]>, meta: { generatedAt: string; sourceCommit: string; tradingDays: number; notes: string[]; funnel?: Record<string, Record<string, number>> }) {
  mkdirSync(outDir, { recursive: true })
  const allTrades = [...tradesByRun.values()].flat()
  writeFileSync(join(outDir, 'trades.csv'), tradesCsv(allTrades))
  for (const report of reports) {
    const dir = join(outDir, `run-${report.id}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'trades.csv'), tradesCsv(tradesByRun.get(report.id) ?? []))
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(report, jsonReplacer, 2))
  }
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ ...meta, config: RULEBOOK, runs: reports }, jsonReplacer, 2))
  writeFileSync(join(outDir, 'report.html'), htmlReport(reports, meta))
}

export function jsonReplacer(_key: string, value: unknown) {
  return value === Infinity ? 'Infinity' : value
}
