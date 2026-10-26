import { NextRequest } from 'next/server'
import { handle } from '@/lib/assistant/http'
import { insert, select } from '@/lib/assistant/store'

export const dynamic = 'force-dynamic'

// "Save plan" from the risk calculator: symbol, entry, stop, setup. The journal matches it to the next fill (A8).
export async function POST(request: NextRequest) {
  return handle(request, 'session', async () => {
    const b = await request.json() as { symbol?: string; entry?: number; stop?: number; setup?: string }
    const symbol = String(b.symbol ?? '').trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) throw new Error('valid symbol required')
    if (!(Number(b.entry) > 0) || !(Number(b.stop) > 0) || Number(b.stop) >= Number(b.entry)) throw new Error('entry and a stop below it required')
    await insert('ait_trade_plans', [{ symbol, entry: Number(b.entry), stop: Number(b.stop), setup: b.setup ? String(b.setup).slice(0, 60) : null }])
    return { ok: true }
  })
}

export async function GET(request: NextRequest) {
  return handle(request, 'session', async () => ({ plans: await select('ait_trade_plans', { select: '*', created_at: `gte.${new Date(Date.now() - 24 * 3_600_000).toISOString()}`, order: 'created_at.desc', limit: '50' }) }))
}
