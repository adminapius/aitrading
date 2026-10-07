import { NextRequest, NextResponse } from 'next/server'
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

  try {
    const batchSize = 500
    const maxRows = 10_000
    const events: EventRow[] = []

    for (let offset = 0; offset < maxRows && events.length < limit; offset += batchSize) {
      const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`)
      url.search = new URLSearchParams({
        select: 'id,level,event_type,message,symbol,created_at',
        event_type: 'neq.AI_CALL',
        created_at: `gte.${resetAt.toISOString()}`,
        order: 'created_at.desc',
      }).toString()
      const response = await fetch(url, {
        headers: { ...supabaseHeaders(), Range: `${offset}-${offset + batchSize - 1}`, 'Range-Unit': 'items' },
        cache: 'no-store',
      })
      if (!response.ok) {
        return NextResponse.json({ events: [], degraded: true, degradedReason: `Supabase event-history request failed (${response.status})` })
      }

      const rows = await response.json() as EventRow[]
      events.push(...rows.filter((event) => shouldShowEventAfterFourAm(event.created_at, now)).slice(0, limit - events.length))
      if (rows.length < batchSize) break
    }

    return NextResponse.json({ events: events.reverse() })
  } catch {
    return NextResponse.json({ events: [], degraded: true, degradedReason: 'Supabase event-history request could not be completed' })
  }
}
