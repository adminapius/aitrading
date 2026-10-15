// Saves a finished S & SP rulebook backtest (summary.json + trades.csv) to Supabase: one ait_backtest_runs row
// per run (pass/fail and breakdowns in the summary jsonb) and every trade in ait_backtest_trades. Research only.
//
//   npx tsx scripts/backtest/rulebook/upload.ts --out=backtests/rulebook [--label=rulebook-s-sp]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseCsv } from '../upload'

const num = (value: string | undefined) => (value === undefined || value === '' || value === 'inf' || Number.isNaN(Number(value)) ? null : Number(value))
const text = (value: string | undefined) => (value === undefined || value === '' ? null : value)
// CSV times are "YYYY-MM-DD HH:MM" Eastern; store as timestamptz.
function easternIso(value: string | undefined) {
  if (!value) return null
  for (const offset of ['-04:00', '-05:00']) {
    const ms = Date.parse(`${value.replace(' ', 'T')}:00${offset}`)
    const check = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).replace(',', '')
    if (check === value) return new Date(ms).toISOString()
  }
  return null
}

export function rulebookTradeRow(trade: Record<string, string>, backtestRunId: string) {
  const entry = easternIso(trade.entry_time)
  const minute = trade.entry_time ? Number(trade.entry_time.slice(11, 13)) * 60 + Number(trade.entry_time.slice(14, 16)) : null
  return {
    backtest_run_id: backtestRunId,
    run_id: trade.run,
    trade_date: trade.date,
    symbol: trade.ticker,
    version: text(trade.version),
    setup: text(trade.setup),
    regime: text(trade.version),
    entry_at: entry,
    entry_price: num(trade.entry_price),
    shares: num(trade.shares),
    stop: num(trade.stop),
    exit_at: easternIso(trade.exit_time),
    exit_price: num(trade.exit_price),
    exit_kind: text(trade.exit_reason),
    pnl: num(trade.pnl),
    r: num(trade.r_result),
    equity_after: num(trade.equity_after),
    hold_minutes: num(trade.hold_minutes),
    mfe_r: num(trade.mfe_r),
    mae_r: num(trade.mae_r),
    change_pct_at_entry: num(trade.gap_pct),
    entry_index: num(trade.entry_index),
    entry_minute_of_day: minute,
    units: num(trade.units),
    partials: text(trade.partials),
    reason: text(trade.note),
  }
}

export async function uploadRulebook(outputDir: string, batchLabel: string) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  const url = (process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '').replace(/\/+$/, '')
  if (!key || !url) throw new Error('Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY to upload backtest results.')
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
    if (!response.ok) throw new Error(`Supabase ${init.method ?? 'GET'} ${path.split('?')[0]} failed (${response.status}): ${await response.text()}`)
    return response
  }
  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf8'))
  const trades = parseCsv(readFileSync(join(outputDir, 'trades.csv'), 'utf8'))
  for (const run of summary.runs as Array<Record<string, any>>) {
    const filter = new URLSearchParams({ generated_at: `eq.${summary.generatedAt}`, run_id: `eq.rulebook-${run.id}` }).toString()
    await request(`ait_backtest_runs?${filter}`, { method: 'DELETE' })
    const full = run.full.metrics
    const inserted = await request('ait_backtest_runs?select=id', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        batch_label: batchLabel,
        run_id: `rulebook-${run.id}`,
        label: run.label,
        strategy: run.versions.join('+'),
        slippage_multiplier: run.spSlippageMultiplier,
        period_start: summary.period?.start,
        period_end: summary.period?.end,
        trading_days: summary.tradingDays,
        source_commit: summary.sourceCommit,
        generated_at: summary.generatedAt,
        starting_equity: full.startEquity,
        ending_equity: full.finalEquity,
        return_pct: full.startEquity ? (full.finalEquity / full.startEquity - 1) * 100 : null,
        trades: full.trades,
        win_rate: full.winRate,
        average_r: full.expectancyR,
        profit_factor: typeof full.profitFactor === 'number' ? full.profitFactor : null,
        max_drawdown_pct: full.maxDrawdownPct * 100,
        summary: { full: run.full, tuning: run.tuning, holdout: run.holdout, bySetup: run.bySetup, byExit: run.byExit, stats: run.stats, equityByDay: run.equityByDay },
        monthly: run.byMonth,
        assumptions: summary.config,
        limitations: summary.notes,
      }),
    })
    const [{ id }] = (await inserted.json()) as Array<{ id: string }>
    const rows = trades.filter((trade) => trade.run === run.id).map((trade) => ({ ...rulebookTradeRow(trade, id), run_id: `rulebook-${run.id}` }))
    for (let start = 0; start < rows.length; start += 500) {
      await request('ait_backtest_trades', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows.slice(start, start + 500)) })
    }
    console.log(`[upload] rulebook-${run.id}: ${rows.length} trades saved`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = new Map(process.argv.slice(2).map((arg) => { const [k, ...rest] = arg.replace(/^--/, '').split('='); return [k, rest.join('=') || 'true'] as const }))
  uploadRulebook(join(process.cwd(), args.get('out') ?? 'backtests/rulebook'), args.get('label') ?? 'rulebook-s-sp').catch((error) => { console.error('[upload] failed', error); process.exit(1) })
}
