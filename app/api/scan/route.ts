import { NextRequest, NextResponse } from 'next/server'
import { alpacaHeaders, getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { isEasternScanningAllowed } from '@/lib/strategy'

export const dynamic = 'force-dynamic'

type MarketBar = { c?: number; v?: number; vw?: number }
type Snapshot = { latestTrade?: { p?: number }; dailyTradeBar?: MarketBar; dailyBar?: MarketBar; prevDailyBar?: MarketBar; latestQuote?: { bp?: number; ap?: number } }

async function persistScan(candidates: Array<{ symbol: string; price: number; changePercent: number | null; volume: number; bid: number; ask: number }>, scannedAt: string) {
  const configurationError = getSupabaseConfigurationError()
  if (configurationError) return configurationError

  let paperAccount: { equity: number; pnl: number } | null = null
  try {
    const accountResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_papermoney?select=equity,realized_pnl,unrealized_pnl&account_name=eq.paper-main&is_active=eq.true&limit=1`, {
      headers: supabaseHeaders(),
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    })
    if (accountResponse.ok) {
      const [account] = await accountResponse.json() as Array<{ equity?: number; realized_pnl?: number; unrealized_pnl?: number }>
      if (account) paperAccount = { equity: Number(account.equity), pnl: Number(account.realized_pnl ?? 0) + Number(account.unrealized_pnl ?? 0) }
    }
  } catch {
    paperAccount = null
  }

  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_watchlist_scans`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(candidates.map((candidate) => ({
      symbol: candidate.symbol,
      price: candidate.price,
      change_percent: candidate.changePercent,
      volume: candidate.volume,
      scanned_at: scannedAt,
      decision: 'watch',
      metadata: { source: 'alpaca-movers', bid: candidate.bid, ask: candidate.ask, paperAccount },
    }))),
    signal: AbortSignal.timeout(7000),
    cache: 'no-store',
  })
  return response.ok ? null : `Supabase scan history write failed (${response.status})`
}

export async function GET(request: NextRequest) {
  const scannedAt = new Date().toISOString()
  if (!isEasternScanningAllowed(new Date(scannedAt))) return NextResponse.json({ source: 'Alpaca', scannedAt, mode: 'paper', candidates: [], sleeping: true })
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

    const persistenceWarning = candidates.length ? await persistScan(candidates, scannedAt) : null
    return NextResponse.json({ source: 'Alpaca market movers', scannedAt, mode: 'paper', candidates, ...(persistenceWarning ? { persistenceWarning } : {}) })
  } catch (error) {
    return NextResponse.json({
      source: 'Alpaca',
      candidates: [],
      error: error instanceof Error ? error.message : 'Market scanner unavailable',
    }, { status: 502 })
  }
}
