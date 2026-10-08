create table if not exists public.ait_elliott_wave_state (
  session_id uuid not null references public.ait_sessions(id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.-]{0,9}$'),
  scan_id uuid not null,
  current_wave smallint not null default 0 check (current_wave between 0 and 5),
  pivots jsonb not null default '[]'::jsonb check (jsonb_typeof(pivots) = 'array'),
  invalidation_level numeric(14,6),
  invalidation_reason text,
  wave_confidence smallint not null default 0 check (wave_confidence between 0 and 100),
  wave5_exhaustion boolean not null default false,
  valid boolean not null default true,
  regime text not null check (regime in ('opening-momentum', 'premarket-continuation', 'news-reaction', 'midday-selective', 'late-continuation', 'exits-only')),
  updated_at timestamptz not null default now(),
  primary key (session_id, symbol)
);

create index if not exists ait_elliott_wave_state_scan_idx
  on public.ait_elliott_wave_state (scan_id, updated_at desc);

alter table public.ait_elliott_wave_state enable row level security;
revoke all on public.ait_elliott_wave_state from public, anon, authenticated;
grant select, insert, update, delete on public.ait_elliott_wave_state to service_role;

create table if not exists public.ait_shadow_signals (
  id uuid primary key default gen_random_uuid(),
  signal_key text not null unique check (length(signal_key) between 1 and 300),
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.-]{0,9}$'),
  scan_id uuid not null references public.ait_scan_runs(scan_id) on delete cascade,
  session_id uuid not null references public.ait_sessions(id) on delete cascade,
  trade_id uuid references public.ait_trades(id) on delete set null,
  rule text not null check (rule in ('ew_wave3', 'ew_wave4', 'ew_block_wave5', 'ew_exit_signal')),
  regime text not null check (regime in ('opening-momentum', 'premarket-continuation', 'news-reaction', 'midday-selective', 'late-continuation', 'exits-only')),
  wave_confidence smallint not null check (wave_confidence between 0 and 100),
  pivots jsonb not null default '[]'::jsonb check (jsonb_typeof(pivots) = 'array'),
  trigger_price numeric(14,6),
  stop numeric(14,6),
  t1 numeric(14,6),
  t2 numeric(14,6),
  would_be_shares integer not null default 0 check (would_be_shares >= 0),
  triggered_at timestamptz,
  outcome text check (outcome in ('stop', 't1', 't2', 'timeout', 'flatten')),
  outcome_at timestamptz,
  fill_price numeric(14,6),
  r_multiple numeric(12,6),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (outcome is null or outcome_at is not null)
);

create index if not exists ait_shadow_signals_session_rule_time_idx
  on public.ait_shadow_signals (session_id, rule, created_at desc);
create index if not exists ait_shadow_signals_regime_time_idx
  on public.ait_shadow_signals (regime, created_at desc);
create index if not exists ait_shadow_signals_trade_idx
  on public.ait_shadow_signals (trade_id) where trade_id is not null;
create index if not exists ait_shadow_signals_open_outcomes_idx
  on public.ait_shadow_signals (session_id, symbol, created_at)
  where outcome is null and rule in ('ew_wave3', 'ew_wave4');

alter table public.ait_shadow_signals enable row level security;
revoke all on public.ait_shadow_signals from public, anon, authenticated;
grant select, insert, update, delete on public.ait_shadow_signals to service_role;

comment on table public.ait_elliott_wave_state is 'Latest closed-bar Elliott Wave count per active session and symbol; shadow analysis only.';
comment on table public.ait_shadow_signals is 'Shadow-only Elliott Wave setups, filter observations, simulated fills, and exit comparisons. Never an execution instruction.';
