# Strategy E paper run: pass rule (LOCKED, Oct 19, 2026, before any further E results)

Set by Jose on Oct 19, 2026 at about 17:40 ET. Nothing here changes during the test.

## What is tested
- Strategy E exactly as live on Alpaca paper on Oct 19, 2026 (`lib/strategies/clean-momentum.ts`: day gain 20-30%,
  price >= $3, spread <= 0.5%, opening-momentum / news-reaction regimes, max 2 entries per symbol per day; entries
  07:00-11:00 ET; flat by 15:30 ET; fresh SIP quote check from PR #83). **No filter or rule changes during the test.**
  A change to E ends the test; a new test would start from zero.
- Counted trades: every closed Strategy E round trip on Alpaca paper whose entry is on or after Oct 20, 2026 (the
  first session after this lock; all have the fresh-quote check). Each entry counts, re-entries included.
  The 12 earlier trades (Oct 9-14) are reported for information only.

## Adjustment (fill-audit gap)
- Per trade, from the fill audit (`scripts/backtest/rulebook/audit.ts`, instant mode, SP slippage model):
  gap = actual_r - model_sp_r. Adjusted R = actual R - gap when the gap is positive (paper better than the model);
  a negative gap is not credited. In short: adjusted R = min(actual_r, model_sp_r).
- A trade the audit cannot model (no model fill, missing data): adjusted R = actual R - 0.4R (top of the observed
  0.2-0.4R gap range).

## Pass rule
- Verdict at the close of the 30th counted trade, on exactly those 30 trades (no earlier or later stopping point).
- PASS only if: expectancy of adjusted R > +0.10R AND profit factor of adjusted R > 1.3
  (PF = sum of positive adjusted R / |sum of negative adjusted R|).
- No live money until E passes. Fail = E stays paper only; any change afterwards is a new strategy version with a
  new locked test.

## Weekly report (each Friday after the close)
- Jose runs the fill audit on his laptop and sends the console output and `backtests/fill-audit/audit.csv`:
  `npx tsx scripts/backtest/rulebook/audit.ts --out=backtests/fill-audit`
- Report, side by side: E (count, win %, actual R, model R, adjusted R, expectancy, PF, $) vs shadow A from
  ait_shadow_signals (its own ledger, model fills at fresh quotes; not judged), plus the fill-audit gap per trade,
  running progress toward 30, and any entry_quote_blocked events.
