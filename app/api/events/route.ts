import { NextRequest, NextResponse } from 'next/server'
import { getDailyAiCallCounts } from '@/lib/ai-events'
import { getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { easternFourAmCutoff, shouldShowEventAfterFourAm } from '@/lib/scheduled-events'

export const dynamic = 'force-dynamic'

type EventRow = { id: string; level: string; event_type: string; message: string; symbol?: string | null; created_at: string }

export async function GET(request: NextRequest) {
  const requestedLimit = Number(request.nextUrl.searchParams.get('limit') ?? 20)
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 20
  const now = new Date()
  const resetAt = easternFourAmCutoff(now)
  const configurationError = getSupabaseConfigurationError()
  if (configurationError) return NextResponse.json({ events: [], degraded: true, degradedReason: configurationError })

  let aiCalls: Awaited<ReturnType<typeof getDailyAiCallCounts>> | undefined
  let aiCallsError: string | undefined
  try {
    aiCalls = await getDailyAiCallCounts(resetAt)
  } catch {
    aiCallsError = 'AI call totals are temporarily unavailable.'
  }

  try {
    const batchSize = 500
    const maxRows = 10_000
    const uniqueEvents = new Map<string, EventRow>()

    for (let offset = 0; offset < maxRows && uniqueEvents.size < limit; offset += batchSize) {
      const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`)
      url.search = new URLSearchParams({
        select: 'id,level,event_type,message,symbol,created_at',
        created_at: `gte.${resetAt.toISOString()}`,
        order: 'created_at.desc',
      }).toString()
      const response = await fetch(url, {
        headers: { ...supabaseHeaders(), Range: `${offset}-${offset + batchSize - 1}`, 'Range-Unit': 'items' },
        cache: 'no-store',
      })
      if (!response.ok) {
        return NextResponse.json({ events: [], aiCalls, aiCallsError, degraded: true, degradedReason: `Supabase event-history request failed (${response.status})` })
      }

      const rows = await response.json() as EventRow[]
      for (const event of rows) {
        if (!shouldShowEventAfterFourAm(event.created_at, now)) continue
        const key = [event.event_type, event.symbol ?? '', event.message].join('\u001f')
        if (!uniqueEvents.has(key)) uniqueEvents.set(key, event)
      }
      if (rows.length < batchSize) break
    }

    return NextResponse.json({ events: Array.from(uniqueEvents.values()).slice(0, limit), aiCalls, aiCallsError })
  } catch {
    return NextResponse.json({ events: [], aiCalls, aiCallsError, degraded: true, degradedReason: 'Supabase event-history request could not be completed' })
  }
}
