-- Append-only audit log of every Alpaca (paper) broker interaction: submits, fills, cancels,
-- stop/target placement, reconciliation, flatten, and test-harness orders. Idempotent.
create table if not exists public.ait_order_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  session_id uuid references public.ait_sessions(id) on delete set null,
  scan_id uuid,
  position_id uuid references public.ait_positions(id) on delete set null,
  symbol text not null check (symbol = '*' or symbol ~ '^[A-Z][A-Z0-9.-]{0,9}$'),
  event text not null check (length(event) between 1 and 64),
  side text check (side is null or side in ('buy', 'sell')),
  qty numeric,
  price numeric,
  client_order_id text,
  broker_order_id text,
  broker_status text,
  test boolean not null default false,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object')
);

create index if not exists ait_order_events_symbol_created_idx on public.ait_order_events (symbol, created_at desc);
create index if not exists ait_order_events_client_order_idx on public.ait_order_events (client_order_id) where client_order_id is not null;
create index if not exists ait_order_events_position_idx on public.ait_order_events (position_id) where position_id is not null;

alter table public.ait_order_events enable row level security;

comment on table public.ait_order_events is 'Audit log of Alpaca PAPER broker interactions (EXECUTION_MODE=alpaca and the /api/admin/test-order harness). Service-role only.';
