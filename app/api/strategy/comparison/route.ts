import { NextRequest, NextResponse } from 'next/server'
import { easternMidnight, summarizeOutcomes, type StrategyOutcome } from '@/lib/strategies/comparison'
import { resolveStrategyConfig } from '@/lib/strategies/live-strategy'
import { SHADOW_STRATEGY_RULE } from '@/lib/strategies/shadow-strategy'
import { getSupabaseConfigurationError, supabaseHeaders, tradingConfig } from '@/lib/trading-config'

export const dynamic = 'force-dynamic'

const DATE = /^\d{4}-\d{2}-\d{2}$/

async function fetchRows<T>(resource: string, params: Record<string, string>) {
  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/${resource}`)
  url.search = new URLSearchParams(params).toString()
  const response = await fetch(url, { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000), cache: 'no-store' })
  if (!response.ok) throw new Error(`Strategy comparison query failed (${response.status})`)
  return await response.json() as T[]
}

type PositionRow = { id: string; entry_price: string | number; quantity: string | number; metadata: Record<string, unknown> | null }
type TradeRow = { position_id: string | null; realized_pnl: string | number | null }
type ShadowRow = { r_multiple: string | number | null; metadata: Record<string, unknown> | null }

export async function GET(request: NextRequest) {
  const configError = getSupabaseConfigurationError()
  if (configError) return NextResponse.json({ error: configError }, { status: 503 })
  const from = request.nextUrl.searchParams.get('from') ?? ''
  const to = request.nextUrl.searchParams.get('to') ?? ''
  if (!DATE.test(from) || !DATE.test(to) || from > to) return NextResponse.json({ error: 'from/to must be YYYY-MM-DD with from <= to' }, { status: 400 })

  const config = resolveStrategyConfig()
  const start = easternMidnight(from).toISOString()
  const endDate = new Date(Date.parse(`${to}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  const end = easternMidnight(endDate).toISOString()

  try {
    const [positions, shadowRows] = await Promise.all([
      fetchRows<PositionRow>('ait_positions', {
        select: 'id,entry_price,quantity,metadata',
        status: 'eq.closed',
        'metadata->>strategy': `eq.${config.live}`,
        and: `(closed_at.gte.${start},closed_at.lt.${end})`,
        limit: '2000',
      }),
      config.shadow
        ? fetchRows<ShadowRow>('ait_shadow_signals', {
          select: 'r_multiple,metadata',
          rule: `eq.${SHADOW_STRATEGY_RULE}`,
          outcome: 'not.is.null',
          and: `(outcome_at.gte.${start},outcome_at.lt.${end})`,
          limit: '5000',
        })
        : Promise.resolve([] as ShadowRow[]),
    ])

    const pnlByPosition = new Map<string, number>()
    if (positions.length) {
      const trades = await fetchRows<TradeRow>('ait_trades', {
        select: 'position_id,realized_pnl',
        side: 'eq.sell',
        position_id: `in.(${positions.map((position) => position.id).join(',')})`,
      })
      for (const trade of trades) {
        if (trade.position_id) pnlByPosition.set(trade.position_id, (pnlByPosition.get(trade.position_id) ?? 0) + Number(trade.realized_pnl ?? 0))
      }
    }

    const liveOutcomes: StrategyOutcome[] = positions.map((position) => {
      const pnl = pnlByPosition.get(position.id) ?? 0
      const riskPerShare = Number(position.metadata?.riskPerShare ?? 0)
      const quantity = Number(position.quantity)
      return { pnl, r: riskPerShare > 0 && quantity > 0 ? pnl / (riskPerShare * quantity) : null }
    })
    const shadowOutcomes: StrategyOutcome[] = shadowRows.map((row) => ({
      pnl: Number(row.metadata?.pnl ?? 0),
      r: row.r_multiple == null ? null : Number(row.r_multiple),
    }))

    return NextResponse.json({
      live: { strategy: config.live, ...summarizeOutcomes(liveOutcomes) },
      shadow: config.shadow ? { strategy: config.shadow, ...summarizeOutcomes(shadowOutcomes) } : null,
      range: { from, to },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Strategy comparison failed' }, { status: 502 })
  }
}
