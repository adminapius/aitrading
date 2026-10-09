-- Allow ait_shadow_signals to record the shadow strategy (Strategy A) alongside Elliott Wave rules. Idempotent.
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'ait_shadow_signals'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%rule%ew_wave3%'
  loop
    execute format('alter table public.ait_shadow_signals drop constraint %I', constraint_row.conname);
  end loop;
end $$;

alter table public.ait_shadow_signals
  add constraint ait_shadow_signals_rule_check
  check (rule in ('ew_wave3', 'ew_wave4', 'ew_block_wave5', 'ew_exit_signal', 'strategy_a'));

create index if not exists ait_shadow_signals_strategy_open_idx
  on public.ait_shadow_signals (session_id, symbol)
  where outcome is null and rule = 'strategy_a';

comment on table public.ait_shadow_signals is 'Shadow-only Elliott Wave setups, shadow-strategy (strategy_a) would-be entries, simulated fills, and exit comparisons. Never an execution instruction.';
