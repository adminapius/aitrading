import { NextResponse } from 'next/server'
import { getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  const configurationError = getSupabaseConfigurationError()
  if (configurationError) return NextResponse.json({ points: [], degraded: true, degradedReason: configurationError })

  try {
    const historyUrl = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_watchlist_scans`)
    historyUrl.search = new URLSearchParams({ select: 'scanned_at,metadata', order: 'scanned_at.desc', limit: '1200' }).toString()
    const response = await fetch(historyUrl, { headers: supabaseHeaders(), signal: AbortSignal.timeout(6000), cache: 'no-store' })
    if (!response.ok) return NextResponse.json({ points: [], degraded: true, degradedReason: `Supabase P&L history request failed (${response.status})` })

    const rows = await response.json() as Array<{ scanned_at: string; metadata?: { paperAccount?: { pnl?: number } | null } }>
    const byScan = new Map<string, number>()
    for (const row of rows) {
      const pnl = row.metadata?.paperAccount?.pnl
      if (typeof pnl === 'number' && Number.isFinite(pnl) && !byScan.has(row.scanned_at)) byScan.set(row.scanned_at, pnl)
    }
    const points = [...byScan.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(-80).map(([, pnl]) => pnl)
    return NextResponse.json({ points })
  } catch {
    return NextResponse.json({ points: [], degraded: true, degradedReason: 'Supabase P&L history request could not be completed' })
  }
}
