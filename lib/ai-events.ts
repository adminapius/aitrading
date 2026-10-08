import { getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export type AiProvider = 'Gemini-AI' | 'Claude-AI'

type AiEventInput = {
  provider: AiProvider
  symbol?: string
  message: string
  payload?: Record<string, unknown>
}


export async function recordAiError({ provider, symbol, message, payload = {} }: AiEventInput) {
  if (getSupabaseConfigurationError()) return false

  try {
    const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        level: 'error',
        event_type: 'AI_ERROR',
        symbol: symbol ?? provider,
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

async function countDailyAiEvents(dayStart: Date, provider: AiProvider) {
  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`)
  const params = new URLSearchParams({
    select: 'id',
    event_type: 'eq.AI_CALL',
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
  const counts = await Promise.all(providers.map((provider) => countDailyAiEvents(dayStart, provider)))
  return Object.fromEntries(providers.map((provider, index) => [provider, counts[index]])) as Record<AiProvider, number>
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

  const calls = await getDailyAiCallCounts(dayStart)
  const message = calls['Gemini-AI'] === 0 && calls['Claude-AI'] === 0
    ? 'Gemini-AI calls: 0; Claude-AI calls: 0. No selected-symbol AI analysis ran today; scanner decisions use fixed rule-based criteria.'
    : `Gemini-AI calls: ${calls['Gemini-AI']}; Claude-AI calls: ${calls['Claude-AI']}. Candidate scanning uses fixed rule-based criteria; AI analysis runs only for selected-symbol requests.`
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      level: 'info',
      event_type: 'AI_DAILY_SUMMARY',
      message,
      payload: { calls, dayStart: dayStart.toISOString() },
      created_at: now.toISOString(),
    }),
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase AI summary write failed (${response.status}).`)
  return { recorded: true, calls }
}
