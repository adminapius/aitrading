import { NextRequest } from 'next/server'
import { handle } from '@/lib/assistant/http'
import { upsert } from '@/lib/assistant/store'

export const dynamic = 'force-dynamic'

// Jose's edits to a round trip: setup tag, notes, stop (for R).
export async function PATCH(request: NextRequest) {
  return handle(request, 'session', async () => {
    const body = await request.json() as { key?: string; setup?: string; notes?: string; stop?: number | null }
    if (!body.key || body.key.length > 200) throw new Error('trade key required')
    const row: Record<string, unknown> = { trade_key: body.key, updated_at: new Date().toISOString() }
    if (body.setup !== undefined) row.setup = String(body.setup).slice(0, 60)
    if (body.notes !== undefined) row.notes = String(body.notes).slice(0, 4000)
    if (body.stop !== undefined) row.stop = body.stop == null || !(Number(body.stop) > 0) ? null : Number(body.stop)
    await upsert('ait_manual_trade_notes', [row], 'trade_key')
    return { ok: true }
  })
}
