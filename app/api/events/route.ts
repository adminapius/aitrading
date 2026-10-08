import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { easternSevenAmStart, easternSleepStart } from '@/lib/scheduled-events'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 200
const EVENT_ID_PATTERN = /^\d{1,19}$/
const EVENT_FILTER_PATTERN = /^[a-zA-Z0-9_.:-]{1,80}$/

type EventRow = { id: string; level: string; event_type: string; message: string; symbol?: string | null; created_at: string }

function parseCursor(value: string | null) {
  if (!value) return null
  const separator = value.lastIndexOf('|')
  if (separator < 0) return undefined
  const createdAt = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (!Number.isFinite(Date.parse(createdAt)) || !EVENT_ID_PATTERN.test(id)) return undefined
  return { createdAt: new Date(createdAt).toISOString(), id }
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const cursor = parseCursor(searchParams.get('before'))
  if (cursor === undefined) return NextResponse.json({ error: 'Invalid event cursor.' }, { status: 400 })

  const level = searchParams.get('level')?.trim() ?? ''
  const eventType = searchParams.get('event_type')?.trim() ?? ''
  if ((level && !EVENT_FILTER_PATTERN.test(level)) || (eventType && !EVENT_FILTER_PATTERN.test(eventType))) {
    return NextResponse.json({ error: 'Use only letters, numbers, periods, underscores, colons, or hyphens for event filters.' }, { status: 400 })
  }

  const now = new Date()
  const dayStart = easternSevenAmStart(now)
  const sessionEnd = new Date(easternSleepStart(now).getTime() + 5 * 60_000 - 1)
  const endAt = now < sessionEnd ? now : sessionEnd
  const configurationError = getSupabaseConfigurationError()
  if (configurationError) return NextResponse.json({ events: [], nextCursor: null, hasMore: false, degraded: true, degradedReason: configurationError })

  try {
    const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`)
    const params = new URLSearchParams({
      select: 'id,level,event_type,message,symbol,created_at',
      order: 'created_at.desc,id.desc',
      limit: String(PAGE_SIZE),
    })
    params.append('and', `(created_at.gte.${dayStart.toISOString()},created_at.lte.${endAt.toISOString()})`)
    if (cursor) params.set('or', `(created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id}))`)
    if (level) params.set('level', `ilike.${level}`)
    if (eventType) params.set('event_type', `ilike.*${eventType}*`)
    url.search = params.toString()

    const response = await fetch(url, {
      headers: supabaseHeaders(),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
    if (!response.ok) {
      return NextResponse.json({ events: [], nextCursor: null, hasMore: false, degraded: true, degradedReason: `Supabase event-history request failed (${response.status})` })
    }

    const events = await response.json() as EventRow[]
    const lastEvent = events.at(-1)
    return NextResponse.json({
      events,
      nextCursor: events.length === PAGE_SIZE && lastEvent ? `${lastEvent.created_at}|${lastEvent.id}` : null,
      hasMore: events.length === PAGE_SIZE,
    })
  } catch {
    return NextResponse.json({ events: [], nextCursor: null, hasMore: false, degraded: true, degradedReason: 'Supabase event-history request could not be completed' })
  }
}
