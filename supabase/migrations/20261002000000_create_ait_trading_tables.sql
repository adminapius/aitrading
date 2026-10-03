-- AItrading paper-trading schema
-- Run this file manually in the SQL editor for the Supabase project "aitomated-trading".
-- All timestamps are stored in UTC; the app displays them in America/New_York.

create extension if not exists pgcrypto;

create table if not exists public.ait_papermoney (
  id uuid primary key default gen_random_uuid(),
  account_name text not null default 'paper-main',
  starting_balance numeric(14,2) not null default 2000.00 check (starting_balance >= 0),
  cash_balance numeric(14,2) not null default 2000.00 check (cash_balance >= 0),
  equity numeric(14,2) not null default 2000.00 check (equity >= 0),
  realized_pnl numeric(14,2) not null default 0,
  unrealized_pnl numeric(14,2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ait_papermoney_active_idx
  on public.ait_papermoney (account_name) where is_active;

create table if not exists public.ait_sessions (
  id uuid primary key default gen_random_uuid(),
  trading_date date not null unique,
  timezone text not null default 'America/New_York',
  status text not null default 'sleeping' check (status in ('sleeping','awake','flattening','closed')),
  started_at timestamptz,
  flattened_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.ait_positions (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  side text not null check (side in ('long','short')),
  quantity numeric(14,4) not null check (quantity > 0),
  entry_price numeric(14,6) not null check (entry_price > 0),
  current_price numeric(14,6),
  stop_price numeric(14,6),
  target_price numeric(14,6),
  unrealized_pnl numeric(14,2) not null default 0,
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  broker_position_id text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists ait_positions_status_idx on public.ait_positions (status, opened_at desc);

create table if not exists public.ait_trades (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.ait_sessions(id),
  position_id uuid references public.ait_positions(id),
  symbol text not null,
  side text not null check (side in ('buy','sell','short','cover')),
  quantity numeric(14,4) not null check (quantity > 0),
  requested_price numeric(14,6),
  filled_price numeric(14,6),
  status text not null default 'submitted' check (status in ('submitted','partially_filled','filled','cancelled','rejected')),
  realized_pnl numeric(14,2),
  broker_order_id text unique,
  order_type text not null default 'market',
  submitted_at timestamptz not null default now(),
  filled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists ait_trades_time_idx on public.ait_trades (submitted_at desc);
create index if not exists ait_trades_symbol_idx on public.ait_trades (symbol, submitted_at desc);

create table if not exists public.ait_logevents (
  id bigint generated always as identity primary key,
  session_id uuid references public.ait_sessions(id),
  level text not null default 'info' check (level in ('debug','info','success','warning','error')),
  event_type text not null,
  message text not null,
  symbol text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ait_logevents_time_idx on public.ait_logevents (created_at desc);

create table if not exists public.ait_watchlist_scans (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.ait_sessions(id),
  symbol text not null,
  company_name text,
  price numeric(14,6),
  change_percent numeric(10,4),
  volume bigint,
  relative_volume numeric(10,4),
  float_shares bigint,
  atr numeric(14,6),
  vwap numeric(14,6),
  catalyst_type text,
  catalyst_summary text,
  score numeric(6,2),
  decision text check (decision in ('watch','enter','avoid','exit')),
  scanned_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists ait_watchlist_scans_time_idx on public.ait_watchlist_scans (scanned_at desc);
create index if not exists ait_watchlist_scans_symbol_idx on public.ait_watchlist_scans (symbol, scanned_at desc);

create table if not exists public.ait_market_bars (
  id bigint generated always as identity primary key,
  symbol text not null,
  timeframe text not null check (timeframe in ('10s','1m','5m','1h','4h','1d','1y')),
  opened_at timestamptz not null,
  open numeric(14,6) not null,
  high numeric(14,6) not null,
  low numeric(14,6) not null,
  close numeric(14,6) not null,
  volume bigint not null default 0,
  vwap numeric(14,6),
  source text not null default 'alpaca',
  unique (symbol, timeframe, opened_at)
);

create index if not exists ait_market_bars_lookup_idx on public.ait_market_bars (symbol, timeframe, opened_at desc);

create table if not exists public.ait_strategy_signals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.ait_sessions(id),
  symbol text not null,
  action text not null check (action in ('buy','sell','hold','reject')),
  confidence numeric(5,2) check (confidence between 0 and 100),
  rationale text not null,
  model text,
  features jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ait_strategy_signals_time_idx on public.ait_strategy_signals (created_at desc);

alter table public.ait_papermoney enable row level security;
alter table public.ait_sessions enable row level security;
alter table public.ait_positions enable row level security;
alter table public.ait_trades enable row level security;
alter table public.ait_logevents enable row level security;
alter table public.ait_watchlist_scans enable row level security;
alter table public.ait_market_bars enable row level security;
alter table public.ait_strategy_signals enable row level security;

-- Backend workers should use the Supabase service-role key.
-- No public/anon policies are created by design.

insert into public.ait_papermoney (account_name, starting_balance, cash_balance, equity)
values ('paper-main', 2000.00, 2000.00, 2000.00)
on conflict do nothing;

comment on table public.ait_papermoney is 'AItrading paper account; keep this ledger server-write only.';
comment on table public.ait_trades is 'Broker order lifecycle and fills.';
comment on table public.ait_logevents is 'Immutable bot/dashboard event stream.';
comment on table public.ait_market_bars is 'Cached market candles for dashboard charting.';

-- Verification queries (run after the DDL):
-- select table_name from information_schema.tables where table_schema = 'public' and table_name like 'ait_%' order by table_name;
-- select account_name, starting_balance, cash_balance, equity from public.ait_papermoney;
-- select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename like 'ait_%' order by tablename;
