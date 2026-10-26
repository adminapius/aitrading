import { NextRequest, NextResponse } from 'next/server'
import { newSession, passwordOk, SESSION_COOKIE, sessionSecret } from '@/lib/assistant/store'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const { password } = await request.json().catch(() => ({ password: '' })) as { password?: string }
  const secret = sessionSecret()
  if (secret.length < 32) return NextResponse.json({ error: 'ASSISTANT_SESSION_SECRET is not set (32+ characters).' }, { status: 503 })
  if (!passwordOk(String(password ?? ''))) return NextResponse.json({ error: 'Wrong password (or ASSISTANT_PASSWORD is not set; 12+ characters).' }, { status: 401 })
  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, newSession(secret), { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 12 * 3600 })
  return response
}
