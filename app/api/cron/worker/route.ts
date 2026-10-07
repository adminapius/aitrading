import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'
import { scheduleWindowAction } from '@/lib/scheduled-events'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  const authorization = request.headers.get('authorization')?.trim()
  const supplied = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!secret || !supplied) return false

  const expectedBytes = Buffer.from(secret)
  const suppliedBytes = Buffer.from(supplied)
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
}

async function recordScanError(message: string) {
  if (!tradingConfig.supabaseUrl || !tradingConfig.supabaseKey) return
  await fetch(`${tradingConfig.supabaseUrl}/rest/v1/ait_logevents`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      level: 'error',
      event_type: 'SCHEDULED_SCAN_ERROR',
      message: message.slice(0, 240),
      payload: { source: 'vercel-cron', schedule: 'America/New_York' },
    }),
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  })
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const now = new Date()
  const action = scheduleWindowAction(now)
  if (!action) return NextResponse.json({ status: 'outside_schedule_window', checkedAt: now.toISOString() })

  const workerSecret = process.env.WORKER_RUN_SECRET?.trim()
  if (!workerSecret) return NextResponse.json({ error: 'Worker authentication is not configured.' }, { status: 503 })

  let candidates: unknown[] = []
  let scanError: string | null = null
  let scanId: string | undefined
  let scanStartedAt: string | undefined
  if (action === 'wake') {
    try {
      const scanResponse = await fetch(new URL('/api/scan?top=25', request.url), {
        signal: AbortSignal.timeout(15000),
        cache: 'no-store',
      })
      const scanData = await scanResponse.json().catch(() => ({})) as { candidates?: unknown[]; error?: string; scanId?: string; scanStartedAt?: string }
      if (!scanResponse.ok) scanError = scanData.error ?? `Scheduled market scan failed (${scanResponse.status}).`
      else {
        candidates = Array.isArray(scanData.candidates) ? scanData.candidates : []
        scanId = scanData.scanId
        scanStartedAt = scanData.scanStartedAt
      }
    } catch (error) {
      scanError = error instanceof Error ? error.message : 'Scheduled market scan could not be completed.'
    }
  }

  let workerResponse: Response
  try {
    workerResponse = await fetch(new URL('/api/worker/run', request.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${workerSecret}`, 'content-type': 'application/json', 'x-trigger-source': 'vercel-cron', ...(scanId ? { 'x-scan-id': scanId } : {}) },
      body: JSON.stringify({ candidates, triggerSource: 'vercel-cron', scanId, scanStartedAt }),
      signal: AbortSignal.timeout(20000),
      cache: 'no-store',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scheduled worker request could not be completed.'
    await recordScanError(message).catch(() => undefined)
    return NextResponse.json({ status: 'worker_unreachable', error: message, scannedCandidates: candidates.length }, { status: 502 })
  }

  const workerResult = await workerResponse.json().catch(() => ({}))
  if (scanError) {
    await recordScanError(scanError).catch(() => undefined)
    return NextResponse.json({ status: 'scan_failed', error: scanError, scannedCandidates: 0, worker: workerResult }, { status: 502 })
  }

  return NextResponse.json({
    status: workerResponse.ok ? 'scheduled_run_complete' : 'worker_failed',
    scheduledAction: action,
    checkedAt: now.toISOString(),
    scannedCandidates: candidates.length,
    worker: workerResult,
  }, { status: workerResponse.status })
}
