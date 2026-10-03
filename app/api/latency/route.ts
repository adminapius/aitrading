import { NextResponse } from 'next/server'
import { alpacaHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

async function measure(name: string, url: string, init?: RequestInit) {
  const started = performance.now()
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(4000), cache: 'no-store' })
    return { name, ok: response.ok, ms: Math.round(performance.now() - started), status: response.status }
  } catch (error) {
    return { name, ok: false, ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : 'Unavailable' }
  }
}

export async function GET() {
  const [alpaca, fmp, supabase] = await Promise.all([
    measure('Alpaca', `${tradingConfig.alpacaBaseUrl}/v2/account`, { headers: alpacaHeaders() }),
    measure('FMP', 'https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=' + encodeURIComponent(process.env.FMP_API_KEY ?? ''), { headers: { accept: 'application/json' } }),
    measure('Supabase', `${tradingConfig.supabaseUrl}/auth/v1/health`, { headers: { apikey: tradingConfig.supabaseKey ?? '', Authorization: `Bearer ${tradingConfig.supabaseKey ?? ''}` } }),
  ])
  return NextResponse.json({ checkedAt: new Date().toISOString(), providers: [alpaca, fmp, supabase] })
}
