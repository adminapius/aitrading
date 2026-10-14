// Saves a finished backtest (summary.json + trades.csv in an output folder) to Supabase:
// one ait_backtest_runs row per run and every trade in ait_backtest_trades. Research only.
//
//   pnpm exec tsx scripts/backtest/upload.ts --out=backtests/c1c2 [--label="C1/C2 test"]
//
// Needs SUPABASE_SERVICE_ROLE_KEY (and SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL) in the environment.
// Re-uploading the same output folder replaces that upload (matched on generatedAt + run id).
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

type Row = Record<string, string>

export function parseCsv(text: string): Row[] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1 }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += char
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  const [header, ...body] = rows
  return body.map((values) => Object.fromEntries(header.map((key, column) => [key, values[column] ?? ''])))
}

const num = (value: string | undefined) => (value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value))
const int = (value: string | undefined) => { const parsed = num(value); return parsed === null ? null : Math.round(parsed) }
const bool = (value: string | undefined) => (value === 'true' ? true : value === 'false' ? false : null)
const text = (value: string | undefined) => (value === undefined || value === '' ? null : value)

export function tradeRow(trade: Row, backtestRunId: string) {
  return {
    backtest_run_id: backtestRunId,
    run_id: trade.run,
    trade_date: trade.date,
    symbol: trade.symbol,
    regime: text(trade.regime),
    rank: int(trade.rank),
    entry_at: text(trade.entryAt),
    entry_price: num(trade.entryPrice),
    shares: num(trade.shares),
    stop: num(trade.stop),
    target: num(trade.target),
    exit_at: text(trade.exitAt),
    exit_price: num(trade.exitPrice),
    exit_kind: text(trade.exitKind),
    pnl: num(trade.pnl),
    r: num(trade.r),
    hold_minutes: num(trade.holdMinutes),
    slippage_fraction: num(trade.slippageFraction),
    spread_source: text(trade.spreadSource),
    liquidity_capped: bool(trade.liquidityCapped),
    t1_hit: bool(trade.t1Hit),
    mfe_r: num(trade.mfeR),
    mae_r: num(trade.maeR),
    zero_slip_pnl: num(trade.zeroSlipPnl),
    entry_spread_pct: num(trade.entrySpreadPct),
    change_pct_at_entry: num(trade.changePctAtEntry),
    float_shares: num(trade.float),
    entry_index: int(trade.entryIndex),
    minutes_since_first_seen: int(trade.minutesSinceFirstSeen),
    entry_minute_of_day: int(trade.entryMinuteOfDay),
    catalyst: text(trade.catalyst),
    reason: text(trade.reason),
  }
}

function supabase() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  const url = (process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '').replace(/\/+$/, '')
  if (!key || !url) throw new Error('Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY to upload backtest results.')
  return async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
    if (!response.ok) throw new Error(`Supabase ${init.method ?? 'GET'} ${path.split('?')[0]} failed (${response.status}): ${await response.text()}`)
    return response
  }
}

export async function uploadBacktest(outputDir: string, batchLabel = basename(outputDir)) {
  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf8'))
  const trades = parseCsv(readFileSync(join(outputDir, 'trades.csv'), 'utf8'))
  const request = supabase()
  let saved = 0
  for (const run of summary.runs as Array<Record<string, any>>) {
    const filter = new URLSearchParams({ generated_at: `eq.${summary.generatedAt}`, run_id: `eq.${run.id}` }).toString()
    await request(`ait_backtest_runs?${filter}`, { method: 'DELETE' }) // replace a previous upload of the same run (trades cascade)
    const inserted = await request('ait_backtest_runs?select=id', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        batch_label: batchLabel,
        run_id: run.id,
        label: run.label,
        strategy: run.strategy,
        slippage_multiplier: run.slippageMultiplier,
        period_start: summary.period?.start,
        period_end: summary.period?.end,
        trading_days: summary.period?.tradingDays,
        source_commit: summary.sourceCommit,
        generated_at: summary.generatedAt,
        starting_equity: summary.startingEquity,
        ending_equity: run.endingEquity,
        return_pct: run.returnPct,
        trades: run.summary?.trades,
        win_rate: run.summary?.winRate,
        average_r: run.summary?.averageR,
        profit_factor: run.summary?.profitFactor,
        max_drawdown_pct: run.summary?.maxDrawdownPct,
        summary: run.summary,
        monthly: run.monthly,
        by_regime: run.byRegime,
        assumptions: summary.assumptions,
        limitations: summary.limitations,
      }),
    })
    const [{ id }] = (await inserted.json()) as Array<{ id: string }>
    const rows = trades.filter((trade) => trade.run === run.id).map((trade) => tradeRow(trade, id))
    for (let start = 0; start < rows.length; start += 500) {
      await request('ait_backtest_trades', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows.slice(start, start + 500)) })
    }
    saved += rows.length
    console.log(`[upload] ${run.id}: ${rows.length} trades saved`)
  }
  console.log(`[upload] done: ${summary.runs.length} runs, ${saved} trades (batch "${batchLabel}")`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || 'true'] as const }))
  const out = args.get('out')
  if (!out) throw new Error('Pass --out=backtests/<folder>')
  uploadBacktest(join(process.cwd(), out), args.get('label') ?? basename(out)).catch((error) => { console.error('[upload] failed', error); process.exit(1) })
}
