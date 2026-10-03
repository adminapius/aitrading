import { NextResponse } from 'next/server'
import { alpacaHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  const symbols = ['SPY', 'QQQ', 'DIA']
  const response = await fetch(`${tradingConfig.alpacaDataUrl}/v2/stocks/snapshots?symbols=${symbols.join(',')}&feed=${tradingConfig.alpacaDataFeed}`, {
    headers: alpacaHeaders(),
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  })
  if (!response.ok) return NextResponse.json({ indices: [], error: `Market data returned ${response.status}` }, { status: response.status })
  const snapshots = await response.json() as Record<string, { latestTrade?: { p?: number }; dailyBar?: { c?: number }; prevDailyBar?: { c?: number } }>
  const labels: Record<string, string> = { SPY: 'S&P 500', QQQ: 'NASDAQ', DIA: 'DOW JONES' }
  const indices = symbols.map((symbol) => {
    const snapshot = snapshots[symbol]
    const price = snapshot?.latestTrade?.p ?? snapshot?.dailyBar?.c ?? 0
    const previous = snapshot?.prevDailyBar?.c ?? price
    return { symbol, name: labels[symbol], price, changePercent: previous ? ((price - previous) / previous) * 100 : 0 }
  })
  return NextResponse.json({ indices, updatedAt: new Date().toISOString() })
}
