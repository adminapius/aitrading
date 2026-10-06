import { supabaseHeaders, tradingConfig, getSupabaseConfigurationError } from '@/lib/trading-config'
import { easternSchedule } from '@/lib/strategy'

export type ScheduleEventAction = 'wake' | 'sleep'

type ScheduleEventResult = { recorded: boolean; duplicate?: boolean; reason?: string }

function easternDayStart(now: Date) {
  const { year, month, day } = easternSchedule(now)
  const utcGuess = Date.UTC(year, month - 1, day)
  const probe = easternSchedule(new Date(utcGuess))
  const probeAsLocalUtc = Date.UTC(probe.year, probe.month - 1, probe.day, probe.hour, probe.minute)
  return new Date(utcGuess - (probeAsLocalUtc - utcGuess))
}

export async function recordScheduleEvent(action: ScheduleEventAction, now = new Date()): Promise<ScheduleEventResult> {
  const schedule = easternSchedule(now)
  if (!schedule.isWeekday) return { recorded: false, reason: 'outside_schedule' }

  const expectedMinute = action === 'wake' ? 7 * 60 : 15 * 60 + 55
  if (schedule.minuteOfDay < expectedMinute || schedule.minuteOfDay >= expectedMinute + 5) {
    return { recorded: false, reason: 'outside_schedule' }
  }

  const configurationError = getSupabaseConfigurationError()
  if (configurationError) throw new Error(configurationError)

  const symbol = action === 'wake' ? 'WAKE' : 'SLEEP'
  const existingUrl = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`)
  existingUrl.search = new URLSearchParams({
    select: 'id',
    event_type: 'eq.SYSTEM',
    symbol: `eq.${symbol}`,
    created_at: `gte.${easternDayStart(now).toISOString()}`,
    limit: '1',
  }).toString()

  const existingResponse = await fetch(existingUrl, { headers: supabaseHeaders(), cache: 'no-store' })
  if (!existingResponse.ok) throw new Error(`Supabase schedule-event check failed (${existingResponse.status})`)
  const existing = await existingResponse.json() as Array<{ id: number }>
  if (existing.length) return { recorded: false, duplicate: true }

  const message = action === 'wake'
    ? "AI trading App is AWAKE NOW let's make this day GREEN DAY!"
    : 'AI trading App is SLEEPING NOW, be back on 7am ET.'
  const insertResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ level: 'info', event_type: 'SYSTEM', symbol, message, payload: { schedule: action } }),
    cache: 'no-store',
  })
  if (!insertResponse.ok) throw new Error(`Supabase schedule-event write failed (${insertResponse.status})`)
  return { recorded: true }
}

export function easternFourAmCutoff(now: Date) {
  const schedule = easternSchedule(now)
  const cutoffDay = new Date(Date.UTC(schedule.year, schedule.month - 1, schedule.day - (schedule.minuteOfDay < 4 * 60 ? 1 : 0)))
  return cutoffDay.toISOString().slice(0, 10)
}

export function easternDateKey(now: Date) {
  const { year, month, day } = easternSchedule(now)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function easternMinuteOfDay(now: Date) {
  return easternSchedule(now).minuteOfDay
}

export function easternDateKeyFromTimestamp(timestamp: string) {
  return easternDateKey(new Date(timestamp))
}

export function easternMinuteFromTimestamp(timestamp: string) {
  return easternMinuteOfDay(new Date(timestamp))
}

export function shouldShowEventAfterFourAm(timestamp: string, now: Date) {
  const eventDay = easternDateKeyFromTimestamp(timestamp)
  const cutoffDay = easternFourAmCutoff(now)
  return eventDay > cutoffDay || (eventDay === cutoffDay && easternMinuteFromTimestamp(timestamp) >= 4 * 60)
}

export function eventActionAtSchedule(action: ScheduleEventAction, now: Date) {
  const schedule = easternSchedule(now)
  const expectedMinute = action === 'wake' ? 7 * 60 : 15 * 60 + 55
  return schedule.isWeekday && schedule.minuteOfDay >= expectedMinute && schedule.minuteOfDay < expectedMinute + 5
}

export function currentEasternSchedule(now: Date) {
  return easternSchedule(now)
}

export function sameEasternDay(left: Date, right: Date) {
  return easternDateKey(left) === easternDateKey(right)
}

export function minuteToEasternLabel(minute: number) {
  const hour24 = Math.floor(minute / 60)
  const hour12 = hour24 % 12 || 12
  return `${hour12}:${String(minute % 60).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'} ET`
}

export function isEasternWeekday(now: Date) {
  return easternSchedule(now).isWeekday
}

export function isScheduleWindow(now: Date) {
  const { scanWindow, flattenWindow } = easternSchedule(now)
  return scanWindow || flattenWindow
}

export function scheduleDayKey(now: Date) {
  return easternDateKey(now)
}

export function getEasternScheduleMinute(now: Date) {
  return easternMinuteOfDay(now)
}

export function getEasternWeekday(now: Date) {
  return easternSchedule(now).weekday
}

export function isSameEasternDate(left: string, right: string) {
  return easternDateKeyFromTimestamp(left) === easternDateKeyFromTimestamp(right)
}

export function getEasternScheduleState(now: Date) {
  return easternSchedule(now)
}

export function scheduleWindowAction(now: Date): ScheduleEventAction | null {
  if (eventActionAtSchedule('wake', now)) return 'wake'
  if (eventActionAtSchedule('sleep', now)) return 'sleep'
  return null
}

export function scheduleEventActionForMinute(minuteOfDay: number): ScheduleEventAction | null {
  if (minuteOfDay >= 7 * 60 && minuteOfDay < 7 * 60 + 5) return 'wake'
  if (minuteOfDay >= 15 * 60 + 55 && minuteOfDay < 16 * 60) return 'sleep'
  return null
}

export function isEasternScanningAllowed(now: Date) {
  return easternSchedule(now).scanWindow
}

export function isEasternFlattenWindow(now: Date) {
  return easternSchedule(now).flattenWindow
}

export function easternScheduleStatus(now: Date) {
  const state = easternSchedule(now)
  if (state.flattenWindow) return 'flatten'
  return state.scanWindow ? 'active' : 'sleeping'
}

export function shouldClearEventLog(now: Date) {
  return easternSchedule(now).minuteOfDay >= 4 * 60
}

export function isWeekdayAtSevenEt(now: Date) {
  const state = easternSchedule(now)
  return state.isWeekday && state.minuteOfDay >= 7 * 60 && state.minuteOfDay < 7 * 60 + 5
}

export function isWeekdayAtFlattenEt(now: Date) {
  const state = easternSchedule(now)
  return state.isWeekday && state.minuteOfDay >= 15 * 60 + 55 && state.minuteOfDay < 16 * 60
}

export function scheduleStartOfDayUtc(now: Date) {
  return easternDayStart(now)
}

export function isDuringScheduleEventWindow(action: ScheduleEventAction, now: Date) {
  return eventActionAtSchedule(action, now)
}

export function easternWeekdayAndMinute(now: Date) {
  const state = easternSchedule(now)
  return { isWeekday: state.isWeekday, minuteOfDay: state.minuteOfDay }
}

export function isAppAwake(now: Date) {
  return easternSchedule(now).scanWindow
}

export function isAppSleeping(now: Date) {
  const state = easternSchedule(now)
  return !state.scanWindow && !state.flattenWindow
}

export function isFlattening(now: Date) {
  return easternSchedule(now).flattenWindow
}

export function scheduleNextWakeLabel() {
  return '7:00 AM ET'
}

export function scheduleClearTimeLabel() {
  return '4:00 AM ET'
}

export function validateScheduleAction(action: unknown): action is ScheduleEventAction {
  return action === 'wake' || action === 'sleep'
}

export function scheduledEventSymbol(action: ScheduleEventAction) {
  return action === 'wake' ? 'WAKE' : 'SLEEP'
}

export function scheduledEventMessage(action: ScheduleEventAction) {
  return action === 'wake'
    ? "AI trading App is AWAKE NOW let's make this day GREEN DAY!"
    : 'AI trading App is SLEEPING NOW, be back on 7am ET.'
}

export function scheduleEventType() {
  return 'SYSTEM'
}

export function eventIsFromToday(timestamp: string, now: Date) {
  return easternDateKeyFromTimestamp(timestamp) === easternDateKey(now)
}

export function scheduleMinuteLabel(now: Date) {
  return minuteToEasternLabel(easternMinuteOfDay(now))
}

export function isFlattenOrClosed(now: Date) {
  return easternScheduleStatus(now) !== 'active'
}

export function scannerStatus(now: Date) {
  return easternScheduleStatus(now)
}

export function scheduleWakeMinute() {
  return 7 * 60
}

export function scheduleSleepMinute() {
  return 15 * 60 + 55
}

export function scheduleClearMinute() {
  return 4 * 60
}
