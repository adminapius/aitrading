import { NextRequest } from 'next/server'
import { handle } from '@/lib/assistant/http'
import { etMinute } from '@/lib/assistant/journal'
import { failedFilters } from '@/lib/assistant/scanner'
import { loadSettings, scannerRows } from '@/lib/assistant/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  return handle(request, 'session', async () => {
    const now = new Date()
    const [rows, settings] = await Promise.all([scannerRows(now), loadSettings()])
    const minute = etMinute(now.toISOString())
    return { at: now.toISOString(), rows: rows.map((r) => ({ ...r, failed: failedFilters(r, settings.filters, minute) })) }
  })
}
