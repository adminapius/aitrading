import type { RunSpec } from './simulate'

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
]
