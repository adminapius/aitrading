import { NextRequest } from 'next/server'
import { assertSeparateAccount } from '@/lib/assistant/alpaca-read'
import { handle } from '@/lib/assistant/http'
import { vapidPublicKey } from '@/lib/assistant/push'

export const dynamic = 'force-dynamic'

// Signed in + the A1 guard: refuses (409) with E's keys or E's account.
export async function GET(request: NextRequest) {
  return handle(request, 'session', async () => {
    const account = await assertSeparateAccount()
    return { ok: true, mode: account.mode, equity: account.equity, dayStartEquity: account.last_equity, buyingPower: account.buying_power, vapidPublicKey: vapidPublicKey() || null }
  })
}
