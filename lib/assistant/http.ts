// Route helpers for assistant mode: access control and the A1 guard on every request that reads the manual account.
import { NextRequest, NextResponse } from 'next/server'
import { isService, isSession } from '@/lib/assistant/store'

export type Access = 'session' | 'service' | 'either'

export async function handle(request: NextRequest, access: Access, fn: () => Promise<unknown>) {
  const ok = access === 'session' ? isSession(request) : access === 'service' ? isService(request) : isSession(request) || isService(request)
  if (!ok) return NextResponse.json({ error: 'Not signed in to the assistant.' }, { status: 401 })
  try {
    return NextResponse.json(await fn())
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Assistant request failed'
    // A1 refusals (E's keys or E's account) are a 409 so the page shows the reason instead of data
    const refused = /Strategy E|separate|must be set/.test(message)
    return NextResponse.json({ error: message, refused }, { status: refused ? 409 : 500 })
  }
}
