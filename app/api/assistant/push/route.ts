import { NextRequest } from 'next/server'
import { handle } from '@/lib/assistant/http'
import { pushAll } from '@/lib/assistant/push'
import { remove, upsert } from '@/lib/assistant/store'

export const dynamic = 'force-dynamic'

// Save this browser's push subscription ({ subscription }), or send a test ({ test: true }), or remove ({ remove: endpoint }).
export async function POST(request: NextRequest) {
  return handle(request, 'session', async () => {
    const b = await request.json() as { subscription?: { endpoint?: string }; test?: boolean; remove?: string }
    if (b.test) return pushAll({ title: 'Assistant test', body: 'Push notifications work. Assistant only; no order was sent.', url: '/assistant' })
    if (b.remove) { await remove('ait_push_subscriptions', { endpoint: `eq.${b.remove}` }); return { ok: true } }
    if (!b.subscription?.endpoint?.startsWith('https://')) throw new Error('push subscription required')
    await upsert('ait_push_subscriptions', [{ endpoint: b.subscription.endpoint, subscription: b.subscription }], 'endpoint')
    return { ok: true }
  })
}
