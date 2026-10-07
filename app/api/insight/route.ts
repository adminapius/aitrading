import { generateText } from 'ai'
import { NextRequest, NextResponse } from 'next/server'
import { recordAiError } from '@/lib/ai-events'
import { alpacaHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

type Snapshot = {
  latestTrade?: { p?: number }
  dailyBar?: { c?: number; v?: number; vw?: number }
  dailyTradeBar?: { c?: number; v?: number; vw?: number }
  prevDailyBar?: { c?: number }
}

type Headline = { title: string; source?: string; publishedAt?: string; url?: string }

function rulesFallback(changePercent: number | null, price: number, vwap: number) {
  if (changePercent != null && changePercent <= -3) return { signal: 'CAUTION', rationale: `Down ${Math.abs(changePercent).toFixed(2)}% versus the prior close; wait for stabilization.` }
  if (changePercent != null && changePercent >= 4 && (!vwap || price > vwap)) return { signal: 'WATCH', rationale: `Up ${changePercent.toFixed(2)}% with price holding above VWAP; monitor momentum.` }
  if (changePercent == null) return { signal: 'HOLD', rationale: 'Price-change data is unavailable; no signal is being inferred.' }
  return { signal: 'HOLD', rationale: `${changePercent >= 0 ? 'Positive' : 'Negative'} price action has not met the momentum threshold.` }
}

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol')?.trim().toUpperCase() ?? ''
  if (!/^[A-Z]{1,5}$/.test(symbol)) return NextResponse.json({ error: 'A valid stock symbol is required.' }, { status: 400 })

  const headers = alpacaHeaders()
  let snapshot: Snapshot | null = null
  try {
    const marketResponse = await fetch(`${tradingConfig.alpacaDataUrl}/v2/stocks/snapshots?symbols=${encodeURIComponent(symbol)}&feed=${encodeURIComponent(tradingConfig.alpacaDataFeed)}`, {
      headers,
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    })
    if (marketResponse.ok) {
      const snapshots = await marketResponse.json() as Record<string, Snapshot>
      snapshot = snapshots[symbol] ?? null
    }
  } catch {
    snapshot = null
  }

  const daily = snapshot?.dailyTradeBar ?? snapshot?.dailyBar ?? {}
  const price = Number(snapshot?.latestTrade?.p ?? daily.c ?? 0)
  const previousClose = Number(snapshot?.prevDailyBar?.c ?? 0)
  const changePercent = price > 0 && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null
  const volume = Number(daily.v ?? 0)
  const vwap = Number(daily.vw ?? 0)

  let headline: Headline | null = null
  const newsKey = process.env.FMP_API_KEY?.trim()
  if (newsKey) {
    try {
      const to = new Date().toISOString().slice(0, 10)
      const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const newsUrl = new URL('https://financialmodelingprep.com/stable/news/stock')
      newsUrl.search = new URLSearchParams({ symbols: symbol, from, to, apikey: newsKey }).toString()
      const newsResponse = await fetch(newsUrl, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
      if (newsResponse.ok) {
        const articles = await newsResponse.json() as Array<{ title?: string; site?: string; publishedDate?: string; url?: string }>
        const article = articles.find((item) => typeof item.title === 'string' && item.title.trim())
        if (article?.title) headline = { title: article.title, source: article.site, publishedAt: article.publishedDate, url: article.url }
      }
    } catch {
      headline = null
    }
  }

  const fallback = rulesFallback(changePercent, price, vwap)
  let result = fallback
  let modelUsed: string | null = null
  let aiErrorMessage: string | null = null
  let aiErrorDetails: string | undefined
  try {
    const { text } = await generateText({
      model: 'google/gemini-2.5-flash',
      prompt: [
        'You are an informational market-momentum analyst, not a trading agent.',
        `Analyze ${symbol} using only these current facts: price=${price || 'unavailable'}, changePercent=${changePercent == null ? 'unavailable' : changePercent.toFixed(2)}, volume=${volume}, vwap=${vwap || 'unavailable'}, headline=${headline?.title ?? 'none available'}.`,
        'Return exactly two lines. Line one must be WATCH, HOLD, or CAUTION. Line two is one factual rationale of at most 20 words. Do not predict returns or recommend placing orders.',
      ].join('\n'),
      maxOutputTokens: 100,
      abortSignal: AbortSignal.timeout(9000),
    })
    const lines = text.trim().split('\n').map((line) => line.trim()).filter(Boolean)
    const signal = lines[0]?.match(/\b(WATCH|HOLD|CAUTION)\b/i)?.[1]?.toUpperCase()
    if (signal && lines[1]) {
      result = { signal, rationale: lines.slice(1).join(' ').slice(0, 240) }
      modelUsed = 'google/gemini-2.5-flash'
    } else {
      aiErrorMessage = `Gemini-AI returned an unreadable signal for ${symbol}; rules engine used.`
    }
  } catch (error) {
    result = fallback
    aiErrorMessage = `Gemini-AI analysis failed for ${symbol}; rules engine used.`
    aiErrorDetails = error instanceof Error ? error.message.slice(0, 180) : 'Unknown model error'
  }

  if (aiErrorMessage) {
    await recordAiError({
      provider: 'Gemini-AI',
      symbol,
      message: aiErrorMessage,
      payload: {
        model: 'google/gemini-2.5-flash',
        route: 'insight',
        fallback: 'rules-engine',
        ...(aiErrorDetails ? { error: aiErrorDetails } : {}),
      },
    })
  }

  return NextResponse.json({
    symbol,
    price: price || undefined,
    changePercent,
    signal: result.signal,
    rationale: result.rationale,
    headline,
    analysisSource: modelUsed ? 'Gemini-AI' : 'rules-engine',
  })
}
