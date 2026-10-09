// Strategy E ("clean momentum"): Strategy A's entry decision plus the filters below.
// This module is the single source of truth for both the live worker and scripts/backtest.

// Step 1 fine diagnosis (Apr 8..Jul 31): 20-30% was the only profitable day-gain bucket (84 trades, 48% win, +0.14R).
export const CLEAN_MOMENTUM_GAIN_RANGE = { min: 20, max: 30 } as const
export const CLEAN_MOMENTUM_MAX_ENTRIES_PER_SYMBOL_DAY = 2
export const CLEAN_MOMENTUM_MIN_PRICE = 3
export const CLEAN_MOMENTUM_MAX_SPREAD_PCT = 0.5
export const CLEAN_MOMENTUM_REGIMES: ReadonlySet<string> = new Set(['opening-momentum', 'news-reaction'])

export type CleanMomentumBlock = 'gain_range' | 'max_entries' | 'reentry_without_target' | 'min_price' | 'spread' | 'regime'

export type CleanMomentumInput = {
  /** Day gain (%) of the scan candidate at decision time. */
  changePercent: number | null | undefined
  /** Scan candidate price (not the executable ask). */
  price: number
  /** Executable quote spread as a percent of mid: (ask - bid) / mid * 100. */
  spreadPct: number
  regime: string
  /** 1 for the first entry in this symbol today, 2 for the second, ... */
  entryIndex: number
  /** Whether the first entry in this symbol today reached its profit target. */
  firstEntryHitTarget: boolean
}

export function cleanMomentumBlockReason(input: CleanMomentumInput): CleanMomentumBlock | null {
  const gain = input.changePercent ?? -Infinity
  if (gain < CLEAN_MOMENTUM_GAIN_RANGE.min || gain >= CLEAN_MOMENTUM_GAIN_RANGE.max) return 'gain_range'
  if (input.entryIndex > CLEAN_MOMENTUM_MAX_ENTRIES_PER_SYMBOL_DAY) return 'max_entries'
  if (input.entryIndex === 2 && !input.firstEntryHitTarget) return 'reentry_without_target'
  if (input.price < CLEAN_MOMENTUM_MIN_PRICE) return 'min_price'
  if (input.spreadPct > CLEAN_MOMENTUM_MAX_SPREAD_PCT) return 'spread'
  if (!CLEAN_MOMENTUM_REGIMES.has(input.regime)) return 'regime'
  return null
}

export const cleanMomentumRuleSummary = `day gain ${CLEAN_MOMENTUM_GAIN_RANGE.min}-${CLEAN_MOMENTUM_GAIN_RANGE.max}%, max ${CLEAN_MOMENTUM_MAX_ENTRIES_PER_SYMBOL_DAY} entries/symbol/day (2nd only after a target hit), price >= $${CLEAN_MOMENTUM_MIN_PRICE}, spread <= ${CLEAN_MOMENTUM_MAX_SPREAD_PCT}%, regimes ${[...CLEAN_MOMENTUM_REGIMES].join('/')}`
