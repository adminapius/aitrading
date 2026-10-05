import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { sendTradingNotification } from '@/lib/notifications'
import { decideEntry, isFlattenWindow, isTradingWindow, normalizeFloatShares, strategyGuardrails, type ScanCandidate } from '@/lib/strategy'

export const dynamic = 'force-dynamic'

function isAuthorized(request: NextRequest) {
  const configuredSecret = process.env.WORKER_RUN_SECRET?.trim()
  const authorization = request.headers.get('authorization')?.trim()
  const suppliedSecret = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!configuredSecret || !suppliedSecret) return false

  const configuredBytes = Buffer.from(configuredSecret)
  const suppliedBytes = Buffer.from(suppliedSecret)
  return configuredBytes.length === suppliedBytes.length && timingSafeEqual(configuredBytes, suppliedBytes)
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (tradingConfig.mode !== 'paper' || strategyGuardrails.liveTradingEnabled) return NextResponse.json({ error: 'Live execution is disabled by guardrails.' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const now = new Date()
  if (!isTradingWindow(now) && !isFlattenWindow(now)) return NextResponse.json({ status: 'sleeping', mode: 'paper', checkedAt: now.toISOString() })
  if (isFlattenWindow(now)) return NextResponse.json({ status: 'flatten_required', mode: 'paper', action: 'close_all_positions', checkedAt: now.toISOString() })
  if (!tradingConfig.supabaseUrl || !tradingConfig.supabaseKey) {
    return NextResponse.json({ error: 'Internal paper-trading ledger is unavailable.' }, { status: 503 })
  }
  const ledgerResponse = await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_papermoney?select=starting_balance,cash_balance,equity&account_name=eq.paper-main&is_active=eq.true&limit=1`, {
    headers: supabaseHeaders(),
    cache: 'no-store',
  })
  if (!ledgerResponse.ok) return NextResponse.json({ error: 'Internal paper-trading ledger could not be read.' }, { status: 503 })
  const ledger = (await ledgerResponse.json()) as Array<{ starting_balance?: number; cash_balance?: number; equity?: number }>
  const account = ledger[0]
  const startingBalance = Number(account?.starting_balance)
  const cashBalance = Number(account?.cash_balance)
  const equity = Math.min(Number(account?.equity ?? startingBalance), startingBalance)
  if (!Number.isFinite(equity) || equity <= 0 || !Number.isFinite(cashBalance) || cashBalance < 0) return NextResponse.json({ error: 'Internal paper-trading ledger has no valid sizing balance.' }, { status: 503 })

  const deployedCapital = Math.max(0, equity - cashBalance)
  const exposureLimit = equity * strategyGuardrails.maxAggregateExposureFraction
  let remainingAllocation = Math.max(0, Math.min(exposureLimit - deployedCapital, cashBalance))
  const candidates = Array.isArray(body.candidates) ? body.candidates : []
  const decisions: Array<ReturnType<typeof decideEntry>> = []
  for (const candidate of candidates as ScanCandidate[]) {
    const decision = decideEntry(candidate, equity, now, remainingAllocation)
    console.info('[worker] strategy decision', {
      symbol: candidate.symbol,
      action: decision.action,
      floatSource: candidate.floatSource ?? 'missing',
      floatShares: candidate.float ?? null,
      normalizedFloatShares: candidate.float == null ? null : normalizeFloatShares(candidate.float, candidate.floatSource),
      remainingAllocation,
    })
    if (decision.action !== 'hold') {
      remainingAllocation = Math.max(0, remainingAllocation - decision.suggestedShares * candidate.price)
      decisions.push(decision)
    }
  }
  const notificationResults = body.notify && decisions.length
    ? await sendTradingNotification({ title: 'AItrading paper scan', message: `${decisions.length} paper decision(s) ready: ${decisions.map((decision) => `${decision.action.toUpperCase()} ${decision.symbol}`).join(', ')}` })
    : []
  return NextResponse.json({ status: 'paper_decisions_ready', mode: 'paper', checkedAt: now.toISOString(), decisions, notificationResults, requiresOrderReview: true })
}
