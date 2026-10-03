import { NextRequest, NextResponse } from 'next/server'
import { alpacaHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol')?.toUpperCase().replace(/[^A-Z.]/g, '')
  if (!symbol) return NextResponse.json({ error: 'symbol is required' }, { status: 400 })

  const response = await fetch(`${tradingConfig.alpacaDataUrl}/v2/stocks/${symbol}/quotes/latest?feed=${tradingConfig.alpacaDataFeed}`, {
    headers: alpacaHeaders(),
    cache: 'no-store',
  })
  if (!response.ok) return NextResponse.json({ error: `Alpaca returned ${response.status}` }, { status: response.status })
  const data = await response.json()
  return NextResponse.json({ symbol, quote: data.quote ?? data })
}
