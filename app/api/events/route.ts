import { NextRequest, NextResponse } from 'next/server'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit') ?? 20), 100)
  if (!tradingConfig.supabaseUrl || !tradingConfig.supabaseKey) return NextResponse.json({ events: [], degraded: true })
  try {
    const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents?select=id,level,event_type,message,symbol,created_at&order=created_at.desc&limit=${limit}`, { headers: supabaseHeaders(), cache: 'no-store' })
    if (!response.ok) return NextResponse.json({ events: [], degraded: true })
    return NextResponse.json({ events: await response.json() })
  } catch {
    return NextResponse.json({ events: [], degraded: true })
  }
}
