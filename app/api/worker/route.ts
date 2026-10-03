import { NextRequest, NextResponse } from 'next/server'
import { tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!tradingConfig.railwayServiceUrl) return NextResponse.json({ configured: false, reachable: false }, { status: 503 })
  try {
    const response = await fetch(`${tradingConfig.railwayServiceUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
    return NextResponse.json({ configured: true, reachable: response.ok, status: response.status })
  } catch {
    return NextResponse.json({ configured: true, reachable: false }, { status: 503 })
  }
}

export async function POST(request: NextRequest) {
  if (!tradingConfig.railwayServiceUrl) return NextResponse.json({ error: 'RAILWAY_SERVICE_URL is not configured' }, { status: 503 })
  const body = await request.text()
  const response = await fetch(`${tradingConfig.railwayServiceUrl.replace(/\/$/, '')}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, cache: 'no-store' })
  return NextResponse.json(await response.json().catch(() => ({ status: response.status })), { status: response.status })
}
