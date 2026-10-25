# Strategy E-J: Strategy E entries + Jose's scale-out and add engine (LOCKED Oct 24, 2026; holdout FAIL; PARKED)

BACKTEST ONLY. Live Strategy E stays unchanged during this test (its locked paper run continues). Rules as Jose
wrote them; items marked **[D#]** are Jose's approved decisions (section 9: D1, D3-D14, D17 approved as proposed,
Oct 24, 2026). Locked before any result. Code: `scripts/backtest/strategy-ej.ts`, `scripts/backtest/ej-engine.ts`,
tests in `tests/strategy-ej.test.mjs`. Each window runs once (lock file); nothing changes after a run.

## 0. Found while writing this spec
- **Live E flattens at 15:55 ET, not 15:30.** `lib/strategy.ts` has `flattenBeforeEt: '15:55'`, and the Oct 14
  GRML trade was closed at 15:55:48 ET. Jose's standing rule is flat by 15:30. Live E is fixed separately
  (PR #100, `docs/strategy-e-paper-run.md`); this backtest keeps E-current at 15:55 as the baseline per **[D1]**,
  with a 15:30 information line.

## 1. Entries: exactly Strategy E's current rules
- Reuse the existing replay engine (`scripts/backtest/simulate.ts` + `market.ts`), which imports the live
  `decideEntry`, `scoreCandidate`, `strategyRegime`, guardrails and the clean-momentum filter unchanged:
  - Strategy A's gates (news catalyst, relative volume, volume, dollar volume, float <= 10M, price above VWAP,
    spread, ATR) plus E's filters: day gain 20-30%, price >= $3, spread <= 0.5%, opening-momentum or
    news-reaction regime, max 2 entries per stock per day (2nd only if the 1st reached its target).
  - Ranking: the live candidate order as the replay rebuilds it (top-25 gainers from minute bars, then E's score).
- Scan times: every 15 minutes 7:00-8:00 (7:00, 7:15, 7:30, 7:45), every 5 minutes from 8:00. Signals count
  only at those times, on closed bars; fills on later bars.
  Note: E's regimes allow entries only 7:00-7:59 (news-reaction, half size) and 9:30-10:59 (opening-momentum).
  8:00-9:29 is "premarket-continuation", which E does not trade, so the 5-minute scans matter from 9:30.
- Up to 3 positions at once (E's guardrail), filled in rank order at each scan; a slot frees when the whole trade
  is flat. **[D3]**
- Size and initial stop exactly as E: risk 1% of equity x the regime's size fraction (0.5 before 8:00), notional
  at most 25% of equity x size fraction, simulated 2x margin buying power, $2,000 start compounding, 4% daily loss
  limit. Initial stop = fill - 1 daily ATR(14) (E's bracket stop). E's target (fill + 1.5 ATR) is used by
  E-current only.

## 2. Exit and add engine (E-J)
1. Scale-out 1: at fill + $0.50, sell 1/3. Stop on the rest -> breakeven (the entry fill).
2. Scale-out 2: at fill + $1.00, sell another 1/3.
3. Runner (last 1/3): exits at the first 5-minute close below VWAP, or at 15:30. **[D10]**
4. Add on continuation, only after scale-out 2: a new high above fill + $1.00, price above VWAP, 5-minute RVOL
   above its average -> buy 1/3 of the original size. **[D11] [D12]**
   - The add: 1/2 sells at add price + $0.50; the rest exits with the runner.
   - The add's stop: the higher of (add price - $0.50) and VWAP at the add. **[D14]**
   - At most 2 adds per trade. Total open risk never above the original 1R. **[D13]**
5. If scale-out 1 is never reached: the whole position keeps E's initial stop (until 15:30).
6. Everything flat by 15:30.
- Share rounding **[D8]**: thirds = floor(N/3) for each scale-out, the runner gets the rest; with N < 3, each
  scale-out sells 1 share while shares remain.
- R for an E-J trade = total P&L of the trade (adds included) / initial risk (shares x (fill - initial stop)).

## 3. Runs (same entries) **[D5]**
- E-current: E's exits as they are today (bracket: stop fill - 1 ATR, target fill + 1.5 ATR, full exit; flatten at
  the time decided in D1).
- E-J: section 2.
- E-J without adds.
- Splits for every run: entry price $3-5, $5-10, $10+.

## 4. Costs and fills **[D6]**
- SP slippage on market-type fills: 0.5% (1% before 9:30) on entries, stops (touch -> stop - slippage; open through
  the stop -> open - slippage), the runner's VWAP exit, 15:30 and flatten (next 1-minute bar's open).
- Scale-outs are resting limits: filled at the level when a bar trades 1 tick through it, no slippage.
- Worst case inside one bar: a bar that touches both a stop and a scale-out counts as the stop; the entry bar
  checks the stop only.
- SEC fee and FINRA TAF on sells; volume caps: 1% of the day's volume so far, no fill above 10% of the bar.
- 1-minute SIP bars; signals on closed bars, fills on later bars.

## 5. Windows
- Tuning Oct 14, 2024 - Jul 31, 2026, run once; holdout Aug 1 - Oct 16, 2026, run once. Nothing changes after a run.
- Overlap, stated: E's filters were derived from Apr 8 - Jul 31, 2026 (inside tuning) and E was checked on
  Aug-Oct 2026 earlier (inside this holdout). The test compares exits on the same entries, so both runs share the
  overlap, but the holdout is not fresh for E's entries.

## 6. Report (per window, per run)
Trades, win %, average win and loss, expectancy, PF, max drawdown, largest loss, R and $; scale-out hit rates
(share of trades reaching +$0.50 and +$1.00); adds fired, their count per trade and their own P&L; the price-band
split; by month; exits by type.

## 7. Pass rule (locked as written by Jose)
In the holdout: E-J beats E-current in total R AND in total dollars, with E-J expectancy > +0.1R, PF > 1.3,
at least 30 trades, positive dollars. A pass -> E-J replaces E on Alpaca paper and starts a fresh 30-trade locked test.

## 8. Data
The replay was built for Apr-Oct 2026; this test extends it to Oct 2024 - Oct 2026 (minute bars for each day's
gainer pool, Alpaca news, historical NBBO quotes at decisions, point-in-time float). **[D17]**

## 9. Decisions (approved by Jose as proposed, Oct 24, 2026)
- **D1 Flatten time for the baseline:** **E-current flattens at 15:55 as live does**, plus an information line
  with E-current flattened at 15:30, so the effect of the time alone is visible.
- **D3 Slots:** **a slot frees only when the whole trade (runner and adds included) is flat.**
- **D4 E's re-entry rule ("2nd entry only if the 1st reached its target"):** **"reached its target" = the price
  touched fill + 1.5 ATR while the first trade was open, in every run**, so the rule does not depend on the exits.
- **D5 Same entries:** exits change when slots free up, so independent runs would take different entries.
  **The entry list is fixed by the E-current run (its slots, re-entries and sizes), and E-J and E-J-no-adds
  manage exactly those entries.** An information line also runs E-J with its own slot timing.
- **D6 Fills:** **as in section 4.**
- **D7 E-current in this test:** **E's live bracket (stop and 1.5 ATR target) with the same SP cost model as E-J**
  (the old replay used a spread-based slippage; all three runs use one cost model here).
- **D8 Share rounding:** **as in section 2.**
- **D9 VWAP:** **session VWAP from 4:00 ET (premarket included), the same VWAP E's entry gate uses in the replay.**
- **D10 Runner exit:** **the VWAP exit applies to the runner only (after scale-out 2): a 5-minute bar (clock grid)
  closing below VWAP -> exit at the next 1-minute bar's open.** Before scale-out 2 the shares keep their stop
  (initial, or breakeven after scale-out 1) and the 15:30 exit.
- **D11 5-minute RVOL "above its average":** **the just-closed 5-minute bar's volume is above the average of the
  previous 12 five-minute bars (1 hour).** Alternative: the same 5 minutes over the prior 20 sessions.
- **D12 Add trigger:** **checked at each 1-minute close after scale-out 2: that bar makes a new high since entry
  above fill + $1.00, closes above VWAP, and D11 holds; buy at the next bar's open + slippage. A 2nd add needs a
  new high above the high at the 1st add. No adds after 15:00.**
- **D13 Risk cap:** open risk = sum over open lots of shares x (lot fill - lot stop), floored at 0. **An add is
  cut to the size that keeps open risk at or below the original 1R (skipped if under 1 share).**
- **D14 Add stop:** **fixed at the add: the higher of (add price - $0.50) and VWAP at that moment.**
- **D17 Data:** **probe the download size first (a probe that simulates no trades), then lock.** Jose said on
  Oct 24 to lock and build together; the probe (`--probe`) is run before the tuning window and changes nothing.

## 10. Implementation notes (locked with the spec)
- The E-current portfolio run uses the replay's entry path: live `decideEntry` before the quote and again at the
  ask, the historical NBBO quote at the scan time (stale or off-price -> no entry), the scanner spread / dollar
  volume check at the quote, `cleanMomentumBlockReason` with D4's touch rule, the re-entry cooldown, 3 slots, 4%
  daily loss limit, exposure headroom and simulated 2x margin; equity compounds from $2,000 day to day.
- Fill = the open of the first 1-minute bar starting at or after the scan time + slippage; size = E's shares cut
  to cash headroom and 1% of the day's volume so far; skipped if over 10% of the fill bar's volume.
- Initial stop = fill - daily ATR(14) (measured from the fill, as E's bracket). E's target is touched only on
  bars after the fill bar and needs a 1-tick trade-through; it fills at max(target, bar open).
- Order inside a bar: the 15:30 / 15:55 flat at the bar's open; a pending runner exit at the open; a pending add
  bought at the open; stops (gap -> open - slippage, touch -> stop - slippage); then scale-outs / the add's +$0.50
  half (trade-through, at max(level, open)); at the close the runner check (5-minute clock grid) and, if it did
  not fire, the add trigger. The add's own stop is checked on its fill bar.
- When the runner exits (VWAP or 15:30), any open add shares exit with it at the same price.
- Adds are also capped by the volume rules. A trade that is still open on the last bar of the day exits at that
  bar's close (data gap guard).
- E-current at 15:30, E-J and E-J without adds use the entry list of the E-current run (D5); E-J with its own
  slot timing is a separate portfolio run, information only.
- Output per window: `trades.csv` (every run, every fill), `summary.json`, `RUN-LOCK.json`; the holdout needs
  the tuning lock.

## 11. Results (recorded Oct 24, 2026; nothing rerun)

**Verdict: FAIL. E-J is parked.** The holdout ran once (Oct 24, 2026, 14:43 PT; `backtests/strategy-ej/holdout/`,
locked). It fails one condition of the section 7 pass rule: **13 trades vs at least 30 required**. Every other
condition passed. E-J does not replace E; E's locked paper test continues unchanged.

### Holdout Aug 1 - Oct 16, 2026 (54 trading days), same 13 entries (fixed by E-current, D5)

| Run | Trades | Win | Avg win / loss | Expectancy | PF | Max DD | Largest loss | Total |
|---|---|---|---|---|---|---|---|---|
| E-current (flat 15:55) | 13 | 38% | 1.71R / -0.74R | 0.20R | 1.45 | 3.5R / $43 | -1.11R | 2.7R / $43.48 |
| E-current flat 15:30 (info) | 13 | 38% | 1.73R / -0.60R | 0.29R | 1.79 | 3.5R / $43 | -1.11R | 3.8R / $70.11 |
| **E-J** | 13 | 54% | 1.91R / -0.71R | **0.70R** | **3.16** | 3.2R / $40 | -1.11R | **9.2R / $196.73** |
| E-J without adds | 13 | 54% | 1.81R / -0.71R | 0.65R | 2.98 | 3.2R / $40 | -1.11R | 8.4R / $176.92 |
| E-J own slots (info) | 13 | 54% | 1.89R / -0.71R | 0.69R | 3.12 | 3.2R / $45 | -1.11R | 9.0R / $197.83 |

Pass rule (holdout): E-J total R 9.2 > E-current 2.7 ok; E-J $196.73 > E-current $43.48 ok; expectancy 0.70R >
+0.10R ok; PF 3.16 > 1.3 ok; **trades 13 >= 30 FAIL**; dollars $196.73 > 0 ok -> **FAIL**.

Price bands:

| Band | E-current | E-J | E-J without adds |
|---|---|---|---|
| $3-5 | 3 trades, 0.3R / $16.63, exp 0.10R, PF 1.26 | 3 trades, 4.9R / $106.77, exp 1.63R, PF 5.16 | 3 trades, 4.5R / $98.69, exp 1.49R, PF 4.81 |
| $5-10 | 6 trades, 1.2R / $38.78, exp 0.20R, PF 1.41 | 6 trades, 4.6R / $103.76, exp 0.77R, PF 3.30 | 6 trades, 3.9R / $88.63, exp 0.66R, PF 2.96 |
| $10+ | 4 trades, 1.1R / -$11.93, exp 0.29R, PF 1.64 | 4 trades, -0.4R / -$13.80, exp -0.09R, PF 0.66 | 4 trades, -0.0R / -$10.41, exp -0.00R, PF 1.00 |

- Hit rates (all runs, same entries): +$0.50 reached 46% (E-J) / 38% (E-current); +$1.00 31%; E target (+1.5 ATR) 23%.
- E-J: scale-out 1 filled 6, scale-out 2 filled 4; adds fired on 4 trades (7 adds), add P&L $19.81 (about 10% of
  E-J's dollars; E-J without adds keeps most of the gain).
- Final exits. E-current: flatten 15:55 7 (-1.1R), target 3 (7.0R), stop 3 (-3.2R). E-J: flat 15:30 5 (5.5R), stop 3
  (-3.2R), breakeven stop 2 (0.1R), runner 5-min close below VWAP 2 (6.7R), scale-out 1 1 (0.1R).
- By month ($). E-current: Aug 4 trades 0.3R / -$14, Sep 5 / 5.8R / $100, Oct 4 / -3.5R / -$43 (1 of 3 positive).
  E-J: Aug 4 / 0.6R / $10, Sep 5 / 11.7R / $227, Oct 4 / -3.2R / -$40 (2 of 3 positive).
- Entry blocks (E-current run): gain_range 1271, spread / dollar volume at the quote 440, min_price 81, no
  executable quote 44, regime 22, cooldown 20, spread 15, reentry_without_target 8, fill below stop 1.
- Overlap reminder (section 5): the holdout is not fresh for E's entries, only for the exit comparison.

### Time-of-day split (information only, read Oct 25, 2026 from the locked trades.csv files; nothing rerun)
By entry fill time (ET). Tuning has no fills after 11:00.

| Window | Run | before 09:45 | 09:45-11:00 | after 11:00 |
|---|---|---|---|---|
| tuning | E-current | 18 tr, -7.7R, -$110.97, win 28%, PF 0.44 | 35 tr, +3.9R, +$75.42, win 43%, PF 1.25 | 0 |
| tuning | E-J | 18 tr, -10.4R, -$141.43, win 39%, PF 0.11 | 35 tr, +5.1R, +$99.67, win 60%, PF 1.40 | 0 |
| holdout | E-current | 6 tr, +2.0R, +$29.32, win 50%, PF 1.84 | 6 tr, -3.3R, -$65.23, win 17%, PF 0.05 | 1 tr (ARTL, fill 11:14), +4.0R, +$79.38 |
| holdout | E-J | 6 tr, +4.6R, +$105.64, win 67%, PF 3.18 | 6 tr, -1.6R, -$31.05, win 33%, PF 0.26 | 1 tr, +6.1R, +$122.13 |

The tuning split was found after the results; the holdout goes the other way on 6 trades a side. It is judged on
unseen paper trades (docs/strategy-e-paper-run.md, secondary verdict), not here.

### 08:00 ET finding (checked before the verdict was read; no code bug)
- In tuning, 4 news-regime trades exit at exactly 08:00: WOLF 2024-10-15, TNON 2024-10-31, DGNX 2025-10-09,
  BIAF 2026-03-25 (E-current: DGNX and BIAF stops; E-J: all four, WOLF and TNON at breakeven after scale-outs).
- The 08:00 bars are real: 8-60x the 07:59 volume, 666-18,411 trades in the minute, 12-388 trades at or below the
  level, normal sizes. The trades print on exchange D (FINRA TRF, off-exchange), conditions T (extended hours) and
  I (odd lot): the retail orders queued for the 08:00 premarket open, filled at once. Price swings both ways for
  about 12 seconds after 08:00:00 and recovers (e.g. WOLF low 12.20, 08:00 close 15.10; DGNX low 34.20, close 39.40).
- The exit prices follow the rules exactly: stop touch -> stop - 1% (DGNX, BIAF); open through breakeven ->
  open - 1% (WOLF, TNON; the opens 13.45 / 4.09 were real prints).
- Stops were checked on every 1-minute bar from the fill; none of the four reached its level before 08:00. Fill
  timing confirmed: a scan at minute X sees only bars closed by X (start <= X-1); the fill is bar X's open.
- The backtest assumes the worst case: a stop fires on any touch of the bar's low. Live E checks the bid every
  15 seconds before the open and sends an extended-hours limit at bid - 0.5%, so live it can sell near the low or
  miss the 12-second flush. No rule changes from this; E's 08:00 exits are tagged in the weekly paper report.

### Status
- **E-J is parked.** Live Strategy E is unchanged. Any follow-up is a new, separately locked spec.
