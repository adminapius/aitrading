import { NextRequest, NextResponse } from 'next/server'
import { easternSchedule } from '@/lib/strategy'
import { elliottWaveConfig } from '@/lib/elliott-wave-config'
import { easternSevenAmStart, easternSleepStart } from '@/lib/scheduled-events'
import { getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

const regimes = new Set(['all', 'opening-momentum', 'premarket-continuation', 'news-reaction', 'midday-selective', 'late-continuation', 'exits-only'])

type TradeRow = {
  id: string
  position_id: string | null
  symbol: string
  side: string
  quantity: number | string
  filled_price: number | string | null
  realized_pnl: number | string | null
  filled_at: string | null
  metadata: Record<string, unknown> | null
}

type PositionRow = { id: string; entry_price: number | string; stop_price: number | string | null; quantity: number | string; metadata: Record<string, unknown> | null }
type SignalRow = {
  id: string
  rule: string
  regime: string
  trade_id: string | null
  triggered_at: string | null
  outcome: string | null
  outcome_at: string | null
  fill_price: number | string | null
  r_multiple: number | string | null
  would_be_shares: number
  metadata: Record<string, unknown> | null
  created_at: string
}

type Result = { r: number; pnl: number; at: string; positionId?: string }

type Metric = {
  signals: number
  closedTrades: number
  winRate: number | null
  averageR: number | null
  expectancy: number | null
  maxDrawdown: number
  totalPnl: number
}

async function fetchRows<T>(resource: string, params: URLSearchParams) {
  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/${resource}`)
  url.search = params.toString()
  const response = await fetch(url, { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000), cache: 'no-store' })
  if (!response.ok) throw new Error(`Supabase Elliott dashboard query failed (${response.status})`)
  return await response.json() as T[]
}

function dateAnchor(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T12:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null
  return date
}

function summarize(signals: number, results: Result[]): Metric {
  const ordered = [...results].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const rValues = ordered.map((result) => result.r).filter(Number.isFinite)
  const wins = rValues.filter((r) => r > 0)
  const losses = rValues.filter((r) => r <= 0)
  const averageR = rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null
  const winRate = rValues.length ? wins.length / rValues.length : null
  const averageWin = wins.length ? wins.reduce((sum, value) => sum + value, 0) / wins.length : 0
  const averageLoss = losses.length ? losses.reduce((sum, value) => sum + value, 0) / losses.length : 0
  const expectancy = winRate == null ? null : winRate * averageWin + (1 - winRate) * averageLoss
  let runningPnl = 0
  let peakPnl = 0
  let maxDrawdown = 0
  for (const result of ordered) {
    runningPnl += result.pnl
    peakPnl = Math.max(peakPnl, runningPnl)
    maxDrawdown = Math.max(maxDrawdown, peakPnl - runningPnl)
  }
  return {
    signals,
    closedTrades: results.length,
    winRate,
    averageR,
    expectancy,
    maxDrawdown,
    totalPnl: results.reduce((sum, result) => sum + result.pnl, 0),
  }
}

function parseR(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export async function GET(request: NextRequest) {
  const configurationError = getSupabaseConfigurationError()
  if (configurationError) return NextResponse.json({ error: configurationError }, { status: 503 })

  const today = easternSchedule(new Date())
  const todayKey = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`
  const fromValue = request.nextUrl.searchParams.get('from') ?? todayKey
  const toValue = request.nextUrl.searchParams.get('to') ?? todayKey
  const regime = request.nextUrl.searchParams.get('regime') ?? 'all'
  const from = dateAnchor(fromValue)
  const to = dateAnchor(toValue)
  if (!from || !to || to.getTime() < from.getTime() || to.getTime() - from.getTime() > 89 * 86_400_000 || !regimes.has(regime)) {
    return NextResponse.json({ error: 'Choose a valid date range of 90 days or less and a listed regime.' }, { status: 400 })
  }

  const startAt = easternSevenAmStart(from).toISOString()
  const endAt = new Date(easternSleepStart(to).getTime() + 5 * 60_000 - 1).toISOString()
  try {
    const tradeParams = new URLSearchParams({
      select: 'id,position_id,symbol,side,quantity,filled_price,realized_pnl,filled_at,metadata',
      side: 'in.(buy,sell)',
      status: 'eq.filled',
      order: 'filled_at.asc',
      limit: '10000',
    })
    tradeParams.append('and', `(filled_at.gte.${startAt},filled_at.lte.${endAt})`)
    const signalParams = new URLSearchParams({
      select: 'id,rule,regime,trade_id,triggered_at,outcome,outcome_at,fill_price,r_multiple,would_be_shares,metadata,created_at',
      order: 'created_at.asc',
      limit: '10000',
    })
    signalParams.append('and', `(created_at.gte.${startAt},created_at.lte.${endAt})`)
    if (regime !== 'all') signalParams.set('regime', `eq.${regime}`)
    const [allTrades, signals] = await Promise.all([
      fetchRows<TradeRow>('ait_trades', tradeParams),
      fetchRows<SignalRow>('ait_shadow_signals', signalParams),
    ])
    const matchingEntryPositions = new Set(allTrades
      .filter((trade) => trade.side === 'buy' && trade.position_id && trade.metadata?.regime === regime)
      .map((trade) => trade.position_id!))
    const trades = regime === 'all' ? allTrades : allTrades.filter((trade) => trade.position_id && matchingEntryPositions.has(trade.position_id))
    const entries = trades.filter((trade) => trade.side === 'buy' && trade.position_id)
    const exits = trades.filter((trade) => trade.side === 'sell' && trade.position_id)
    const positionsById = new Map<string, PositionRow>()
    const positionIds = [...new Set(entries.map((trade) => trade.position_id).filter((id): id is string => Boolean(id)))].slice(0, 1000)
    if (positionIds.length) {
      const positionParams = new URLSearchParams({ select: 'id,entry_price,stop_price,quantity,metadata', id: `in.(${positionIds.join(',')})`, limit: String(positionIds.length) })
      for (const position of await fetchRows<PositionRow>('ait_positions', positionParams)) positionsById.set(position.id, position)
    }
    const entryByPosition = new Map(entries.map((trade) => [trade.position_id!, trade]))
    const resultsByPosition = new Map<string, Result>()
    for (const exit of exits) {
      const positionId = exit.position_id!
      const entry = entryByPosition.get(positionId)
      const position = positionsById.get(positionId)
      if (!entry || !position) continue
      const quantity = Number(entry.quantity)
      const entryPrice = Number(position.entry_price)
      const stopPrice = Number(position.stop_price)
      const configuredRisk = parseR(position.metadata?.riskPerShare)
      const riskDollars = Math.max(0, configuredRisk ?? (Number.isFinite(stopPrice) ? entryPrice - stopPrice : 0)) * quantity
      const pnl = Number(exit.realized_pnl ?? 0)
      if (!Number.isFinite(riskDollars) || riskDollars <= 0 || !Number.isFinite(pnl)) continue
      resultsByPosition.set(positionId, { r: pnl / riskDollars, pnl, at: exit.filled_at ?? '', positionId })
    }
    const currentResults = [...resultsByPosition.values()]
    const flaggedTradeIds = new Set(signals.filter((signal) => signal.rule === 'ew_block_wave5' && signal.trade_id).map((signal) => signal.trade_id!))
    const flaggedPositionIds = new Set(entries.filter((entry) => flaggedTradeIds.has(entry.id)).map((entry) => entry.position_id!).filter(Boolean))
    const flaggedResults = currentResults.filter((result) => result.positionId && flaggedPositionIds.has(result.positionId))
    const adjustedResults = currentResults.filter((result) => !result.positionId || !flaggedPositionIds.has(result.positionId))
    const currentSignalCount = entries.length
    const currentResultsSet = new Set(currentResults.map((result) => result.positionId))
    const wave3 = signals.filter((signal) => signal.rule === 'ew_wave3')
    const wave4 = signals.filter((signal) => signal.rule === 'ew_wave4')
    const shadowMetric = (rows: SignalRow[]) => {
      const closed = rows.filter((signal) => signal.outcome != null && signal.r_multiple != null)
      return summarize(rows.filter((signal) => signal.triggered_at != null).length, closed.map((signal) => ({
        r: Number(signal.r_multiple),
        pnl: Number(signal.metadata?.totalRealizedPnl ?? (Number(signal.r_multiple) * Number(signal.metadata?.initialRiskDollars ?? 0))),
        at: signal.outcome_at ?? signal.created_at,
      })).filter((result) => Number.isFinite(result.r) && Number.isFinite(result.pnl)))
    }
    const byRule = {
      current: summarize(currentSignalCount, currentResults),
      currentMinusExhaustion: summarize(currentSignalCount - flaggedTradeIds.size, adjustedResults),
      wave3: shadowMetric(wave3),
      wave4: shadowMetric(wave4),
      exhaustionFlagged: summarize(flaggedTradeIds.size, flaggedResults),
    }
    const closedCurrentPositions = currentResultsSet.size
    const promotions = {
      exhaustionFilter: { eligible: flaggedResults.length >= elliottWaveConfig.promotion.exhaustionFlaggedTrades && (summarize(flaggedResults.length, flaggedResults).averageR ?? 0) < 0, sampleSize: flaggedResults.length, minimum: elliottWaveConfig.promotion.exhaustionFlaggedTrades },
      wave3: { eligible: byRule.wave3.closedTrades >= elliottWaveConfig.promotion.minimumShadowTrades && (byRule.wave3.expectancy ?? Number.NEGATIVE_INFINITY) >= elliottWaveConfig.promotion.minimumExpectancyR && (byRule.wave3.expectancy ?? Number.NEGATIVE_INFINITY) > (byRule.current.expectancy ?? Number.POSITIVE_INFINITY), sampleSize: byRule.wave3.closedTrades, minimum: elliottWaveConfig.promotion.minimumShadowTrades },
      wave4: { eligible: byRule.wave4.closedTrades >= elliottWaveConfig.promotion.minimumShadowTrades && (byRule.wave4.expectancy ?? Number.NEGATIVE_INFINITY) >= elliottWaveConfig.promotion.minimumExpectancyR && (byRule.wave4.expectancy ?? Number.NEGATIVE_INFINITY) > (byRule.current.expectancy ?? Number.POSITIVE_INFINITY), sampleSize: byRule.wave4.closedTrades, minimum: elliottWaveConfig.promotion.minimumShadowTrades },
    }
    return NextResponse.json({ from: fromValue, to: toValue, regime, metrics: byRule, promotions, openOrUnmatchedSignals: entries.length - closedCurrentPositions })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Elliott Wave metrics unavailable.' }, { status: 503 })
  }
}
