// Pure helpers for turning an Alpaca snapshot into a position mark.
// A mark is the price the worker uses to value an open position and check its stop/target.
//
// Why both quote and trade: Alpaca's latestQuote.t only moves when the NBBO changes. On thin
// small caps the NBBO can sit unchanged for minutes while trades keep printing, so a quote-only
// freshness check wrongly treats a live stock as stale (VEEA, 2026-10-09: 211 rejected marks in
// 71 minutes while the scanner saw a fresh last trade every scan).

export type PaperMarkSource = 'quote' | 'trade'

export type SnapshotLike = {
  latestQuote?: { bp?: number; ap?: number; t?: string } | null
  latestTrade?: { p?: number; t?: string } | null
} | null | undefined

export type BuiltPaperMark = {
  symbol: string
  price: number
  bid: number
  ask: number
  at: string
  source: PaperMarkSource
}

export type PaperMarkDiagnosis = {
  symbol: string
  quoteAgeSeconds: number | null
  tradeAgeSeconds: number | null
  /** null when a valid mark was produced. */
  reason: null | 'no_snapshot' | 'quote_and_trade_stale' | 'quote_invalid_and_trade_stale' | 'quote_stale_and_no_trade'
}

/** Small allowance for clock differences between Alpaca timestamps and the worker clock. */
export const MARK_CLOCK_SKEW_MS = 5_000

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function ageMs(timestamp: unknown, now: Date): number | null {
  if (typeof timestamp !== 'string') return null
  const at = Date.parse(timestamp)
  return Number.isFinite(at) ? now.getTime() - at : null
}

function isFreshAge(age: number | null, maxAgeMs: number) {
  return age != null && age >= -MARK_CLOCK_SKEW_MS && age <= maxAgeMs
}

function seconds(age: number | null) {
  return age == null ? null : Math.round(age / 100) / 10
}

/**
 * Builds a mark from a snapshot.
 * - Fresh, sane quote (bid > 0, ask >= bid): mark at the mid, source 'quote'.
 * - Otherwise a fresh last trade: mark at the trade price, source 'trade'. The exit bid is never
 *   better than the trade price (min of a sane stale bid and the trade), so simulated exits stay
 *   conservative.
 * - Otherwise no mark, with a diagnosis explaining why.
 */
export function buildPaperMarketMark(symbol: string, snapshot: SnapshotLike, now: Date, maxAgeSeconds: number) {
  const maxAgeMs = maxAgeSeconds * 1_000
  const quote = snapshot?.latestQuote ?? null
  const trade = snapshot?.latestTrade ?? null
  const bid = positive(quote?.bp)
  const ask = positive(quote?.ap)
  const quoteAge = ageMs(quote?.t, now)
  const tradePrice = positive(trade?.p)
  const tradeAge = ageMs(trade?.t, now)
  const quoteSane = bid != null && ask != null && ask >= bid
  const diagnosis: PaperMarkDiagnosis = { symbol, quoteAgeSeconds: seconds(quoteAge), tradeAgeSeconds: seconds(tradeAge), reason: null }

  if (!snapshot) return { mark: null, diagnosis: { ...diagnosis, reason: 'no_snapshot' as const } }

  if (quoteSane && isFreshAge(quoteAge, maxAgeMs)) {
    const mark: BuiltPaperMark = { symbol, price: (bid + ask) / 2, bid, ask, at: quote!.t!, source: 'quote' }
    return { mark, diagnosis }
  }

  if (tradePrice != null && isFreshAge(tradeAge, maxAgeMs)) {
    const exitBid = quoteSane ? Math.min(bid, tradePrice) : tradePrice
    const exitAsk = quoteSane ? Math.max(ask, tradePrice) : tradePrice
    const mark: BuiltPaperMark = { symbol, price: tradePrice, bid: exitBid, ask: exitAsk, at: trade!.t!, source: 'trade' }
    return { mark, diagnosis }
  }

  const reason = tradePrice == null
    ? 'quote_stale_and_no_trade' as const
    : quoteSane ? 'quote_and_trade_stale' as const : 'quote_invalid_and_trade_stale' as const
  return { mark: null, diagnosis: { ...diagnosis, reason } }
}

/** Entries must only use a fresh executable quote; trade-derived marks are for managing open positions. */
export function isExecutableQuoteMark(mark: { source?: PaperMarkSource } | null | undefined) {
  return Boolean(mark) && mark!.source !== 'trade'
}
