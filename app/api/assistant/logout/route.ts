import { NextResponse } from 'next/server'
import { SESSION_COOKIE } from '@/lib/assistant/store'

export async function POST() {
  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 0 })
  return response
}
