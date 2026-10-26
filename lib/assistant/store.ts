// Supabase access for the assistant's own tables (ait_assistant_*, ait_manual_*, ait_trade_plans, ait_push_*,
// ait_edgar_daily) and the screenshot bucket. It never reads or writes Strategy E's tables.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { ASSISTANT_ENV } from '@/lib/assistant/config'
import { supabaseHeaders, tradingConfig } from '@/lib/trading-config'

const ALLOWED = /^(ait_assistant_settings|ait_manual_fills|ait_trade_plans|ait_manual_trade_notes|ait_assistant_days|ait_assistant_alerts|ait_assistant_halts|ait_edgar_daily)$/

async function rest<T>(method: string, table: string, params: Record<string, string> = {}, body?: unknown, prefer?: string): Promise<T> {
  if (!ALLOWED.test(table)) throw new Error(`assistant store: table ${table} is not an assistant table`)
  const url = new URL(`${tradingConfig.supabaseUrl}/rest/v1/${table}`)
  url.search = new URLSearchParams(params).toString()
  const response = await fetch(url, { method, headers: { ...supabaseHeaders(), ...(prefer ? { Prefer: prefer } : {}) }, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), cache: 'no-store' })
  if (!response.ok) throw new Error(`assistant store ${method} ${table} failed (${response.status}): ${(await response.text()).slice(0, 160)}`)
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

export const select = <T>(table: string, params: Record<string, string>) => rest<T[]>('GET', table, params)
export const insert = (table: string, rows: unknown) => rest<null>('POST', table, {}, rows, 'return=minimal')
export const upsert = (table: string, rows: unknown, onConflict: string) => rest<null>('POST', table, { on_conflict: onConflict }, rows, 'resolution=merge-duplicates,return=minimal')
export const patch = (table: string, params: Record<string, string>, values: unknown) => rest<null>('PATCH', table, params, values, 'return=minimal')
export const remove = (table: string, params: Record<string, string>) => rest<null>('DELETE', table, params, undefined, 'return=minimal')

const BUCKET = 'assistant-screenshots'
export async function uploadScreenshot(path: string, bytes: ArrayBuffer, contentType: string) {
  const response = await fetch(`${tradingConfig.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', headers: { apikey: tradingConfig.supabaseKey!, Authorization: `Bearer ${tradingConfig.supabaseKey}`, 'Content-Type': contentType, 'x-upsert': 'true' }, body: bytes, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`screenshot upload failed (${response.status})`)
  return path
}
export async function signedScreenshotUrl(path: string, seconds = 3600) {
  const response = await fetch(`${tradingConfig.supabaseUrl}/storage/v1/object/sign/${BUCKET}/${path}`, { method: 'POST', headers: { ...supabaseHeaders() }, body: JSON.stringify({ expiresIn: seconds }), signal: AbortSignal.timeout(10_000) })
  if (!response.ok) return null
  const json = await response.json() as { signedURL?: string }
  return json.signedURL ? `${tradingConfig.supabaseUrl}/storage/v1${json.signedURL}` : null
}

// ---------------- access control ----------------
// The dashboard has no login; the assistant does: a password (ASSISTANT_PASSWORD) gives a signed, HttpOnly session
// cookie for 12 hours (signed with a key derived from the password, so no extra secret). The assistant Railway
// service uses the existing WORKER_RUN_SECRET as its bearer secret.

export const SESSION_COOKIE = 'assistant_session'
const SESSION_HOURS = 12

/** "<expiry ms>.<hmac>" signed with the key derived from ASSISTANT_PASSWORD. Pure given the secret. */
export function signSession(expiresAt: number, secret: string) {
  return `${expiresAt}.${createHmac('sha256', secret).update(String(expiresAt)).digest('base64url')}`
}
export function verifySession(token: string | undefined, secret: string, now = Date.now()) {
  if (!token || !secret) return false
  const [exp, mac] = token.split('.')
  if (!exp || !mac || !(Number(exp) > now)) return false
  const expected = signSession(Number(exp), secret).split('.')[1]
  const a = Buffer.from(mac), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
export const newSession = (secret: string) => signSession(Date.now() + SESSION_HOURS * 3_600_000, secret)
/** Session signing key derived from ASSISTANT_PASSWORD (changing the password signs everyone out). */
export const sessionSecret = () => { const pw = process.env[ASSISTANT_ENV.password]?.trim() ?? ''; return pw ? createHmac('sha256', 'aitrading-assistant-session-v1').update(pw).digest('hex') : '' }

export function passwordOk(supplied: string) {
  const expected = process.env[ASSISTANT_ENV.password]?.trim() ?? ''
  if (!expected || expected.length < 12) return false
  const a = Buffer.from(createHmac('sha256', 'pw').update(supplied).digest()), b = Buffer.from(createHmac('sha256', 'pw').update(expected).digest())
  return timingSafeEqual(a, b)
}

export function isSession(request: NextRequest) {
  return verifySession(request.cookies.get(SESSION_COOKIE)?.value, sessionSecret())
}
export function isService(request: NextRequest) {
  const secret = process.env[ASSISTANT_ENV.serviceSecret]?.trim()
  const supplied = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!secret || !supplied) return false
  const a = Buffer.from(supplied), b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}
