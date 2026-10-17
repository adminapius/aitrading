# Order-flow diagnostic, Step A (approved by Jose Oct 16, 2026; reading rule pending his approval)

Diagnostic only. No trading rules, no strategy is built from this unless Step A shows a clear separation.
Code: `scripts/backtest/rulebook/orderflow.ts`.

## Data
- The 174 Step 2b setups (one stock per day), Oct 14, 2024 - Oct 13, 2026.
- SIP trades and SIP quotes, 7:00-11:30 ET, for that stock on that day.
- Raw ticks are not stored; only per-minute buy / sell / unclassified volume is cached per day.

## Classification (every trade, in time order)
- Quote = the latest SIP quote (bid > 0, ask >= bid) at or before the trade.
- Price at or above the ask = buy; at or below the bid = sell; in between = tick rule (up-tick buy, down-tick sell,
  same price = the last direction; no direction yet = unclassified).
- Excluded: odd lots (< 100 shares) and prints with these SIP conditions: I W Z U 4 7 9 C N R P V M Q O 6 H B G L.
  Extended-hours (T) and ISO (F) prints are kept.

## Measures (from the scanner catch = first minute 7:00-8:30 the stock was in the SP top 3)
- Cumulative delta = buys − sells. 1-minute delta. Delta over the last 5 minutes.
- At entry = through the close of the signal bar (closed bars only).
- Cumulative delta is reported as a share of the classified volume since the catch (primary, comparable across
  stocks of different size) and in raw shares.

## Report
1. Cumulative delta at entry in 5 equal groups, against Step 2b R, win % and MFE.
2. The same for delta over the 5 minutes before entry.
3. Big red 1-minute bars (delta ≤ −50% of that minute's volume and volume ≥ 3× the median minute since the catch,
   catch to 11:00): price change over the next 15 and 30 minutes, against all minutes as the baseline.
4. Setups still open at 9:30: does a 5-minute delta flip (positive to negative) come before the 9:30-11:30 high,
   how long before, and how many earlier flips were false alarms.

## Reading rule (proposed by Claude, to be locked by Jose before --all is run)
Clear separation means, for report 1 (primary) or report 2:
- the top group's average R is positive, and
- it is at least 0.5R better than the bottom group's, and
- average R rises in at least 3 of the 4 steps from the bottom group to the top.
With about 35 setups per group the noise on a group's average is about ±0.2R, so a smaller gap is not readable.
Report 3 counts only if big red bars are followed by a 30-minute median at least 2 percentage points below the
baseline, and lower in at least 60% of cases. Report 4 is information only.
If nothing meets this, the idea ends. No fitting, no re-cuts after the result.

## Step B (only if Step A meets the rule)
A locked spec with a delta entry filter and a delta exit, sent for approval. All 174 days have been seen, so the
only real test is forward paper trading, about 30 trades, same pass rule (positive expectancy, PF above 1.5).
