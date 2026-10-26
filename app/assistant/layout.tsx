import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Assistant — manual trades (no orders)',
  description: 'Scanner, alerts, risk calculator, limits and journal for manual trades. It never places orders.',
  robots: { index: false, follow: false },
}

export default function AssistantLayout({ children }: { children: React.ReactNode }) {
  return children
}
