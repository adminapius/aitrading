import type { EntryContext, RunSpec } from './simulate'

// Step 1 fine diagnosis (Apr 8..Jul 31): 20-30% was the only profitable day-gain bucket (84 trades, 48% win, +0.14R).
export const CLEAN_MOMENTUM_GAIN_RANGE = { min: 20, max: 30 }
const CLEAN_MOMENTUM_REGIMES = new Set(['opening-momentum', 'news-reaction'])

export function cleanMomentumFilter({ candidate, regime, spreadPct, entryIndex, priorEntries }: EntryContext): string | null {
  const gain = candidate.changePercent ?? -Infinity
  if (gain < CLEAN_MOMENTUM_GAIN_RANGE.min || gain >= CLEAN_MOMENTUM_GAIN_RANGE.max) return 'gain_range'
  if (entryIndex > 2) return 'max_entries'
  if (entryIndex === 2 && !priorEntries[0]?.hitTarget) return 'reentry_without_target'
  if (candidate.price < 3) return 'min_price'
  if (spreadPct > 0.5) return 'spread'
  if (!CLEAN_MOMENTUM_REGIMES.has(regime)) return 'regime'
  return null
}

const cleanMomentum = (id: string, slippageMultiplier: number, managed: boolean): RunSpec => ({
  id,
  strategy: 'A',
  slippageMultiplier,
  label: `${managed ? 'F. Clean momentum + managed exits' : 'E. Clean momentum'}${slippageMultiplier > 1 ? ` at ${slippageMultiplier}x slippage` : ''}`,
  entryFilter: cleanMomentumFilter,
  ...(managed ? { exitMode: 'managed' as const } : {}),
})

export const cleanMomentumSpecs: RunSpec[] = [1, 2, 3].flatMap((multiplier) => {
  const suffix = multiplier > 1 ? `-x${multiplier}` : ''
  return [cleanMomentum(`E${suffix}`, multiplier, false), cleanMomentum(`F${suffix}`, multiplier, true)]
})

// Rule-change candidates derived from the diagnosis period (2026-04-08..2026-07-31). Each is tested once on validation.
export const ruleVariantSpecs: RunSpec[] = [
  {
    // Diagnosis: re-entries #3+ were 234 trades, -$764 of A's -$872; first entries were roughly flat (-$7).
    id: 'R1',
    strategy: 'A',
    slippageMultiplier: 1,
    label: 'R1. A + max 2 entries per symbol per day',
    entryFilter: ({ entryIndex }) => (entryIndex > 2 ? 'max_entries' : null),
  },
  {
    // Diagnosis: $1-3 entries were 308 trades, 30% win, -$796; $3+ was -$75 on 467 trades.
    id: 'R2',
    strategy: 'A',
    slippageMultiplier: 1,
    label: 'R2. A + minimum entry price $3',
    entryFilter: ({ candidate }) => (candidate.price < 3 ? 'min_price' : null),
  },
  {
    // Diagnosis: entries after a >100% day gain were 287 trades, -$477; <50% gain was -$63 on 282 trades.
    id: 'R3',
    strategy: 'A',
    slippageMultiplier: 1,
    label: 'R3. A + skip entries already up more than 100% on the day',
    entryFilter: ({ candidate }) => ((candidate.changePercent ?? 0) > 100 ? 'overextended' : null),
  },
  { id: 'R1-x2', strategy: 'A', slippageMultiplier: 2, label: 'R1 at 2x slippage', entryFilter: ({ entryIndex }) => (entryIndex > 2 ? 'max_entries' : null) },
  { id: 'R1-x3', strategy: 'A', slippageMultiplier: 3, label: 'R1 at 3x slippage', entryFilter: ({ entryIndex }) => (entryIndex > 2 ? 'max_entries' : null) },
  ...cleanMomentumSpecs,
]
