import { getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export type AiProvider = 'Gemini-AI' | 'Claude-AI'
export type AiEventType = 'AI_CALL' | 'AI_ERROR'

type AiEventInput = {
  eventType: AiEventType
  provider: AiProvider
  message: string
  payload?: Record<string, unknown>
}

type DailyAiEvent = {
  event_type: AiEventType
  symbol: AiProvider | null
  message: string
  created_at: string
}

export async function recordAiEvent({ eventType, provider, message, payload = {} }: AiEventInput) {
  if (getSupabaseConfigurationError()) return false

  try {
    const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        level: eventType === 'AI_ERROR' ? 'error' : 'info',
        event_type: eventType,
        symbol: provider,
        message: message.slice(0, 240),
        payload: { provider, ...payload },
      }),
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    })
    return response.ok
  } catch {
    return false
  }
}

export async function getDailyAiActivity(dayStart: Date) {
  if (getSupabaseConfigurationError()) throw new Error('Supabase is not configured for AI activity history.')

  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`)
  url.search = new URLSearchParams({
    select: 'event_type,symbol,message,created_at',
    event_type: 'in.(AI_CALL,AI_ERROR)',
    created_at: `gte.${dayStart.toISOString()}`,
    order: 'created_at.asc',
    limit: '1000',
  }).toString()

  const response = await fetch(url, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5000), cache: 'no-store' })
  if (!response.ok) throw new Error(`Supabase AI activity query failed (${response.status}).`)

  const events = await response.json() as DailyAiEvent[]
  const providers: AiProvider[] = ['Gemini-AI', 'Claude-AI']
  const calls = Object.fromEntries(providers.map((provider) => [
    provider,
    events.filter((event) => event.event_type === 'AI_CALL' && event.symbol === provider).length,
  ])) as Record<AiProvider, number>
  const errors = events
    .filter((event) => event.event_type === 'AI_ERROR')
    .map(({ symbol, message, created_at }) => ({ provider: symbol, message, created_at }))

  return { calls, errors }
}

export async function recordDailyAiSummary(dayStart: Date, now: Date) {
  if (getSupabaseConfigurationError()) throw new Error('Supabase is not configured for AI activity history.')

  const summaryUrl = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`)
  summaryUrl.search = new URLSearchParams({
    select: 'id',
    event_type: 'eq.AI_DAILY_SUMMARY',
    created_at: `gte.${dayStart.toISOString()}`,
    limit: '1',
  }).toString()
  const existingResponse = await fetch(summaryUrl, { headers: supabaseHeaders(), signal: AbortSignal.timeout(5000), cache: 'no-store' })
  if (!existingResponse.ok) throw new Error(`Supabase AI summary check failed (${existingResponse.status}).`)
  const existing = await existingResponse.json() as Array<{ id: number }>
  if (existing.length) return { recorded: false, duplicate: true }

  const activity = await getDailyAiActivity(dayStart)
  const errorSummary = activity.errors.length
    ? ` ${activity.errors.length} AI error(s) recorded.`
    : ' No AI errors recorded.'
  const message = `AI calls today — Gemini-AI: ${activity.calls['Gemini-AI']}; Claude-AI: ${activity.calls['Claude-AI']}.${errorSummary}`
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      level: activity.errors.length ? 'warning' : 'info',
      event_type: 'AI_DAILY_SUMMARY',
      message,
      payload: { calls: activity.calls, errors: activity.errors, dayStart: dayStart.toISOString() },
      created_at: now.toISOString(),
    }),
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase AI summary write failed (${response.status}).`)
  return { recorded: true, calls: activity.calls, errors: activity.errors.length }
}
