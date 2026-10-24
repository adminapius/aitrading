# Strategy E-J: Strategy E entries + Jose's scale-out and add engine (DRAFT, Oct 24, 2026; not locked)

BACKTEST ONLY. Live Strategy E stays unchanged during this test (its locked paper run continues). Rules as Jose
wrote them; items marked **[D#]** are open decisions (section 9) with a proposed default. No code until approved.

## 0. Found while writing this spec
- **Live E flattens at 15:55 ET, not 15:30.** `lib/strategy.ts` has `flattenBeforeEt: '15:55'`, and the Oct 14
  GRML trade was closed at 15:55:48 ET. Jose's standing rule is flat by 15:30. Live E is not changed here; the
  baseline question is **[D1]**.

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

## 9. Open decisions (proposed defaults in bold)
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
- **D17 Data:** **probe the download size first (a probe that simulates no trades), then lock.**
