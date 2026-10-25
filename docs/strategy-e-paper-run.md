# Strategy E paper run: pass rule (LOCKED, Oct 19, 2026; RESTARTED Oct 24, 2026 with the 15:30 flatten)

## Restart (Oct 24, 2026, decided by Jose)
- Found Oct 24: live E flattened at 15:55 ET (`lib/strategy.ts` schedule window; GRML on Oct 14 closed at 15:55:48),
  not at 15:30 as Jose's standing rule and this document said.
- Root cause (corrected Oct 24 after a log and git check; the earlier "cause not found" was wrong): on Oct 14 the
  15:30 Alpaca-clock rule did not exist yet. The deployed code flattened 5 minutes before Alpaca's close
  (`FLATTEN_MINUTES_BEFORE_CLOSE = 5`, i.e. 15:55). The worker ran every 30 s from 15:30 to 15:55 with no gate
  errors and correctly did nothing. At 15:55:04 the close was refused (403, the OCO stop/target still held the
  shares) and the retry also failed; the next pass at 15:55:47 closed GRML (11 @ $6.45, -$8.36). The 30-minute rule
  and the cancel-orders-first fix were written that afternoon and merged at 16:22 ET on Oct 14 (PR #70). Since then
  no E position has been open at 15:30, so that path has not yet run live.
- Fix (PR #100): the app's own schedule flatten window now also starts at 15:30 ET (`flattenBeforeEt: '15:30'`), so every worker
  pass from 15:30 closes what is open, at Alpaca and in the ledger, without relying on Alpaca's clock (a second trigger next to PR #70's Alpaca-clock rule, so a failed Alpaca
  account check no longer delays the flatten to 15:55). Nothing else
  in E changed. Shadow A uses the same flatten, so it also closes at 15:30 from the same day.
- E had 0 counted trades (Oct 20-23: no E entries), so the locked test restarts from zero: counted trades are
  closed E round trips on Alpaca paper entered on or after the first session after this fix is deployed
  (expected Monday, Oct 26, 2026; merged only inside the merge window). Everything else below is unchanged.
- Safety fixes (Oct 24, 2026, Jose's go; guardrails only, not strategy changes, so the count is NOT restarted again
  and still starts Monday, Oct 26):
  - Daily loss limit fails closed: if the day's starting equity is missing (or cannot be loaded), live entries are
    blocked and an ENTRY_BLOCKED event is logged. Before, a missing starting equity silently allowed trading.
  - Max 3 positions counts E entry orders still pending at Alpaca, so a late fill cannot make a 4th position.
  - E's entry rules, sizing, stop, target and the 15:30 flatten are unchanged.
- Survivorship note (Oct 24, 2026, information only; E's paper rules unchanged): **every earlier E replay was
  survivorship-biased on float.** The replay lets a stock be entered only when it has a float value, and all its
  float sources list only companies that trade today: delisted stocks could never be entered, and live stocks used
  today's float rather than the float on the trade date (point-in-time history only from about late 2023). This
  applies to the backtests behind E's filters and to both E-J runs. The out-of-sample read on E with point-in-time
  EDGAR float (delisted included) was planned as D12 in docs/strategy-ej-310-spec.md; that test is parked
  (Oct 24, 2026), so there is no clean out-of-sample read on E.
- Universe gap (Oct 24, 2026, from the E-J $3-10 probe; information only; E's paper rules unchanged): **the
  backtest universe (Alpaca's asset list as it is today, active + inactive) is missing about 99% of delistings
  after Oct 2022** (by FMP's delisted list, which also counts preferreds, units and warrants: 21 of 2,528 present
  for Oct 2022 - Oct 2024; 259 of 774 for Oct 2021 - Oct 2022). Every earlier backtest built its universe from
  that list: E's replays, E-J, SW, H v2 and F. E and E-J also carry the float bias above (SW, H v2 and F have no
  float gate). Jose's reading, recorded as such: these biases are expected to run in the optimistic direction
  (stocks that later delisted are left out), so the FAIL verdicts of E-J, SW, H v2 and F stand, and E-current's
  tuning result is an upper bound. The direction is expected, not measured. Details and fixes:
  docs/backtest-known-issues.md.


Set by Jose on Oct 19, 2026 at about 17:40 ET. Nothing here changes during the test.
The three details (SP model for the gap, flat -0.4R for unmodelable trades, verdict at exactly the 30th counted
trade) were approved by Jose at 17:47 ET. Rule fully locked; no changes until the verdict.

## What is tested
- Strategy E exactly as live on Alpaca paper on Oct 19, 2026 (`lib/strategies/clean-momentum.ts`: day gain 20-30%,
  price >= $3, spread <= 0.5%, opening-momentum / news-reaction regimes, max 2 entries per symbol per day; entries
  07:00-11:00 ET; flat by 15:30 ET (from the Oct 24 fix; it was 15:55 before); fresh SIP quote check from PR #83).
  **No filter or rule changes during the test.**
  A change to E ends the test; a new test would start from zero.
- Counted trades: every closed Strategy E round trip on Alpaca paper whose entry is on or after the first session
  after the 15:30 fix is deployed (see Restart). Each entry counts, re-entries included.
  The 12 earlier trades (Oct 9-14) are reported for information only; Oct 20-23 had no E entries.

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

## Secondary verdict: E 09:45-11:00 subset (LOCKED Oct 25, 2026, before any counted trade; Jose)
- **E's rules are unchanged.** This is a second reading of the same counted trades, evidence for a possible future
  rule change; it does not change E, its main verdict, or what E trades.
- Subset: the counted E trades (entered on or after Mon Oct 26, 2026; see Restart) whose **entry fill** time is
  09:45:00-10:59:59 ET (Alpaca fill timestamp, ET).
- Verdict at exactly the subset's 30th trade, on exactly those 30 trades, with the same rule as the main verdict:
  adjusted R = min(paper R, model R) from the fill audit (an unmodelable trade: paper R - 0.4R); PASS only if
  expectancy of adjusted R > +0.10R AND PF of adjusted R > 1.3.
- The subset keeps counting after the main verdict at trade 30 for as long as E runs unchanged on paper; any change
  to E ends both counts.
- Why, recorded honestly: in the E-J tuning replay (Oct 14, 2024 - Jul 31, 2026), all of E-current's losses came
  from entries filled before 09:45 (18 trades, -7.7R, -$110.97, win 28%) while entries filled 09:45-11:00 made money
  (35 trades, +3.9R, +$75.42, win 43%, PF 1.25). That split was found **after** seeing the results, so it is a
  hypothesis and needs unseen trades.
- Information only, read Oct 25 from the locked E-J holdout (`backtests/strategy-ej/holdout/trades.csv`, nothing
  rerun; split by entry fill time): E-current (flat 15:55) before 09:45: 6 trades, +2.0R, +$29.32, win 50%;
  09:45-11:00: 6 trades, -3.3R, -$65.23, win 17%; after 11:00: 1 trade (ARTL, decided at 10:55, first bar and fill
  11:14), +4.0R, +$79.38. E-J on the same entries: +4.6R / -1.6R / +6.1R. **The holdout points the other way**, on
  6 trades a side; with this few trades neither window settles it, which is why the paper subset is judged on 30.

## Weekly report (each Friday after the close)
- Jose runs the fill audit on his laptop and sends the console output and `backtests/fill-audit/audit.csv`:
  `npx tsx scripts/backtest/rulebook/audit.ts --out=backtests/fill-audit`
- Report, side by side: E (count, win %, actual R, model R, adjusted R, expectancy, PF, $) vs shadow A from
  ait_shadow_signals (its own ledger, model fills at fresh quotes; not judged), plus the fill-audit gap per trade,
  running progress toward 30, and any entry_quote_blocked events.
- Time-of-day split (added Oct 25, 2026): E's and shadow A's counted trades split by entry fill time into before
  09:45, 09:45-11:00 and after 11:00 ET, with trades, R (E: actual, model and adjusted), $ and win % for each, week
  and all time; plus the 09:45-11:00 subset's progress toward its own 30 trades (see the secondary verdict).
