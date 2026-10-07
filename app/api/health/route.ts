import { NextResponse } from 'next/server'
import { alpacaHeaders, configuredServices, supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

async function checkSupabase() {
  const response = await fetch(
    `${tradingConfig.supabaseUrl}/rest/v1/ait_papermoney?select=account_name,starting_balance,cash_balance,equity,realized_pnl,unrealized_pnl,is_active&account_name=eq.paper-main&is_active=eq.true&limit=1`,
    { headers: supabaseHeaders(), cache: 'no-store' },
  )
  if (!response.ok) throw new Error(`Supabase returned ${response.status}`)
  const rows = (await response.json()) as Array<Record<string, number | string | boolean>>
  return rows[0] ?? null
}

async function checkRailway() {
  if (!tradingConfig.railwayServiceUrl) {
    return { configured: false, reachable: false, ready: false }
  }

  const baseUrl = tradingConfig.railwayServiceUrl.replace(/\/$/, '')
  const [liveness, readiness] = await Promise.all([
    fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000), cache: 'no-store' }),
    fetch(`${baseUrl}/api/health`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000), cache: 'no-store' }),
  ])
  if (!liveness.ok) throw new Error(`Railway liveness check returned ${liveness.status}`)
  return {
    configured: true,
    reachable: true,
    ready: readiness.ok,
    status: readiness.status,
    ...(readiness.ok ? {} : { error: `Railway readiness check returned ${readiness.status}` }),
  }
}

async function checkAlpaca() {
  const response = await fetch(`${tradingConfig.alpacaBaseUrl}/v2/account`, {
    headers: alpacaHeaders(),
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Alpaca returned ${response.status}`)
  const account = (await response.json()) as { equity?: string; buying_power?: string; status?: string }
  return { equity: account.equity, buyingPower: account.buying_power, status: account.status }
}

export async function GET() {
  const [supabase, alpaca, railway] = await Promise.allSettled([
    checkSupabase(),
    checkAlpaca(),
    checkRailway(),
  ])
  const railwayHealthy = !tradingConfig.railwayServiceUrl || (railway.status === 'fulfilled' && railway.value.reachable && railway.value.ready)
  const requiredHealthy = supabase.status === 'fulfilled' && alpaca.status === 'fulfilled' && railwayHealthy
  return NextResponse.json({
    ok: requiredHealthy,
    checkedAt: new Date().toISOString(),
    mode: tradingConfig.mode,
    liveTradingEnabled: tradingConfig.liveTradingEnabled,
    services: configuredServices(),
    supabase: supabase.status === 'fulfilled' ? { connected: true, account: supabase.value } : { connected: false, error: supabase.reason instanceof Error ? supabase.reason.message : 'Unavailable' },
    alpaca: alpaca.status === 'fulfilled' ? { connected: true, account: alpaca.value } : { connected: false, error: alpaca.reason instanceof Error ? alpaca.reason.message : 'Unavailable' },
    railway: railway.status === 'fulfilled' ? railway.value : { configured: true, reachable: false, error: railway.reason instanceof Error ? railway.reason.message : 'Unavailable' },
  }, { status: requiredHealthy ? 200 : 503 })
}
