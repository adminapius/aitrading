-- Strategy S & SP rulebook backtest: extra per-trade fields. Nullable, research only, idempotent.
alter table public.ait_backtest_trades add column if not exists version text;
alter table public.ait_backtest_trades add column if not exists setup text;
alter table public.ait_backtest_trades add column if not exists equity_after numeric;
alter table public.ait_backtest_trades add column if not exists units int;
alter table public.ait_backtest_trades add column if not exists partials text;
