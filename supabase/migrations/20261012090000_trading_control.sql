-- Database-backed TRADING_HALT switch with a daily buying schedule (no redeploy to change it).
-- trading_halt = manual pause. schedule_enabled + entries_open_et/close_et = automatic daily window.
-- Only NEW entries are affected; stops, targets and the 15:55 flatten always run. Idempotent.
create table if not exists public.ait_trading_control (
  id smallint primary key default 1 check (id = 1),
  trading_halt boolean not null default false,
  schedule_enabled boolean not null default true,
  entries_open_et time not null default '07:00',
  entries_close_et time not null default '11:00',
  reason text,
  last_effective_halt boolean,
  last_transition_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into public.ait_trading_control (id) values (1) on conflict (id) do nothing;

alter table public.ait_trading_control enable row level security;

comment on table public.ait_trading_control is 'Single-row TRADING_HALT switch + daily ET buying schedule read by the worker every scan. Service-role only.';
