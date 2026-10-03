import { NextResponse } from 'next/server'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_papermoney?select=id,account_name,starting_balance,cash_balance,equity,realized_pnl,unrealized_pnl,updated_at&account_name=eq.paper-main&is_active=eq.true&limit=1`, { headers: supabaseHeaders(), cache: 'no-store' })
  if (!response.ok) return NextResponse.json({ error: `Supabase returned ${response.status}` }, { status: response.status })
  const rows = await response.json()
  return NextResponse.json({ account: rows[0] ?? null, mode: 'paper' })
}
export async function PATCH() {
  return NextResponse.json({ error: 'Account mutations are worker-only in paper mode' }, { status: 405 })
}
