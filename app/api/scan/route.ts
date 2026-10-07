import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { loadEnrichedCandidates } from '@/lib/scan-data'
import { scanConfig } from '@/lib/scan-config'
import { alpacaHeaders, tradingConfig } from '@/lib/trading-config'
import { isEasternScanningAllowed } from '@/lib/strategy'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type MarketSnapshot = {
  latestTrade?: { p?: number; t?: string }
  latestQuote?: { bp?: number; ap?: number; t?: string }
  dailyBar?: { c?: number }
  prevDailyBar?: { c?: number }
}

export async function GET(request: NextRequest) {
  const scanStartedAt = new Date()
  const scanId = randomUUID()
  if (!isEasternScanningAllowed(scanStartedAt)) {
    return NextResponse.json({ source: 'Alpaca', scannedAt: scanStartedAt.toISOString(), scanId, mode: 'paper', candidates: [], sleeping: true })
  }

  const requestedTop = Number(request.nextUrl.searchParams.get('top') ?? 25)
  const top = Number.isFinite(requestedTop) ? Math.min(Math.max(Math.trunc(requestedTop), 1), 50) : 25
  const headers = alpacaHeaders()
  const reportFailure = (message: string) => {
    console.error('[scanner] scan request failed', { scanId, message })
    return NextResponse.json({ source: 'Alpaca', scanId, candidates: [], error: message }, { status: 502 })
  }

  try {
    const moversResponse = await fetch(`${tradingConfig.alpacaDataUrl}/v1beta1/screener/stocks/movers?top=${top}`, {
      headers,
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    if (!moversResponse.ok) return reportFailure(`Market movers unavailable (${moversResponse.status})`)

    const movers = await moversResponse.json() as { gainers?: Array<{ symbol?: string }> }
    const symbols = [...new Set((movers.gainers ?? [])
      .map((mover) => mover.symbol?.trim().toUpperCase())
      .filter((symbol): symbol is string => Boolean(symbol && /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))))].slice(0, top)
    if (!symbols.length) {
      return NextResponse.json({ source: 'Alpaca market gainers', scannedAt: new Date().toISOString(), scanId, mode: 'paper', candidates: [], diagnostics: { excluded: 0 } })
    }

    const snapshotUrl = new URL(`${tradingConfig.alpacaDataUrl}/v2/stocks/snapshots`)
    snapshotUrl.search = new URLSearchParams({ symbols: symbols.join(','), feed: tradingConfig.alpacaDataFeed }).toString()
    const snapshotResponse = await fetch(snapshotUrl, {
      headers,
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    if (!snapshotResponse.ok) return reportFailure(`Market snapshots unavailable (${snapshotResponse.status})`)

    const snapshots = await snapshotResponse.json() as Record<string, MarketSnapshot>
    const result = await loadEnrichedCandidates(symbols, snapshots, scanStartedAt)
    for (const failure of result.failures) console.warn('[scanner] candidate excluded', { scanId, ...failure })

    return NextResponse.json({
      source: 'Alpaca market gainers',
      scannedAt: new Date().toISOString(),
      scanStartedAt: scanStartedAt.toISOString(),
      scanDurationMs: Math.max(0, Date.now() - scanStartedAt.getTime()),
      scanId,
      mode: 'paper',
      candidates: result.candidates,
      diagnostics: {
        gainersReceived: symbols.length,
        candidatesReturned: result.candidates.length,
        excluded: result.failures.length,
        enrichmentFailures: result.failures.slice(0, 25),
        filters: {
          minPrice: scanConfig.minPrice,
          minVolume: scanConfig.minVolume,
          minChangePercent: scanConfig.minChangePercent,
          maxSpreadPercent: scanConfig.maxSpreadPercent,
          maxTradeAgeSeconds: scanConfig.maxTradeAgeSeconds,
        },
      },
    })
  } catch (error) {
    return reportFailure(error instanceof Error ? error.message : 'Market scanner unavailable')
  }
}
