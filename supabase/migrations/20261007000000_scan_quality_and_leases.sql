alter table public.ait_watchlist_scans
  add column if not exists scan_id uuid,
  add column if not exists last_trade_at timestamptz,
  add column if not exists spread_pct numeric(10, 4),
  add column if not exists trigger_source text,
  add column if not exists scan_duration_ms integer;

create index if not exists ait_watchlist_scans_scan_id_idx on public.ait_watchlist_scans (scan_id);

create table if not exists public.ait_scan_leases (
  lock_key text primary key,
  owner_token uuid,
  expires_at timestamptz not null default now(),
  last_started_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.ait_scan_leases enable row level security;

create or replace function public.claim_ait_scan_lease(
  p_lock_key text,
  p_owner_token uuid,
  p_lease_seconds integer,
  p_minimum_interval_seconds integer
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean;
begin
  insert into public.ait_scan_leases (lock_key, owner_token, expires_at, last_started_at, updated_at)
  values (
    p_lock_key,
    p_owner_token,
    clock_timestamp() + make_interval(secs => greatest(1, least(p_lease_seconds, 300))),
    clock_timestamp(),
    clock_timestamp()
  )
  on conflict (lock_key) do update
    set owner_token = excluded.owner_token,
        expires_at = excluded.expires_at,
        last_started_at = excluded.last_started_at,
        updated_at = excluded.updated_at
    where public.ait_scan_leases.expires_at <= clock_timestamp()
      and (
        public.ait_scan_leases.last_started_at is null
        or public.ait_scan_leases.last_started_at <= clock_timestamp() - make_interval(secs => greatest(0, p_minimum_interval_seconds))
      )
  returning true into claimed;

  if claimed then return 'acquired'; end if;
  if exists (
    select 1 from public.ait_scan_leases
    where lock_key = p_lock_key and expires_at > clock_timestamp()
  ) then return 'busy'; end if;
  return 'cooldown';
end;
$$;

create or replace function public.release_ait_scan_lease(
  p_lock_key text,
  p_owner_token uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  released boolean;
begin
  update public.ait_scan_leases
  set owner_token = null, expires_at = clock_timestamp(), updated_at = clock_timestamp()
  where lock_key = p_lock_key and owner_token = p_owner_token
  returning true into released;
  return coalesce(released, false);
end;
$$;

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
begin
  insert into public.ait_sessions (trading_date, timezone, status, started_at)
  values (p_trading_date, 'America/New_York', 'awake', p_started_at)
  on conflict (trading_date) do update
    set status = case when public.ait_sessions.status = 'sleeping' then 'awake' else public.ait_sessions.status end,
        started_at = coalesce(public.ait_sessions.started_at, excluded.started_at)
  returning id into session_id;
  return session_id;
end;
$$;

revoke all on function public.claim_ait_scan_lease(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.release_ait_scan_lease(text, uuid) from public, anon, authenticated;
revoke all on function public.ensure_ait_scan_session(date, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_ait_scan_lease(text, uuid, integer, integer) to service_role;
grant execute on function public.release_ait_scan_lease(text, uuid) to service_role;
grant execute on function public.ensure_ait_scan_session(date, timestamptz) to service_role;
