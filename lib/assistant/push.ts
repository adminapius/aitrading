// Phone alerts (A2) through the app's EXISTING notification channel (Telegram and/or ntfy: TELEGRAM_BOT_TOKEN +
// TELEGRAM_CHAT_ID, NTFY_TOPIC_URL). No new keys. Titles start with "[Assistant]" so they stand apart from E's alerts.
import { sendTradingNotification } from '@/lib/notifications'

export async function pushAll(message: { title: string; body: string }) {
  const results = await sendTradingNotification({ title: `[Assistant] ${message.title}`, message: message.body })
  return { sent: results.filter((r) => r.delivered).length, channels: results.map((r) => r.channel) }
}
