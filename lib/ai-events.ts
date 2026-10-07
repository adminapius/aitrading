import { getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export type AiProvider = 'Gemini-AI' | 'Claude-AI'
export type AiEventType = 'AI_CALL' | 'AI_ERROR'

type AiEventInput = {
  eventType: AiEventType
  provider: AiProvider
  message: string
  payload?: Record<string, unknown>
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

async function countDailyAiEvents(dayStart: Date, eventType: 'AI_CALL' | 'AI_ERROR', provider?: AiProvider) {
  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`)
  const params = new URLSearchParams({
    select: 'id',
    event_type: `eq.${eventType}`,
    created_at: `gte.${dayStart.toISOString()}`,
  })
  if (provider) params.set('symbol', `eq.${provider}`)
  url.search = params.toString()

  const response = await fetch(url, {
    headers: { ...supabaseHeaders(), Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' },
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase AI activity query failed (${response.status}).`)

  const total = response.headers.get('content-range')?.split('/').at(-1)
  if (!total || total === '*' || !/^\d+$/.test(total)) throw new Error('Supabase did not return an exact AI activity count.')
  return Number(total)
}

export async function getDailyAiCallCounts(dayStart: Date) {
  if (getSupabaseConfigurationError()) throw new Error('Supabase is not configured for AI activity history.')

  const providers: AiProvider[] = ['Gemini-AI', 'Claude-AI']
  const counts = await Promise.all(providers.map((provider) => countDailyAiEvents(dayStart, 'AI_CALL', provider)))
  return Object.fromEntries(providers.map((provider, index) => [provider, counts[index]])) as Record<AiProvider, number>
}

export async function getDailyAiActivity(dayStart: Date) {
  if (getSupabaseConfigurationError()) throw new Error('Supabase is not configured for AI activity history.')

  const [calls, errorCount] = await Promise.all([
    getDailyAiCallCounts(dayStart),
    countDailyAiEvents(dayStart, 'AI_ERROR'),
  ])
  return { calls, errorCount }
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
  const errorSummary = activity.errorCount
    ? ` ${activity.errorCount} AI error(s) recorded.`
    : ' No AI errors recorded.'
  const message = `AI calls today — Gemini-AI: ${activity.calls['Gemini-AI']}; Claude-AI: ${activity.calls['Claude-AI']}.${errorSummary}`
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      level: activity.errorCount ? 'warning' : 'info',
      event_type: 'AI_DAILY_SUMMARY',
      message,
      payload: { calls: activity.calls, errorCount: activity.errorCount, dayStart: dayStart.toISOString() },
      created_at: now.toISOString(),
    }),
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase AI summary write failed (${response.status}).`)
  return { recorded: true, calls: activity.calls, errors: activity.errorCount }
}
