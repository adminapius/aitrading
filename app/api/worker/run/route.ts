import { NextRequest, NextResponse } from 'next/server'
import { tradingConfig } from '@/lib/trading-config'
import { decideEntry, isFlattenWindow, isTradingWindow, strategyGuardrails, type ScanCandidate } from '@/lib/strategy'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  if (tradingConfig.mode !== 'paper' || strategyGuardrails.liveTradingEnabled) return NextResponse.json({ error: 'Live execution is disabled by guardrails.' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const now = new Date()
  if (!isTradingWindow(now) && !isFlattenWindow(now)) return NextResponse.json({ status: 'sleeping', mode: 'paper', checkedAt: now.toISOString() })
  if (isFlattenWindow(now)) return NextResponse.json({ status: 'flatten_required', mode: 'paper', action: 'close_all_positions', checkedAt: now.toISOString() })
  const candidates = Array.isArray(body.candidates) ? body.candidates : []
  const equity = Number(body.equity ?? 2000)
  const decisions = candidates.map((candidate: ScanCandidate) => decideEntry(candidate, equity)).filter((decision: ReturnType<typeof decideEntry>) => decision.action !== 'hold')
  return NextResponse.json({ status: 'paper_decisions_ready', mode: 'paper', checkedAt: now.toISOString(), decisions, requiresOrderReview: true })
}
