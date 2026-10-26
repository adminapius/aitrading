import { NextRequest } from 'next/server'
import { assertSeparateAccount } from '@/lib/assistant/alpaca-read'
import { handle } from '@/lib/assistant/http'
import { loadJournal } from '@/lib/assistant/service'
import { signedScreenshotUrl } from '@/lib/assistant/store'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  return handle(request, 'session', async () => {
    const account = await assertSeparateAccount()
    const journal = await loadJournal(account)
    const trades = await Promise.all(journal.trades.slice(0, 200).map(async (t) => ({ ...t, screenshotUrl: t.screenshot ? await signedScreenshotUrl(t.screenshot) : null })))
    return { ...journal, trades }
  })
}
