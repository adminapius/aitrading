type NotificationInput = {
  title: string
  message: string
}

function configured(name: string) {
  return Boolean(process.env[name])
}

export async function sendTradingNotification({ title, message }: NotificationInput) {
  const results: Array<{ channel: string; delivered: boolean }> = []

  if (configured('TELEGRAM_BOT_TOKEN') && configured('TELEGRAM_CHAT_ID')) {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `${title}\n${message}` }),
      cache: 'no-store',
    })
    results.push({ channel: 'telegram', delivered: response.ok })
  }

  if (configured('NTFY_TOPIC_URL')) {
    const response = await fetch(process.env.NTFY_TOPIC_URL!, {
      method: 'POST',
      headers: {
        Title: title,
        ...(process.env.NTFY_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.NTFY_AUTH_TOKEN}` } : {}),
      },
      body: message,
      cache: 'no-store',
    })
    results.push({ channel: 'ntfy', delivered: response.ok })
  }

  return results
}
