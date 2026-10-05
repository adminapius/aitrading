import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestedLimit = Number(request.nextUrl.searchParams.get('limit') ?? 20)
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 20
  const configurationError = getSupabaseConfigurationError()
  if (configurationError) return NextResponse.json({ events: [], degraded: true, degradedReason: configurationError })
  try {
    const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents?select=id,level,event_type,message,symbol,created_at&order=created_at.desc&limit=${limit}`, { headers: supabaseHeaders(), cache: 'no-store' })
    if (!response.ok) return NextResponse.json({ events: [], degraded: true, degradedReason: `Supabase event-history request failed (${response.status})` })
    return NextResponse.json({ events: await response.json() })
  } catch {
    return NextResponse.json({ events: [], degraded: true, degradedReason: 'Supabase event-history request could not be completed' })
  }
}
