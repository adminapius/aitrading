import { NextRequest } from 'next/server'
import { handle } from '@/lib/assistant/http'
import { insert } from '@/lib/assistant/store'

export const dynamic = 'force-dynamic'

// Trading-status and LULD messages from the assistant service's Alpaca stream (A6).
export async function POST(request: NextRequest) {
  return handle(request, 'service', async () => {
    const b = await request.json() as { rows?: Array<{ symbol?: string; status?: string; reason?: string; at?: string }> }
    const rows = (b.rows ?? []).filter((r) => r.symbol && /^(halted|resumed|luld)$/.test(r.status ?? '') && r.at && Number.isFinite(Date.parse(r.at)))
      .slice(0, 500).map((r) => ({ symbol: r.symbol!.toUpperCase(), status: r.status, reason: r.reason?.slice(0, 120) ?? null, at: r.at }))
    if (rows.length) await insert('ait_assistant_halts', rows)
    return { stored: rows.length }
  })
}
