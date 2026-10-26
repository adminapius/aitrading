import { NextRequest } from 'next/server'
import { handle } from '@/lib/assistant/http'
import { pushAll } from '@/lib/assistant/push'

export const dynamic = 'force-dynamic'

// A test alert through the existing Telegram / ntfy channel.
export async function POST(request: NextRequest) {
  return handle(request, 'session', () => pushAll({ title: 'Test', body: 'Assistant alerts reach this channel. Assistant only; no order was sent.' }))
}
