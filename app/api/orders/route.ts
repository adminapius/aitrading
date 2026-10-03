import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST() {
  return NextResponse.json({ error: 'Order execution is intentionally disabled until the Railway worker is connected and paper-mode approval is enabled.' }, { status: 423 })
}

export async function GET() {
  return NextResponse.json({ mode: 'paper', execution: 'worker-only', liveTradingEnabled: false })
}
