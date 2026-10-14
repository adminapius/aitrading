-- Saved backtest results: one row per run (summary) + one row per simulated trade. Service-role only. Idempotent.
create table if not exists public.ait_backtest_runs (
  id uuid primary key default gen_random_uuid(),
  batch_label text not null,
  run_id text not null,
  label text,
  strategy text,
  slippage_multiplier numeric,
  period_start date,
  period_end date,
  trading_days int,
  source_commit text,
  generated_at timestamptz not null,
  starting_equity numeric,
  ending_equity numeric,
  return_pct numeric,
  trades int,
  win_rate numeric,
  average_r numeric,
  profit_factor numeric,
  max_drawdown_pct numeric,
  summary jsonb,
  monthly jsonb,
  by_regime jsonb,
  assumptions jsonb,
  limitations jsonb,
  created_at timestamptz not null default now(),
  unique (generated_at, run_id)
);

create table if not exists public.ait_backtest_trades (
  id bigserial primary key,
  backtest_run_id uuid not null references public.ait_backtest_runs(id) on delete cascade,
  run_id text not null,
  trade_date date not null,
  symbol text not null,
  regime text,
  rank int,
  entry_at timestamptz,
  entry_price numeric,
  shares numeric,
  stop numeric,
  target numeric,
  exit_at timestamptz,
  exit_price numeric,
  exit_kind text,
  pnl numeric,
  r numeric,
  hold_minutes numeric,
  slippage_fraction numeric,
  spread_source text,
  liquidity_capped boolean,
  t1_hit boolean,
  mfe_r numeric,
  mae_r numeric,
  zero_slip_pnl numeric,
  entry_spread_pct numeric,
  change_pct_at_entry numeric,
  float_shares numeric,
  entry_index int,
  minutes_since_first_seen int,
  entry_minute_of_day int,
  catalyst text,
  reason text
);

create index if not exists ait_backtest_trades_run_idx on public.ait_backtest_trades (backtest_run_id);
create index if not exists ait_backtest_trades_date_idx on public.ait_backtest_trades (trade_date);

alter table public.ait_backtest_runs enable row level security;
alter table public.ait_backtest_trades enable row level security;

comment on table public.ait_backtest_runs is 'Offline backtest run summaries (scripts/backtest). Research only; never read by the live worker.';
comment on table public.ait_backtest_trades is 'Every simulated trade from offline backtests (scripts/backtest). Research only.';
