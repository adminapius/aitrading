import { NextRequest } from 'next/server'
import { handle } from '@/lib/assistant/http'
import { runAlerts } from '@/lib/assistant/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Called by the assistant Railway service every 15 s, 07:00-11:00 ET. Push notifications only; no orders.
export async function POST(request: NextRequest) {
  return handle(request, 'service', () => runAlerts())
}
