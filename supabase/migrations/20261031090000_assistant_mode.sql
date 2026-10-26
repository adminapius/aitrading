-- Assistant mode (docs/assistant-mode-spec.md). Read-only assistant for Jose's MANUAL trades in a separate Alpaca
-- paper account; nothing here is read or written by Strategy E, shadow A or the Friday report. Service-role only
-- (RLS on, no policies), like the other ait_ tables. Idempotent. Apply only after the assistant-mode merge (A9).

create table if not exists public.ait_assistant_settings (
  id smallint primary key default 1 check (id = 1),
  filters jsonb not null default '{}'::jsonb,
  max_loss_pct numeric not null default 0.03,
  max_trades integer not null default 4,
  setups text[] not null default array['first pullback', 'pre-market high break', 'news continuation', 'other'],
  updated_at timestamptz not null default now()
);
insert into public.ait_assistant_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.ait_manual_fills (
  id text primary key,                 -- Alpaca activity id
  account_id text not null,
  mode text not null check (mode in ('paper', 'live')),
  symbol text not null,
  side text not null,
  qty numeric not null,
  price numeric not null,
  transaction_time timestamptz not null,
  order_id text,
  imported_at timestamptz not null default now()
);
create index if not exists ait_manual_fills_time on public.ait_manual_fills (transaction_time);

create table if not exists public.ait_trade_plans (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  entry numeric not null,
  stop numeric not null,
  setup text,
  created_at timestamptz not null default now()
);
create index if not exists ait_trade_plans_symbol_time on public.ait_trade_plans (symbol, created_at);

-- Jose's edits per round trip (round trips themselves are rebuilt from the fills)
create table if not exists public.ait_manual_trade_notes (
  trade_key text primary key,
  setup text,
  notes text,
  stop numeric,
  screenshot_path text,
  updated_at timestamptz not null default now()
);

create table if not exists public.ait_assistant_days (
  day date primary key,                -- ET trading day
  start_equity numeric not null,       -- the manual account's last_equity at the first read that day
  recorded_at timestamptz not null default now()
);

create table if not exists public.ait_assistant_alerts (
  id bigserial primary key,
  day date not null,
  symbol text not null,
  price numeric not null,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz not null default now()
);
create index if not exists ait_assistant_alerts_day_symbol on public.ait_assistant_alerts (day, symbol);

create table if not exists public.ait_push_subscriptions (
  endpoint text primary key,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ait_assistant_halts (
  id bigserial primary key,
  symbol text not null,
  status text not null check (status in ('halted', 'resumed', 'luld')),
  reason text,
  at timestamptz not null,
  received_at timestamptz not null default now()
);
create index if not exists ait_assistant_halts_symbol_at on public.ait_assistant_halts (symbol, at desc);

create table if not exists public.ait_edgar_daily (
  symbol text not null,
  day date not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (symbol, day)
);

alter table public.ait_assistant_settings enable row level security;
alter table public.ait_manual_fills enable row level security;
alter table public.ait_trade_plans enable row level security;
alter table public.ait_manual_trade_notes enable row level security;
alter table public.ait_assistant_days enable row level security;
alter table public.ait_assistant_alerts enable row level security;
alter table public.ait_push_subscriptions enable row level security;
alter table public.ait_assistant_halts enable row level security;
alter table public.ait_edgar_daily enable row level security;

-- Screenshots: a private storage bucket (2 MB an image), service-role access only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assistant-screenshots', 'assistant-screenshots', false, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;
