import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'

const scanLockKey = 'paper-market-scan'

async function callRpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Supabase scan RPC ${name} failed (${response.status}); apply the scanner migration before enabling scheduled scans`)
  return response.json() as Promise<T>
}

export async function claimScanLease(ownerToken: string, leaseSeconds: number, minimumIntervalSeconds: number) {
  return callRpc<'acquired' | 'busy' | 'cooldown'>('claim_ait_scan_lease', {
    p_lock_key: scanLockKey,
    p_owner_token: ownerToken,
    p_lease_seconds: leaseSeconds,
    p_minimum_interval_seconds: minimumIntervalSeconds,
  })
}

export async function releaseScanLease(ownerToken: string) {
  return callRpc<boolean>('release_ait_scan_lease', {
    p_lock_key: scanLockKey,
    p_owner_token: ownerToken,
  })
}

export function easternSessionDate(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const value = (name: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === name)?.value ?? '00'
  return `${value('year')}-${value('month')}-${value('day')}`
}

export async function ensureScanSession(now: Date) {
  const sessionId = await callRpc<string>('ensure_ait_scan_session', {
    p_trading_date: easternSessionDate(now),
    p_started_at: now.toISOString(),
  })
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    throw new Error('Supabase did not return a valid scan session id')
  }
  return sessionId
}
