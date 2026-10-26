import { NextRequest } from 'next/server'
import { handle } from '@/lib/assistant/http'
import { DEFAULT_FILTERS, type Filters } from '@/lib/assistant/scanner'
import { loadSettings } from '@/lib/assistant/service'
import { upsert } from '@/lib/assistant/store'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  return handle(request, 'session', () => loadSettings())
}

const num = (v: unknown, min: number, max: number) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : null)

export async function PUT(request: NextRequest) {
  return handle(request, 'session', async () => {
    const b = await request.json() as { filters?: Partial<Filters>; maxLossPct?: number; maxTrades?: number; setups?: string[] }
    const f = b.filters ?? {}
    const filters: Filters = {
      floatMax: num(f.floatMax, 0, 1e10), priceMin: num(f.priceMin, 0, 1e5), priceMax: num(f.priceMax, 0, 1e5), gainMin: num(f.gainMin, 0, 1e4), rvolMin: num(f.rvolMin, 0, 1e4),
      newsMinutes: num(f.newsMinutes, 0, 1440), excludeDilution: Boolean(f.excludeDilution), excludeHalted: f.excludeHalted == null ? DEFAULT_FILTERS.excludeHalted : Boolean(f.excludeHalted),
      windowStart: num(f.windowStart, 0, 1440) ?? DEFAULT_FILTERS.windowStart, windowEnd: num(f.windowEnd, 0, 1440) ?? DEFAULT_FILTERS.windowEnd, reAlertNewHigh: Boolean(f.reAlertNewHigh),
    }
    const setups = (b.setups ?? []).map((s) => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 20)
    await upsert('ait_assistant_settings', [{ id: 1, filters, max_loss_pct: num(b.maxLossPct, 0.001, 0.5) ?? 0.03, max_trades: Math.round(num(b.maxTrades, 1, 50) ?? 4), ...(setups.length ? { setups } : {}), updated_at: new Date().toISOString() }], 'id')
    return loadSettings()
  })
}
