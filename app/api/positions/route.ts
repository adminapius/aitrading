import { NextResponse } from 'next/server'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_positions?select=id,symbol,side,quantity,entry_price,current_price,stop_price,target_price,unrealized_pnl,status,opened_at&status=eq.open&order=opened_at.desc`, {
    headers: supabaseHeaders(),
    cache: 'no-store',
  })
  if (!response.ok) return NextResponse.json({ error: `Supabase returned ${response.status}` }, { status: response.status })
  return NextResponse.json({ positions: await response.json(), mode: 'paper' })
}
