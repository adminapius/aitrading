alter table public.ait_sessions
  add column if not exists starting_equity numeric(14,2);

create table if not exists public.ait_scan_runs (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null unique,
  session_id uuid references public.ait_sessions(id),
  trigger_source text not null default 'api',
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  scanned_candidates integer not null default 0 check (scanned_candidates >= 0),
  buy_candidates integer not null default 0 check (buy_candidates >= 0),
  scan_duration_ms integer check (scan_duration_ms >= 0),
  error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists ait_scan_runs_started_at_idx
  on public.ait_scan_runs (started_at desc);

alter table public.ait_scan_runs enable row level security;
grant select, insert, update on public.ait_scan_runs to service_role;

alter table public.ait_trades
  add column if not exists idempotency_key text;

create unique index if not exists ait_trades_idempotency_key_idx
  on public.ait_trades (idempotency_key)
  where idempotency_key is not null;

alter table public.ait_strategy_signals
  drop constraint if exists ait_strategy_signals_action_check;

update public.ait_strategy_signals
set action = 'enter'
where action = 'buy';

alter table public.ait_strategy_signals
  add constraint ait_strategy_signals_action_check
  check (action in ('enter', 'sell', 'hold', 'reject'));

create or replace function public.ensure_ait_scan_session(
  p_trading_date date,
  p_started_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_id uuid;
  account_equity numeric(14,2);
begin
  select equity into account_equity
  from public.ait_papermoney
  where account_name = 'paper-main' and is_active = true
  order by created_at asc
  limit 1;

  insert into public.ait_sessions (trading_date, timezone, status, started_at, starting_equity)
  values (p_trading_date, 'America/New_York', 'awake', p_started_at, account_equity)
  on conflict (trading_date) do update
    set status = case when public.ait_sessions.status = 'sleeping' then 'awake' else public.ait_sessions.status end,
        started_at = coalesce(public.ait_sessions.started_at, excluded.started_at),
        starting_equity = coalesce(public.ait_sessions.starting_equity, excluded.starting_equity)
  returning id into session_id;

  return session_id;
end;
$$;

create or replace function public.mark_ait_paper_position(
  p_position_id uuid,
  p_mark_price numeric
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_row public.ait_papermoney%rowtype;
  position_row public.ait_positions%rowtype;
  marked_equity numeric(14,2);
  marked_unrealized numeric(14,2);
begin
  if p_mark_price is null or p_mark_price <= 0 then
    return jsonb_build_object('status', 'invalid_mark');
  end if;

  select * into account_row
  from public.ait_papermoney
  where account_name = 'paper-main' and is_active = true
  order by created_at asc
  limit 1
  for update;

  if not found then return jsonb_build_object('status', 'account_missing'); end if;

  select * into position_row
  from public.ait_positions
  where id = p_position_id and status = 'open'
  for update;

  if not found then return jsonb_build_object('status', 'position_closed'); end if;

  update public.ait_positions
  set current_price = p_mark_price,
      unrealized_pnl = round((p_mark_price - entry_price) * quantity, 2)
  where id = p_position_id;

  select
    account_row.cash_balance + coalesce(sum(
      case
        when metadata ->> 'marginReserve' ~ '^[0-9]+([.][0-9]+)?$' then (metadata ->> 'marginReserve')::numeric
        else quantity * entry_price
      end + (coalesce(current_price, entry_price) - entry_price) * quantity
    ), 0),
    coalesce(sum((coalesce(current_price, entry_price) - entry_price) * quantity), 0)
  into marked_equity, marked_unrealized
  from public.ait_positions
  where status = 'open';

  update public.ait_papermoney
  set equity = round(marked_equity, 2),
      unrealized_pnl = round(marked_unrealized, 2),
      updated_at = clock_timestamp()
  where id = account_row.id;

  return jsonb_build_object('status', 'marked', 'equity', round(marked_equity, 2));
end;
$$;

create or replace function public.open_ait_paper_position(
  p_session_id uuid,
  p_scan_id uuid,
  p_symbol text,
  p_quantity integer,
  p_requested_price numeric,
  p_fill_price numeric,
  p_stop_price numeric,
  p_target_price numeric,
  p_risk_per_share numeric,
  p_idempotency_key text,
  p_max_position_fraction numeric,
  p_max_aggregate_exposure_fraction numeric,
  p_risk_per_trade_fraction numeric,
  p_max_daily_loss_fraction numeric,
  p_max_open_positions integer,
  p_minimum_margin_equity numeric,
  p_reentry_cooldown_minutes integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_row public.ait_papermoney%rowtype;
  prior_trade public.ait_trades%rowtype;
  session_start_equity numeric(14,2);
  current_equity numeric(14,2);
  current_exposure numeric(14,2);
  current_position_count integer;
  daily_pnl numeric(14,2);
  order_notional numeric(14,2);
  required_margin numeric(14,2);
  position_id uuid;
  blocked_reason text;
begin
  if p_session_id is null or p_scan_id is null
     or p_symbol is null or p_symbol !~ '^[A-Z][A-Z0-9.-]{0,9}$'
     or p_quantity is null or p_quantity < 1
     or p_requested_price is null or p_requested_price <= 0
     or p_fill_price is null or p_fill_price <= 0
     or p_stop_price is null or p_stop_price <= 0 or p_stop_price >= p_fill_price
     or p_target_price is null or p_target_price <= p_fill_price
     or p_risk_per_share is null or p_risk_per_share <= 0
     or p_idempotency_key is null or length(p_idempotency_key) < 1 or length(p_idempotency_key) > 200
     or p_max_position_fraction is null or p_max_position_fraction <= 0 or p_max_position_fraction > 1
     or p_max_aggregate_exposure_fraction is null or p_max_aggregate_exposure_fraction <= 0 or p_max_aggregate_exposure_fraction > 2
     or p_risk_per_trade_fraction is null or p_risk_per_trade_fraction <= 0 or p_risk_per_trade_fraction > 0.1
     or p_max_daily_loss_fraction is null or p_max_daily_loss_fraction <= 0 or p_max_daily_loss_fraction > 1
     or p_max_open_positions is null or p_max_open_positions < 1 or p_max_open_positions > 10
     or p_minimum_margin_equity is null or p_minimum_margin_equity <= 0
     or p_reentry_cooldown_minutes is null or p_reentry_cooldown_minutes < 0 or p_reentry_cooldown_minutes > 1440 then
    return jsonb_build_object('status', 'invalid_order');
  end if;

  select * into prior_trade
  from public.ait_trades
  where idempotency_key = p_idempotency_key
  limit 1;
  if found then
    return jsonb_build_object('status', 'already_executed', 'tradeId', prior_trade.id, 'positionId', prior_trade.position_id);
  end if;

  select * into account_row
  from public.ait_papermoney
  where account_name = 'paper-main' and is_active = true
  order by created_at asc
  limit 1
  for update;
  if not found then return jsonb_build_object('status', 'account_missing'); end if;

  select * into prior_trade
  from public.ait_trades
  where idempotency_key = p_idempotency_key
  limit 1;
  if found then
    return jsonb_build_object('status', 'already_executed', 'tradeId', prior_trade.id, 'positionId', prior_trade.position_id);
  end if;

  if (extract(isodow from now() at time zone 'America/New_York')::integer > 5)
     or ((now() at time zone 'America/New_York')::time < time '07:00')
     or ((now() at time zone 'America/New_York')::time >= time '15:55') then
    return jsonb_build_object('status', 'outside_entry_window');
  end if;

  select coalesce(starting_equity, account_row.starting_balance)
  into session_start_equity
  from public.ait_sessions
  where id = p_session_id;
  session_start_equity := coalesce(session_start_equity, account_row.starting_balance);

  select
    account_row.cash_balance + coalesce(sum(
      case
        when metadata ->> 'marginReserve' ~ '^[0-9]+([.][0-9]+)?$' then (metadata ->> 'marginReserve')::numeric
        else quantity * entry_price
      end + (coalesce(current_price, entry_price) - entry_price) * quantity
    ), 0),
    coalesce(sum(quantity * coalesce(current_price, entry_price)), 0),
    count(*)::integer
  into current_equity, current_exposure, current_position_count
  from public.ait_positions
  where status = 'open';
  current_equity := coalesce(current_equity, account_row.cash_balance);
  current_exposure := coalesce(current_exposure, 0);
  current_position_count := coalesce(current_position_count, 0);
  daily_pnl := current_equity - session_start_equity;

  if daily_pnl <= -(session_start_equity * p_max_daily_loss_fraction) then
    blocked_reason := 'daily loss guardrail reached';
  elsif exists (select 1 from public.ait_positions where status = 'open' and symbol = p_symbol) then
    blocked_reason := 'position already open for symbol';
  elsif current_position_count >= p_max_open_positions then
    blocked_reason := 'maximum open positions reached';
  elsif exists (
    select 1
    from public.ait_trades
    where symbol = p_symbol
      and side = 'sell'
      and status = 'filled'
      and metadata ->> 'exitReason' = 'protective stop reached'
      and filled_at >= clock_timestamp() - make_interval(mins => p_reentry_cooldown_minutes)
  ) then
    blocked_reason := 're-entry cooldown after protective stop';
  end if;

  order_notional := p_quantity * p_fill_price;
  required_margin := case
    when current_equity >= p_minimum_margin_equity then round(order_notional / 2, 2)
    else order_notional
  end;
  if blocked_reason is null and order_notional > current_equity * p_max_position_fraction then
    blocked_reason := 'maximum position fraction exceeded';
  elsif blocked_reason is null and order_notional > current_equity * p_max_aggregate_exposure_fraction - current_exposure then
    blocked_reason := 'maximum aggregate exposure exceeded';
  elsif blocked_reason is null and p_quantity * p_risk_per_share > current_equity * p_risk_per_trade_fraction then
    blocked_reason := 'risk per trade limit exceeded';
  elsif blocked_reason is null and current_equity >= p_minimum_margin_equity and order_notional > greatest(0, current_equity * 2 - current_exposure) then
    blocked_reason := 'paper margin buying power is insufficient';
  elsif blocked_reason is null and required_margin > account_row.cash_balance then
    blocked_reason := case when current_equity >= p_minimum_margin_equity then 'paper margin reserve exceeds available cash' else 'cash-only buying power is insufficient below the margin equity threshold' end;
  end if;

  if blocked_reason is not null then
    insert into public.ait_logevents (session_id, level, event_type, message, symbol, payload)
    values (p_session_id, 'warning', 'ENTRY_BLOCKED', blocked_reason, p_symbol,
      jsonb_build_object('scanId', p_scan_id, 'idempotencyKey', p_idempotency_key));
    return jsonb_build_object('status', 'blocked', 'reason', blocked_reason);
  end if;

  insert into public.ait_positions (
    symbol, side, quantity, entry_price, current_price, stop_price, target_price,
    unrealized_pnl, status, opened_at, metadata
  ) values (
    p_symbol, 'long', p_quantity, p_fill_price, p_fill_price, p_stop_price, p_target_price,
    0, 'open', clock_timestamp(),
    jsonb_build_object('scanId', p_scan_id, 'riskPerShare', p_risk_per_share, 'marginReserve', required_margin, 'executionMode', case when current_equity >= p_minimum_margin_equity then 'paper-margin-2x' else 'paper-cash-only' end)
  ) returning id into position_id;

  insert into public.ait_trades (
    session_id, position_id, symbol, side, quantity, requested_price, filled_price,
    status, broker_order_id, order_type, submitted_at, filled_at, metadata, idempotency_key
  ) values (
    p_session_id, position_id, p_symbol, 'buy', p_quantity, p_requested_price, p_fill_price,
    'filled', null, 'paper-market', clock_timestamp(), clock_timestamp(),
    jsonb_build_object('scanId', p_scan_id, 'executionMode', case when current_equity >= p_minimum_margin_equity then 'paper-margin-2x' else 'paper-cash-only' end, 'liveTradingEnabled', false),
    p_idempotency_key
  );

  update public.ait_papermoney
  set cash_balance = round(cash_balance - required_margin, 2),
      equity = round(current_equity, 2),
      updated_at = clock_timestamp()
  where id = account_row.id;

  insert into public.ait_logevents (session_id, level, event_type, message, symbol, payload)
  values (p_session_id, 'success', 'PAPER_ORDER_FILLED', 'Paper-only margin-plan entry filled; no broker order was sent.', p_symbol,
    jsonb_build_object('scanId', p_scan_id, 'positionId', position_id, 'quantity', p_quantity, 'fillPrice', p_fill_price, 'idempotencyKey', p_idempotency_key));

  return jsonb_build_object('status', 'filled', 'positionId', position_id, 'quantity', p_quantity, 'fillPrice', p_fill_price);
end;
$$;

create or replace function public.close_ait_paper_position(
  p_session_id uuid,
  p_position_id uuid,
  p_fill_price numeric,
  p_exit_reason text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_row public.ait_papermoney%rowtype;
  position_row public.ait_positions%rowtype;
  prior_trade public.ait_trades%rowtype;
  realized numeric(14,2);
  updated_cash numeric(14,2);
  updated_equity numeric(14,2);
  updated_unrealized numeric(14,2);
  margin_reserve numeric(14,2);
  closed_trade_id uuid;
begin
  if p_session_id is null or p_position_id is null
     or p_fill_price is null or p_fill_price <= 0
     or p_idempotency_key is null or length(p_idempotency_key) < 1 or length(p_idempotency_key) > 200
     or p_exit_reason is null or length(p_exit_reason) < 1 or length(p_exit_reason) > 200 then
    return jsonb_build_object('status', 'invalid_exit');
  end if;

  select * into prior_trade
  from public.ait_trades
  where idempotency_key = p_idempotency_key
  limit 1;
  if found then return jsonb_build_object('status', 'already_executed', 'tradeId', prior_trade.id); end if;

  select * into account_row
  from public.ait_papermoney
  where account_name = 'paper-main' and is_active = true
  order by created_at asc
  limit 1
  for update;
  if not found then return jsonb_build_object('status', 'account_missing'); end if;

  select * into prior_trade
  from public.ait_trades
  where idempotency_key = p_idempotency_key
  limit 1;
  if found then return jsonb_build_object('status', 'already_executed', 'tradeId', prior_trade.id); end if;

  select * into position_row
  from public.ait_positions
  where id = p_position_id and status = 'open'
  for update;
  if not found then return jsonb_build_object('status', 'position_closed'); end if;

  realized := round((p_fill_price - position_row.entry_price) * position_row.quantity, 2);
  margin_reserve := case
    when position_row.metadata ->> 'marginReserve' ~ '^[0-9]+([.][0-9]+)?$' then (position_row.metadata ->> 'marginReserve')::numeric
    else position_row.entry_price * position_row.quantity
  end;
  updated_cash := account_row.cash_balance + margin_reserve + realized;

  update public.ait_positions
  set current_price = p_fill_price,
      unrealized_pnl = 0,
      status = 'closed',
      closed_at = clock_timestamp(),
      metadata = metadata || jsonb_build_object('exitReason', p_exit_reason)
  where id = p_position_id;

  insert into public.ait_trades (
    session_id, position_id, symbol, side, quantity, requested_price, filled_price,
    status, order_type, submitted_at, filled_at, realized_pnl, metadata, idempotency_key
  ) values (
    p_session_id, p_position_id, position_row.symbol, 'sell', position_row.quantity, p_fill_price, p_fill_price,
    'filled', 'paper-market', clock_timestamp(), clock_timestamp(), realized,
    jsonb_build_object('exitReason', p_exit_reason, 'executionMode', 'paper-margin', 'liveTradingEnabled', false),
    p_idempotency_key
  ) returning id into closed_trade_id;

  select
    updated_cash + coalesce(sum(
      case
        when metadata ->> 'marginReserve' ~ '^[0-9]+([.][0-9]+)?$' then (metadata ->> 'marginReserve')::numeric
        else quantity * entry_price
      end + (coalesce(current_price, entry_price) - entry_price) * quantity
    ), 0),
    coalesce(sum((coalesce(current_price, entry_price) - entry_price) * quantity), 0)
  into updated_equity, updated_unrealized
  from public.ait_positions
  where status = 'open';

  update public.ait_papermoney
  set cash_balance = round(updated_cash, 2),
      equity = round(updated_equity, 2),
      realized_pnl = round(realized_pnl + realized, 2),
      unrealized_pnl = round(updated_unrealized, 2),
      updated_at = clock_timestamp()
  where id = account_row.id;

  insert into public.ait_logevents (session_id, level, event_type, message, symbol, payload)
  values (p_session_id, case when realized >= 0 then 'success' else 'warning' end, 'PAPER_POSITION_CLOSED', 'Paper-only position closed; no broker order was sent.', position_row.symbol,
    jsonb_build_object('tradeId', closed_trade_id, 'positionId', p_position_id, 'quantity', position_row.quantity, 'fillPrice', p_fill_price, 'realizedPnl', realized, 'exitReason', p_exit_reason, 'idempotencyKey', p_idempotency_key));

  return jsonb_build_object('status', 'closed', 'tradeId', closed_trade_id, 'realizedPnl', realized);
end;
$$;

revoke all on function public.ensure_ait_scan_session(date, timestamptz) from public, anon, authenticated;
grant execute on function public.ensure_ait_scan_session(date, timestamptz) to service_role;
revoke all on function public.mark_ait_paper_position(uuid, numeric) from public, anon, authenticated;
revoke all on function public.open_ait_paper_position(uuid, uuid, text, integer, numeric, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, numeric, integer, numeric, integer) from public, anon, authenticated;
revoke all on function public.close_ait_paper_position(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.mark_ait_paper_position(uuid, numeric) to service_role;
grant execute on function public.open_ait_paper_position(uuid, uuid, text, integer, numeric, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, numeric, integer, numeric, integer) to service_role;
grant execute on function public.close_ait_paper_position(uuid, uuid, numeric, text, text) to service_role;

comment on table public.ait_scan_runs is 'One heartbeat per worker scan, including zero-candidate and failed scans.';
comment on function public.open_ait_paper_position(uuid, uuid, text, integer, numeric, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, numeric, integer, numeric, integer) is 'Atomically enters a paper long position with sizing, margin, loss, cooldown, exposure, and idempotency guardrails; never contacts a broker.';
comment on function public.close_ait_paper_position(uuid, uuid, numeric, text, text) is 'Atomically closes a paper long position and updates the ledger; never contacts a broker.';

-- Post-migration verification:
-- select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ait_scan_runs' order by ordinal_position;
-- select proname from pg_proc join pg_namespace on pg_namespace.oid = pg_proc.pronamespace where nspname = 'public' and proname in ('open_ait_paper_position', 'close_ait_paper_position', 'mark_ait_paper_position', 'ensure_ait_scan_session');
-- select polname, tablename from pg_policies where schemaname = 'public' and tablename = 'ait_scan_runs';
-- select account_name, cash_balance, equity, realized_pnl from public.ait_papermoney where account_name = 'paper-main' and is_active = true;
-- select action, count(*) from public.ait_strategy_signals group by action order by action;
-- select status, count(*) from public.ait_scan_runs group by status order by status;
-- select idempotency_key, count(*) from public.ait_trades where idempotency_key is not null group by idempotency_key having count(*) > 1;
-- select id, status, quantity, entry_price, current_price from public.ait_positions where status = 'open' order by opened_at desc;
-- select action in ('enter', 'sell', 'hold', 'reject') as valid_action from public.ait_strategy_signals limit 1;
-- select indexname from pg_indexes where schemaname = 'public' and tablename = 'ait_trades' and indexname = 'ait_trades_idempotency_key_idx';
-- select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'ait_scan_runs';
-- The protected RPCs are executable only by service_role; public/anon/authenticated are explicitly revoked.
-- To verify entry behavior without creating a lasting paper trade, use a database transaction and ROLLBACK in SQL Editor after supplying a valid session, candidate, and current account values.
-- To verify close behavior, use a disposable open paper position in a transaction and ROLLBACK; do not use production account rows for destructive verification.
-- Margin mode is paper-only. The guardrails cap notional at 25% per position and 75% aggregate, and cash is debited only after those checks.
-- The app must remain liveTradingEnabled=false; no Alpaca order endpoint is called by these functions.
