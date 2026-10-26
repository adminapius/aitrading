import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { handle } from '@/lib/assistant/http'
import { uploadScreenshot, upsert } from '@/lib/assistant/store'

export const dynamic = 'force-dynamic'

const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

export async function POST(request: NextRequest) {
  return handle(request, 'session', async () => {
    const form = await request.formData()
    const key = String(form.get('key') ?? '')
    const file = form.get('file')
    if (!key || !(file instanceof File)) throw new Error('trade key and image required')
    const ext = TYPES[file.type]
    if (!ext) throw new Error('PNG, JPEG or WebP only')
    if (file.size > 2 * 1024 * 1024) throw new Error('2 MB at most')
    const path = `${createHash('sha256').update(key).digest('hex').slice(0, 24)}-${Date.now()}.${ext}`
    await uploadScreenshot(path, await file.arrayBuffer(), file.type)
    await upsert('ait_manual_trade_notes', [{ trade_key: key, screenshot_path: path, updated_at: new Date().toISOString() }], 'trade_key')
    return { ok: true, path }
  })
}
