import type { Metadata } from 'next'

// iPhone push needs the page added to the Home Screen (iOS 16.4+); the manifest makes that a standalone app.
export const metadata: Metadata = {
  title: 'Assistant — manual trades (no orders)',
  description: 'Scanner, alerts, risk calculator, limits and journal for manual trades. It never places orders.',
  manifest: '/assistant.webmanifest',
  appleWebApp: { capable: true, title: 'Assistant', statusBarStyle: 'black-translucent' },
  robots: { index: false, follow: false },
}

export default function AssistantLayout({ children }: { children: React.ReactNode }) {
  return children
}
