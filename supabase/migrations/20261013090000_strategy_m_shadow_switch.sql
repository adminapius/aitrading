-- Database switch for Strategy M (Midday) shadow logging. Default off; no redeploy needed to change it. Idempotent.
alter table public.ait_trading_control add column if not exists strategy_m_shadow boolean not null default false;
comment on column public.ait_trading_control.strategy_m_shadow is 'Strategy M (Midday) shadow logging on/off. Database-only, never places orders.';
