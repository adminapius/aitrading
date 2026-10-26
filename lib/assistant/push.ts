// Web Push (A2) to the browser and the phone. No data provider; VAPID keys from the environment.
import webpush from 'web-push'
import { ASSISTANT_ENV } from '@/lib/assistant/config'
import { remove, select } from '@/lib/assistant/store'

export const vapidPublicKey = () => process.env[ASSISTANT_ENV.vapidPublic]?.trim() ?? ''

function configure() {
  const pub = vapidPublicKey(), priv = process.env[ASSISTANT_ENV.vapidPrivate]?.trim(), subject = process.env[ASSISTANT_ENV.vapidSubject]?.trim()
  if (!pub || !priv || !subject) throw new Error(`${ASSISTANT_ENV.vapidPublic}, ${ASSISTANT_ENV.vapidPrivate} and ${ASSISTANT_ENV.vapidSubject} must be set for push notifications.`)
  webpush.setVapidDetails(subject, pub, priv)
}

/** Sends to every saved subscription; drops subscriptions the push service says are gone (404 / 410). */
export async function pushAll(message: { title: string; body: string; url?: string }) {
  configure()
  const subs = await select<{ endpoint: string; subscription: webpush.PushSubscription }>('ait_push_subscriptions', { select: 'endpoint,subscription' })
  let sent = 0
  for (const s of subs) {
    try { await webpush.sendNotification(s.subscription, JSON.stringify(message), { TTL: 600, urgency: 'high' }); sent += 1 }
    catch (error) {
      const code = (error as { statusCode?: number }).statusCode
      if (code === 404 || code === 410) await remove('ait_push_subscriptions', { endpoint: `eq.${s.endpoint}` })
    }
  }
  return { sent, subscriptions: subs.length }
}
