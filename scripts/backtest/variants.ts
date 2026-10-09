import { cleanMomentumBlockReason } from '../../lib/strategies/clean-momentum'
import type { EntryContext, RunSpec } from './simulate'

export { CLEAN_MOMENTUM_GAIN_RANGE } from '../../lib/strategies/clean-momentum'

export function cleanMomentumFilter({ candidate, regime, spreadPct, entryIndex, priorEntries }: EntryContext): string | null {
  return cleanMomentumBlockReason({
    changePercent: candidate.changePercent,
    price: candidate.price,
    spreadPct,
    regime,
    entryIndex,
    firstEntryHitTarget: Boolean(priorEntries[0]?.hitTarget),
  })
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
