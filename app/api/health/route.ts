import { NextResponse } from 'next/server'
import { alpacaHeaders, configuredServices, supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { expectedScanIntervalSeconds } from '@/lib/scan-config'

export const dynamic = 'force-dynamic'

async function checkLatestScanAt() {
  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/ait_scan_runs`)
  url.search = new URLSearchParams({ select: 'started_at,status,error', order: 'started_at.desc', limit: '1' }).toString()
  const response = await fetch(url, {
    headers: supabaseHeaders(),
    signal: AbortSignal.timeout(5_000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase scan freshness request failed (${response.status})`)
  const rows = (await response.json()) as Array<{ started_at?: string | null; status?: string; error?: string | null }>
  return rows[0] ?? null
}

function getScanFreshness(now: Date, lastScanAt: string | null) {
  const scanStaleThresholdSeconds = expectedScanIntervalSeconds(now) * 4
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? ''
  const year = value('year')
  const month = value('month')
  const day = value('day')
  const hour = value('hour')
  const minute = value('minute')
  const second = value('second')
  const minuteOfDay = hour * 60 + minute
  const inScanWindow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) && minuteOfDay >= 7 * 60 && minuteOfDay < 15 * 60 + 55

  if (!inScanWindow) return { inScanWindow, staleSeconds: null, stale: false, scanWindowStartedAt: null }

  const localTimestamp = Date.UTC(year, month - 1, day, hour, minute, second)
  const currentTimestamp = Math.floor(now.getTime() / 1_000) * 1_000
  const easternOffset = localTimestamp - currentTimestamp
  const scanWindowStartedAt = Date.UTC(year, month - 1, day, 7, 0) - easternOffset
  const parsedLastScanAt = lastScanAt ? Date.parse(lastScanAt) : Number.NaN
  const freshnessStartedAt = Number.isFinite(parsedLastScanAt)
    ? Math.max(parsedLastScanAt, scanWindowStartedAt)
    : scanWindowStartedAt
  const staleSeconds = Math.max(0, Math.floor((now.getTime() - freshnessStartedAt) / 1_000))

  return { inScanWindow, staleSeconds, stale: staleSeconds > scanStaleThresholdSeconds, scanWindowStartedAt }
}

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

  const readinessBody = await readiness.json().catch(() => null) as { service?: string; ready?: boolean; missing?: string[]; scanIntervalSeconds?: number; pollIntervalSeconds?: number } | null
  const ready = readiness.ok && readinessBody?.ready === true

  return {
    configured: true,
    reachable: true,
    ready,
    status: readiness.status,
    ...(readinessBody?.service ? { service: readinessBody.service } : {}),
    pollIntervalSeconds: readinessBody?.pollIntervalSeconds ?? readinessBody?.scanIntervalSeconds ?? null,
    ...(readinessBody?.missing?.length ? { missing: readinessBody.missing } : {}),
    ...(!ready ? { error: `Railway worker readiness check returned ${readiness.status}` } : {}),
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
  const now = new Date()
  const [supabase, alpaca, railway, latestScan] = await Promise.allSettled([
    checkSupabase(),
    checkAlpaca(),
    checkRailway(),
    checkLatestScanAt(),
  ])
  const supabaseConnected = supabase.status === 'fulfilled'
  const paperAccount = supabaseConnected ? supabase.value : null
  const paperAccountReady = paperAccount !== null
  const railwayHealthy = !tradingConfig.railwayServiceUrl || (railway.status === 'fulfilled' && railway.value.reachable && railway.value.ready)
  const latestScanRun = latestScan.status === 'fulfilled' ? latestScan.value : null
  const lastScanAt = latestScanRun?.started_at ?? null
  const lastScanStatus = latestScanRun?.status ?? null
  const scanFreshness = getScanFreshness(now, lastScanAt)
  const scanIntervalSeconds = expectedScanIntervalSeconds(now)
  const pollIntervalSeconds = railway.status === 'fulfilled' && 'pollIntervalSeconds' in railway.value ? railway.value.pollIntervalSeconds ?? null : null
  const scanFreshnessAvailable = latestScan.status === 'fulfilled'
  const scanFailed = lastScanStatus === 'failed'
    && lastScanAt !== null
    && scanFreshness.scanWindowStartedAt !== null
    && Date.parse(lastScanAt) >= scanFreshness.scanWindowStartedAt
  const scanFreshnessDegraded = scanFreshness.inScanWindow && (!scanFreshnessAvailable || scanFreshness.stale || scanFailed)
  const scanDegradedReason = scanFreshnessDegraded
    ? !scanFreshnessAvailable
      ? 'Worker scan freshness could not be checked.'
      : scanFailed
        ? latestScanRun?.error ?? 'The latest worker scan failed.'
        : `No worker scan heartbeat has been written for more than ${scanIntervalSeconds * 4} seconds.`
    : undefined
  const requiredHealthy = paperAccountReady && alpaca.status === 'fulfilled' && railwayHealthy && !scanFreshnessDegraded
  return NextResponse.json({
    ok: requiredHealthy,
    status: scanFreshnessDegraded ? 'degraded' : requiredHealthy ? 'healthy' : 'unhealthy',
    degraded: scanFreshnessDegraded,
    ...(scanDegradedReason ? { degradedReason: scanDegradedReason } : {}),
    lastScanAt,
    lastScanStatus,
    scanIntervalSeconds,
    pollIntervalSeconds,
    staleSeconds: scanFreshnessAvailable ? scanFreshness.staleSeconds : null,
    checkedAt: now.toISOString(),
    mode: tradingConfig.mode,
    liveTradingEnabled: tradingConfig.liveTradingEnabled,
    services: configuredServices(),
    supabase: supabaseConnected
      ? { connected: true, ready: paperAccountReady, account: paperAccount, ...(!paperAccountReady ? { error: 'Active paper account paper-main was not found' } : {}) }
      : { connected: false, ready: false, error: supabase.reason instanceof Error ? supabase.reason.message : 'Unavailable' },
    alpaca: alpaca.status === 'fulfilled' ? { connected: true, account: alpaca.value } : { connected: false, error: alpaca.reason instanceof Error ? alpaca.reason.message : 'Unavailable' },
    railway: railway.status === 'fulfilled' ? railway.value : { configured: true, reachable: false, error: railway.reason instanceof Error ? railway.reason.message : 'Unavailable' },
  }, { status: requiredHealthy ? 200 : 503 })
}
