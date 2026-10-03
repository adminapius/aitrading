import { NextResponse } from 'next/server'

export const dynamic = 'force-static'

export function GET() {
  return NextResponse.json({ ok: true, service: 'aitrading', checkedAt: new Date().toISOString() })
}
