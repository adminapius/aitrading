import { NextResponse } from 'next/server'
import { getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  const configurationError = getSupabaseConfigurationError()
  if (configurationError) return NextResponse.json({ positions: [], mode: 'paper', degraded: true, degradedReason: configurationError })
  try {
    const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_positions?select=id,symbol,side,quantity,entry_price,current_price,stop_price,target_price,unrealized_pnl,status,opened_at&status=eq.open&order=opened_at.desc`, { headers: supabaseHeaders(), cache: 'no-store' })
    if (!response.ok) return NextResponse.json({ positions: [], mode: 'paper', degraded: true, degradedReason: `Supabase positions request failed (${response.status})` })
    return NextResponse.json({ positions: await response.json(), mode: 'paper' })
  } catch {
    return NextResponse.json({ positions: [], mode: 'paper', degraded: true, degradedReason: 'Supabase positions request could not be completed' })
  }
}
