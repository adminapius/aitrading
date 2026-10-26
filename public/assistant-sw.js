// Assistant mode service worker: shows push notifications (alerts and daily limits). It never sends orders.
self.addEventListener('push', (event) => {
  let data = { title: 'Assistant', body: '', url: '/assistant' }
  try { data = { ...data, ...event.data.json() } } catch (_) { /* plain text */ }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, data: { url: data.url }, tag: data.title, renotify: true }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/assistant'
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) if (c.url.includes('/assistant') && 'focus' in c) return c.focus()
    return self.clients.openWindow(url)
  }))
})
