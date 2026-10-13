// Database-backed TRADING_HALT switch with a daily schedule. No redeploy needed to change it.
//
// The database is the ONLY switch (the old TRADING_HALT environment variable is no longer read).
// Effective halt (blocks NEW entries only; stops, targets and the 15:55 flatten always run):
//   ait_trading_control.trading_halt = true (manual)  -> halted
//   schedule on and now outside open..close ET        -> halted
//   otherwise                                         -> trading
// If the control row cannot be read, entries are blocked (fail closed).

import { easternSchedule } from '@/lib/strategy'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export type TradingControlRow = {
  trading_halt: boolean
  schedule_enabled: boolean
  /** 'HH:MM' Eastern. */
  entries_open_et: string
  entries_close_et: string
  last_effective_halt: boolean | null
  reason: string | null
}

export type TradingControlState = {
  halted: boolean
  source: 'manual' | 'schedule' | 'unavailable' | null
  reason: string | null
  row: TradingControlRow | null
}

function minutes(hhmm: string) {
  const match = /^(\d{1,2}):(\d{2})/.exec(hhmm)
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN
}

/** Pure decision, unit-tested. */
export function effectiveTradingHalt(row: TradingControlRow | null, now: Date): TradingControlState {
  if (!row) return { halted: true, source: 'unavailable', reason: 'Trading control could not be read; entries blocked to be safe', row }
  if (row.trading_halt) return { halted: true, source: 'manual', reason: row.reason || 'Trading paused manually', row }
  if (row.schedule_enabled) {
    const schedule = easternSchedule(now)
    const open = minutes(row.entries_open_et)
    const close = minutes(row.entries_close_et)
    const inside = schedule.isWeekday && Number.isFinite(open) && Number.isFinite(close) && schedule.minuteOfDay >= open && schedule.minuteOfDay < close
    if (!inside) return { halted: true, source: 'schedule', reason: `Outside the ${row.entries_open_et}-${row.entries_close_et} ET buying schedule`, row }
  }
  return { halted: false, source: null, reason: null, row }
}

const CONTROL_URL = () => `${tradingConfig.supabaseUrl}/rest/v1/ait_trading_control`

export async function loadTradingControl(now = new Date()): Promise<TradingControlState> {
  let row: TradingControlRow | null = null
  try {
    const url = new URL(CONTROL_URL())
    url.search = new URLSearchParams({ select: 'trading_halt,schedule_enabled,entries_open_et,entries_close_et,last_effective_halt,reason', id: 'eq.1', limit: '1' }).toString()
    const response = await fetch(url, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5_000), cache: 'no-store' })
    if (response.ok) row = ((await response.json()) as TradingControlRow[])[0] ?? null
  } catch (error) {
    console.error('[trading-control] read failed', error)
  }
  return effectiveTradingHalt(row, now)
}

/** Records a flip of the effective state once (returns true when it changed). */
export async function recordTradingControlTransition(state: TradingControlState) {
  if (!state.row || state.row.last_effective_halt === state.halted) return false
  const url = new URL(CONTROL_URL())
  url.search = new URLSearchParams({ id: 'eq.1' }).toString()
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ last_effective_halt: state.halted, last_transition_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(5_000),
    cache: 'no-store',
  })
  return response.ok
}
