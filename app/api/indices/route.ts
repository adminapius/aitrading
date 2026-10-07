import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const INDEXES = [
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^IXIC', name: 'NASDAQ Composite' },
  { symbol: '^DJI', name: 'DOW JONES' },
] as const

type IndexQuote = { price?: number | string; previousClose?: number | string; changePercentage?: number | string; changesPercentage?: number | string }

function numericValue(value: number | string | undefined) {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number.parseFloat(value.replace('%', ''))
  return Number.NaN
}

export async function GET() {
  const apiKey = process.env.FMP_API_KEY?.trim()
  if (!apiKey) return NextResponse.json({ indices: [], error: 'FMP index quotes are not configured.' }, { status: 503 })

  try {
    const indices = await Promise.all(INDEXES.map(async ({ symbol, name }) => {
      const url = new URL('https://financialmodelingprep.com/stable/quote')
      url.search = new URLSearchParams({ symbol, apikey: apiKey }).toString()
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
      if (!response.ok) throw new Error(`FMP index quote returned ${response.status} for ${symbol}.`)

      const data = await response.json() as IndexQuote[]
      const quote = data[0]
      const price = numericValue(quote?.price)
      const previousClose = numericValue(quote?.previousClose)
      const reportedChange = numericValue(quote?.changePercentage ?? quote?.changesPercentage)
      if (!Number.isFinite(price) || price <= 0) throw new Error(`FMP returned no live price for ${symbol}.`)
      const changePercent = Number.isFinite(reportedChange)
        ? reportedChange
        : Number.isFinite(previousClose) && previousClose > 0
          ? ((price - previousClose) / previousClose) * 100
          : Number.NaN
      if (!Number.isFinite(changePercent)) throw new Error(`FMP returned no live change for ${symbol}.`)
      return { symbol, name, price, changePercent }
    }))

    return NextResponse.json({ indices, source: 'Financial Modeling Prep', updatedAt: new Date().toISOString() })
  } catch (error) {
    return NextResponse.json({
      indices: [],
      error: error instanceof Error ? error.message : 'Live index quotes are unavailable.',
    }, { status: 502 })
  }
}
