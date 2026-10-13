import type { PaperMarketMark } from '@/lib/paper-trading'
import { alpacaHeaders, tradingConfig } from '@/lib/trading-config'
import {
  STRATEGY_M_RULE,
  MIDDAY_VARIANTS,
  firstMiddaySignal,
  isMiddayEntryWindow,
  middayConfig,
  middayEntryLevels,
  middayShares,
  type MiddayBar,
} from '@/lib/strategies/midday-momentum'
import {
  admitShadowEntry,
  loadOpenShadowRows,
  loadShadowLedger,
  loadShadowMarks,
  resolveShadowPositions,
  shadowRequest,
  type ShadowBlockReason,
  type ShadowResolutionStats,
} from '@/lib/strategies/shadow-strategy'

/** Strategy M bars are always SIP, independent of ALPACA_DATA_FEED. */
const MIDDAY_FEED = 'sip'

export type MiddayShadowStats = ShadowResolutionStats & {
  strategy: 'M'
  inEntryWindow: boolean
  evaluated: number
  signals: number
  opened: number
  skippedOpen: number
  blocked: Partial<Record<ShadowBlockReason, number>>
  equity: number | null
  dailyPnl: number | null
}

function easternSessionOpen(now: Date) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now)
  const offsetName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(now).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-5'
  const hours = Number(offsetName.replace('GMT', '')) || -5
  const sign = hours < 0 ? '-' : '+'
  return new Date(`${day}T09:30:00${sign}${String(Math.abs(hours)).padStart(2, '0')}:00`)
}

async function alpacaData(path: string) {
  const response = await fetch(`${tradingConfig.alpacaDataUrl}${path}`, { headers: alpacaHeaders(), cache: 'no-store' })
  if (!response.ok) throw new Error(`Alpaca data ${response.status} for ${path.split('?')[0]}`)
  return response.json()
}

/** Closed 1-minute SIP bars for today's regular session, keyed by symbol. The forming bar is excluded. */
export async function loadMiddayBars(symbols: string[], now: Date) {
  const result = new Map<string, MiddayBar[]>()
  if (!symbols.length) return result
  const start = easternSessionOpen(now)
  const lastClosedStart = Math.floor(now.getTime() / 60_000) * 60_000 - 60_000
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Min', start: start.toISOString(), end: new Date(lastClosedStart + 59_000).toISOString(), feed: MIDDAY_FEED, adjustment: 'raw', limit: '10000' })
    if (pageToken) params.set('page_token', pageToken)
    const payload = await alpacaData(`/v2/stocks/bars?${params}`)
    for (const [symbol, rows] of Object.entries((payload?.bars ?? {}) as Record<string, Array<Record<string, unknown>>>)) {
      const bars = result.get(symbol) ?? []
      for (const row of rows) {
        const t = Date.parse(String(row.t))
        if (!(t <= lastClosedStart)) continue
        bars.push({ t, o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c), v: Number(row.v), vw: Number.isFinite(Number(row.vw)) ? Number(row.vw) : undefined })
      }
      result.set(symbol, bars)
    }
    pageToken = typeof payload?.next_page_token === 'string' && payload.next_page_token ? payload.next_page_token : undefined
  } while (pageToken)
  for (const bars of result.values()) bars.sort((a, b) => a.t - b.t)
  return result
}

/** Previous regular-session close from the SIP snapshot. */
export async function loadPrevCloses(symbols: string[]) {
  const result = new Map<string, number>()
  for (let index = 0; index < symbols.length; index += 100) {
    const chunk = symbols.slice(index, index + 100)
    const payload = await alpacaData(`/v2/stocks/snapshots?${new URLSearchParams({ symbols: chunk.join(','), feed: MIDDAY_FEED })}`)
    for (const [symbol, snapshot] of Object.entries((payload ?? {}) as Record<string, { prevDailyBar?: { c?: number } }>)) {
      const close = Number(snapshot?.prevDailyBar?.c)
      if (close > 0) result.set(symbol, close)
    }
  }
  return result
}

