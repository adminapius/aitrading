import { NextRequest, NextResponse } from 'next/server'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { sendTradingNotification } from '@/lib/notifications'
import { decideEntry, isFlattenWindow, isTradingWindow, strategyGuardrails, type ScanCandidate } from '@/lib/strategy'

export const dynamic = 'force-dynamic'

function isAuthorized(request: NextRequest) {
  const configuredSecret = process.env.WORKER_RUN_SECRET?.trim()
  const suppliedSecret = request.headers.get('x-worker-secret')?.trim()
  return Boolean(configuredSecret && suppliedSecret && suppliedSecret === configuredSecret)
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
  const equity = Math.min(cashBalance, startingBalance)
  if (!Number.isFinite(equity) || equity <= 0) return NextResponse.json({ error: 'Internal paper-trading ledger has no valid sizing balance.' }, { status: 503 })
  const candidates = Array.isArray(body.candidates) ? body.candidates : []
  const decisions: Array<ReturnType<typeof decideEntry>> = candidates
    .map((candidate: ScanCandidate) => decideEntry(candidate, equity))
    .filter((decision: ReturnType<typeof decideEntry>) => decision.action !== 'hold')
  const notificationResults = body.notify && decisions.length
    ? await sendTradingNotification({ title: 'AItrading paper scan', message: `${decisions.length} paper decision(s) ready: ${decisions.map((decision) => `${decision.action.toUpperCase()} ${decision.symbol}`).join(', ')}` })
    : []
  return NextResponse.json({ status: 'paper_decisions_ready', mode: 'paper', checkedAt: now.toISOString(), decisions, notificationResults, requiresOrderReview: true })
}
