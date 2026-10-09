export type StrategyOutcome = { r: number | null; pnl: number }

export type StrategyComparisonMetric = {
  trades: number
  winRate: number | null
  averageR: number | null
  totalPnl: number
}

export function summarizeOutcomes(outcomes: StrategyOutcome[]): StrategyComparisonMetric {
  const rValues = outcomes.map((outcome) => outcome.r).filter((r): r is number => r != null && Number.isFinite(r))
  return {
    trades: outcomes.length,
    winRate: outcomes.length ? outcomes.filter((outcome) => outcome.pnl > 0).length / outcomes.length : null,
    averageR: rValues.length ? rValues.reduce((sum, r) => sum + r, 0) / rValues.length : null,
    totalPnl: Math.round(outcomes.reduce((sum, outcome) => sum + outcome.pnl, 0) * 100) / 100,
  }
}

/** UTC instant for 00:00 America/New_York on the given YYYY-MM-DD (DST-aware). */
export function easternMidnight(date: string) {
  const guess = new Date(`${date}T05:00:00Z`)
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(guess).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-5'
  const hours = Number(offset.replace('GMT', '') || 0)
  return new Date(Date.parse(`${date}T00:00:00Z`) - hours * 3_600_000)
}
