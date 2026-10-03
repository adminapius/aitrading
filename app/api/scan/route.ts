import { NextRequest, NextResponse } from 'next/server'
import { tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

const symbols = ['MIRA', 'CETX', 'KAVL', 'SINT', 'HUBC']

export async function GET(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get('symbols')?.split(',').map((value) => value.toUpperCase().replace(/[^A-Z.]/g, '')).filter(Boolean)
  const watchSymbols = requested?.length ? requested.slice(0, 25) : symbols
  const headers = { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY ?? '', 'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET ?? '' }
  const results = await Promise.allSettled(watchSymbols.map(async (symbol) => {
    const response = await fetch(`${tradingConfig.alpacaBaseUrl}/v2/stocks/${symbol}/quotes/latest?feed=${tradingConfig.alpacaDataFeed}`, { headers, cache: 'no-store' })
    if (!response.ok) throw new Error(`${symbol}: Alpaca returned ${response.status}`)
    const data = await response.json()
    const quote = data.quote ?? data
    const bid = Number(quote.bp ?? quote.bid_price ?? 0)
    const ask = Number(quote.ap ?? quote.ask_price ?? 0)
    return { symbol, bid, ask, midpoint: bid && ask ? (bid + ask) / 2 : bid || ask, source: 'alpaca' }
  }))
  return NextResponse.json({ scannedAt: new Date().toISOString(), mode: 'paper', candidates: results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []), errors: results.flatMap((result) => result.status === 'rejected' ? [String(result.reason)] : []) })
}
