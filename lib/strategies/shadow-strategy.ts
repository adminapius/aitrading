import type { PaperMarketMark } from '@/lib/paper-trading'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import type { StrategyDecision, StrategyId } from './live-strategy'

export const SHADOW_STRATEGY_RULE = 'strategy_a'
export const SHADOW_TARGET_R = 1.5

export type ShadowOutcome = 'stop' | 't1' | 'flatten'

export type OpenShadowRow = { id: string; symbol: string; stop: number; t1: number; trigger_price: number; would_be_shares: number; metadata: Record<string, unknown> }

export type ShadowEntryCandidate = {
  symbol: string
  ask: number
  liveDecision: StrategyDecision
  shadowDecision: StrategyDecision
}

/** Pure: resolve a simulated shadow position against the latest mark, using the same stop/target/flatten rules as the paper ledger. */
export function resolveShadowOutcome(row: Pick<OpenShadowRow, 'stop' | 't1' | 'trigger_price'>, mark: Pick<PaperMarketMark, 'bid'>, flatten: boolean, slippageFraction: number) {
  const exitFill = mark.bid * (1 - slippageFraction)
  const risk = row.trigger_price - row.stop
  const outcome: ShadowOutcome | null = mark.bid <= row.stop ? 'stop' : mark.bid >= row.t1 ? 't1' : flatten ? 'flatten' : null
  if (!outcome) return null
  return { outcome, fillPrice: exitFill, rMultiple: risk > 0 ? (exitFill - row.trigger_price) / risk : 0 }
}

/** Pure: shadow entry levels for an A decision, matching the live entry's fill/stop/target math. */
export function shadowEntryLevels(ask: number, riskPerShare: number, slippageFraction: number) {
  const fill = ask * (1 + slippageFraction)
  return { fill, stop: Math.max(0.01, fill - riskPerShare), t1: fill + riskPerShare * SHADOW_TARGET_R }
}

async function shadowRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...supabaseHeaders(), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Shadow strategy persistence failed (${response.status})`)
  return response
}

async function loadOpenShadowRows(sessionId: string) {
  const params = new URLSearchParams({
    select: 'id,symbol,stop,t1,trigger_price,would_be_shares,metadata',
    session_id: `eq.${sessionId}`,
    rule: `eq.${SHADOW_STRATEGY_RULE}`,
    outcome: 'is.null',
  })
  const rows = await (await shadowRequest(`ait_shadow_signals?${params}`)).json() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    symbol: String(row.symbol),
    stop: Number(row.stop),
    t1: Number(row.t1),
    trigger_price: Number(row.trigger_price),
    would_be_shares: Number(row.would_be_shares),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }))
}

export type ShadowStrategyStats = { strategy: StrategyId; opened: number; resolved: number; skippedOpen: number }

/**
 * Records every entry the shadow strategy would have taken (one simulated position per symbol at a time)
 * and resolves open simulated positions against fresh marks. Never places orders.
 */
export async function runShadowStrategyPass(input: {
  strategy: StrategyId
  scanId: string
  sessionId: string
  now: Date
  regime: string
  flatten: boolean
  slippageFraction: number
  marks: Map<string, PaperMarketMark>
  entries: ShadowEntryCandidate[]
}): Promise<ShadowStrategyStats> {
  const stats: ShadowStrategyStats = { strategy: input.strategy, opened: 0, resolved: 0, skippedOpen: 0 }
  const open = await loadOpenShadowRows(input.sessionId)
  const openSymbols = new Set<string>()

  for (const row of open) {
    const mark = input.marks.get(row.symbol)
    const resolution = mark ? resolveShadowOutcome(row, mark, input.flatten, input.slippageFraction) : null
    if (!resolution) {
      openSymbols.add(row.symbol)
      continue
    }
    await shadowRequest(`ait_shadow_signals?${new URLSearchParams({ id: `eq.${row.id}` })}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        outcome: resolution.outcome,
        outcome_at: input.now.toISOString(),
        fill_price: resolution.fillPrice,
        r_multiple: resolution.rMultiple,
        metadata: { ...row.metadata, pnl: (resolution.fillPrice - row.trigger_price) * row.would_be_shares, exitBid: mark!.bid },
        updated_at: input.now.toISOString(),
      }),
    })
    stats.resolved += 1
  }

  if (input.flatten) return stats
  for (const entry of input.entries) {
    if (entry.shadowDecision.action !== 'enter' || entry.shadowDecision.suggestedShares <= 0) continue
    if (openSymbols.has(entry.symbol)) {
      stats.skippedOpen += 1
      continue
    }
    const levels = shadowEntryLevels(entry.ask, entry.shadowDecision.riskPerShare, input.slippageFraction)
    await shadowRequest('ait_shadow_signals?on_conflict=signal_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        signal_key: `${input.sessionId}:${entry.symbol}:${SHADOW_STRATEGY_RULE}:${input.scanId}`,
        symbol: entry.symbol,
        scan_id: input.scanId,
        session_id: input.sessionId,
        rule: SHADOW_STRATEGY_RULE,
        regime: input.regime,
        wave_confidence: 0,
        trigger_price: levels.fill,
        stop: levels.stop,
        t1: levels.t1,
        would_be_shares: entry.shadowDecision.suggestedShares,
        triggered_at: input.now.toISOString(),
        metadata: {
          strategy: input.strategy,
          observedAsk: entry.ask,
          riskPerShare: entry.shadowDecision.riskPerShare,
          confidence: entry.shadowDecision.confidence,
          liveStrategy: entry.liveDecision.strategy,
          liveAction: entry.liveDecision.action,
          liveBlockedBy: entry.liveDecision.blockedBy ?? null,
        },
      }),
    })
    openSymbols.add(entry.symbol)
    stats.opened += 1
  }
  return stats
}
