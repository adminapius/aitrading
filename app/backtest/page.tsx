import type { Metadata } from 'next'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Link from 'next/link'
import { BacktestReport, type BacktestSummary } from '@/components/backtest/backtest-report'

export const metadata: Metadata = {
  title: 'Backtest 2026-04 → 2026-10 — AItrading',
  description: 'Read-only results of the offline 6-month paper strategy backtest.',
}

async function loadSummary(): Promise<BacktestSummary | null> {
  try {
    const raw = await readFile(join(process.cwd(), 'backtests/2026-10-6m/summary.json'), 'utf8')
    return JSON.parse(raw) as BacktestSummary
  } catch {
    return null
  }
}

export default async function BacktestPage() {
  const summary = await loadSummary()
  return (
    <main className="min-h-dvh bg-background font-mono text-foreground">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Offline backtest · read-only</p>
          <h1 className="text-xl font-semibold text-balance">6-month strategy replay</h1>
        </div>
        <Link href="/" className="text-sm text-primary hover:underline">Back to monitor</Link>
      </header>
      {summary ? (
        <BacktestReport summary={summary} />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">
          No results yet. Run <code className="text-foreground">pnpm exec tsx scripts/backtest/run.ts</code> to generate backtests/2026-10-6m/summary.json.
        </p>
      )}
    </main>
  )
}