/**
 * One Strategy M shadow pass: resolve open M rows (stop / 2R target / 15:55 flatten), then — only inside the
 * 11:00–15:30 ET window — record new simulated entries on M's own $2,000 ledger. Writes ait_shadow_signals only;
 * it has no broker dependency and never places an order.
 */
export async function runMiddayShadowPass(input: {
  scanId: string
  sessionId: string
  now: Date
  flatten: boolean
  regime: string
  slippageFraction: number
  candidates: Array<{ symbol: string }>
  marks: Map<string, PaperMarketMark>
  isExecutable: (mark: PaperMarketMark | undefined) => boolean
}): Promise<MiddayShadowStats> {
  const openRows = await loadOpenShadowRows(input.sessionId, STRATEGY_M_RULE)
  const marks = await loadShadowMarks(openRows, input.marks, input.now)
  const resolution = await resolveShadowPositions({ openRows, now: input.now, flatten: input.flatten, slippageFraction: input.slippageFraction, marks })
  const inEntryWindow = !input.flatten && isMiddayEntryWindow(input.now)
  const stats: MiddayShadowStats = { strategy: 'M', ...resolution, inEntryWindow, evaluated: 0, signals: 0, opened: 0, skippedOpen: 0, blocked: {}, equity: null, dailyPnl: null }
  if (!inEntryWindow) return stats

  const ledger = await loadShadowLedger({ sessionId: input.sessionId, startingBalance: middayConfig.startingEquity, marks, slippageFraction: input.slippageFraction, rule: STRATEGY_M_RULE })
  stats.equity = ledger.equity
  stats.dailyPnl = ledger.dailyPnl
  const symbols = [...new Set(input.candidates.map(({ symbol }) => symbol))].filter((symbol) => input.isExecutable(marks.get(symbol)))
  if (!symbols.length) return stats
  const [barsBySymbol, prevCloses] = await Promise.all([loadMiddayBars(symbols, input.now), loadPrevCloses(symbols)])

  for (const symbol of symbols) {
    const mark = marks.get(symbol)
    const bars = barsBySymbol.get(symbol)
    const prevClose = prevCloses.get(symbol)
    if (!mark || !input.isExecutable(mark) || !bars || !prevClose) continue
    stats.evaluated += 1
    const signal = firstMiddaySignal(MIDDAY_VARIANTS, bars, prevClose)
    if (!signal) continue
    stats.signals += 1
    const levels = middayEntryLevels(signal, mark.ask, input.slippageFraction)
    const shares = middayShares(ledger.equity, levels.fill, signal.riskPerShare)
    if (shares <= 0) continue
    const admission = admitShadowEntry(ledger, { symbol, fill: levels.fill, shares, now: input.now })
    if (!admission.admitted) {
      if (admission.blockedBy === 'symbol_already_open') stats.skippedOpen += 1
      else stats.blocked[admission.blockedBy] = (stats.blocked[admission.blockedBy] ?? 0) + 1
      continue
    }
    await shadowRequest('ait_shadow_signals?on_conflict=signal_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        signal_key: `${input.sessionId}:${symbol}:${STRATEGY_M_RULE}:${input.scanId}`,
        symbol,
        scan_id: input.scanId,
        session_id: input.sessionId,
        rule: STRATEGY_M_RULE,
        regime: input.regime,
        wave_confidence: 0,
        trigger_price: levels.fill,
        stop: levels.stop,
        t1: levels.target,
        would_be_shares: admission.shares,
        triggered_at: input.now.toISOString(),
        metadata: {
          strategy: 'M',
          variant: signal.variant,
          reason: signal.reason,
          signalClose: signal.triggerPrice,
          observedAsk: mark.ask,
          observedBid: mark.bid,
          riskPerShare: signal.riskPerShare,
          targetR: middayConfig.targetR,
          prevClose,
          feed: MIDDAY_FEED,
          shadowEquity: ledger.equity,
        },
      }),
    })
    stats.opened += 1
  }
  return stats
}
