import { NextRequest, NextResponse } from 'next/server'
import { alpacaHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

type MarketBar = { c?: number; v?: number; vw?: number }
type Snapshot = { latestTrade?: { p?: number }; dailyTradeBar?: MarketBar; dailyBar?: MarketBar; prevDailyBar?: MarketBar; latestQuote?: { bp?: number; ap?: number } }

export async function GET(request: NextRequest) {
  const top = Math.min(Math.max(Number(request.nextUrl.searchParams.get('top') ?? 25), 1), 50)
  const headers = alpacaHeaders()

  try {
    const moversResponse = await fetch(`${tradingConfig.alpacaDataUrl}/v1beta1/screener/stocks/movers?top=${top}`, {
      headers,
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    if (!moversResponse.ok) return NextResponse.json({ source: 'Alpaca', candidates: [], error: `Market movers unavailable (${moversResponse.status})` }, { status: 502 })

    const movers = await moversResponse.json() as { gainers?: Array<{ symbol?: string }>; losers?: Array<{ symbol?: string }> }
    const selectedMovers = [
      ...(movers.gainers ?? []).slice(0, Math.ceil(top / 2)),
      ...(movers.losers ?? []).slice(0, Math.floor(top / 2)),
    ]
    const symbols = [...new Set(selectedMovers
      .map((mover) => mover.symbol?.trim().toUpperCase())
      .filter((symbol): symbol is string => Boolean(symbol && /^[A-Z]{1,5}$/.test(symbol) && !/[WU]$/.test(symbol))))]

    if (!symbols.length) return NextResponse.json({ source: 'Alpaca', scannedAt: new Date().toISOString(), candidates: [] })

    const snapshotResponse = await fetch(`${tradingConfig.alpacaDataUrl}/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}&feed=${encodeURIComponent(tradingConfig.alpacaDataFeed)}`, {
      headers,
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    if (!snapshotResponse.ok) return NextResponse.json({ source: 'Alpaca', candidates: [], error: `Market snapshots unavailable (${snapshotResponse.status})` }, { status: 502 })

    const snapshots = await snapshotResponse.json() as Record<string, Snapshot>
    const candidates = symbols.flatMap((symbol) => {
      const snapshot = snapshots[symbol]
      if (!snapshot) return []
      const daily = snapshot.dailyTradeBar ?? snapshot.dailyBar ?? {}
      const previous = snapshot.prevDailyBar ?? {}
      const price = Number(snapshot.latestTrade?.p ?? daily.c ?? 0)
      const previousClose = Number(previous.c ?? 0)
      if (!(price > 0)) return []
      return [{
        symbol,
        price,
        changePercent: previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null,
        volume: Number(daily.v ?? 0),
        bid: Number(snapshot.latestQuote?.bp ?? 0),
        ask: Number(snapshot.latestQuote?.ap ?? 0),
      }]
    })

    return NextResponse.json({ source: 'Alpaca market movers', scannedAt: new Date().toISOString(), mode: 'paper', candidates })
  } catch (error) {
    return NextResponse.json({
      source: 'Alpaca',
      candidates: [],
      error: error instanceof Error ? error.message : 'Market scanner unavailable',
    }, { status: 502 })
  }
}
