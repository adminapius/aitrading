import { NextRequest, NextResponse } from 'next/server'
import { tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!tradingConfig.railwayServiceUrl) return NextResponse.json({ configured: false, reachable: false }, { status: 503 })
  try {
    const baseUrl = tradingConfig.railwayServiceUrl.replace(/\/$/, '')
    const [liveness, readiness] = await Promise.all([
      fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000), cache: 'no-store' }),
      fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000), cache: 'no-store' }),
    ])
    const ready = liveness.ok && readiness.ok
    return NextResponse.json({ configured: true, reachable: liveness.ok, ready, status: readiness.status }, { status: ready ? 200 : 503 })
  } catch {
    return NextResponse.json({ configured: true, reachable: false, ready: false }, { status: 503 })
  }
}

export async function POST(request: NextRequest) {
  if (!tradingConfig.railwayServiceUrl) return NextResponse.json({ error: 'RAILWAY_SERVICE_URL is not configured' }, { status: 503 })
  const body = await request.text()
  const response = await fetch(`${tradingConfig.railwayServiceUrl.replace(/\/$/, '')}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, cache: 'no-store' })
  return NextResponse.json(await response.json().catch(() => ({ status: response.status })), { status: response.status })
}
