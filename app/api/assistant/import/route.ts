import { NextRequest } from 'next/server'
import { assertSeparateAccount } from '@/lib/assistant/alpaca-read'
import { handle } from '@/lib/assistant/http'
import { importFills, limitPush, loadJournal } from '@/lib/assistant/service'

export const dynamic = 'force-dynamic'

// Fill import (every 5 min in market hours from the assistant service, or the page's "Import now" button).
export async function POST(request: NextRequest) {
  return handle(request, 'either', async () => {
    const result = await importFills()
    const journal = await loadJournal(await assertSeparateAccount())
    const pushed = await limitPush(journal.limits).catch(() => null)
    return { ...result, limits: journal.limits, limitPush: pushed }
  })
}
