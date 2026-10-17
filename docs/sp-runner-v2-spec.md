# SP-Runner v2: buying/selling-pressure trade management (LOCKED SPEC)

Approved by Jose on Oct 16, 2026 (21:04 PT), before any v2 result existed. Every number below is locked.
Run the tuning window once, then the holdout window once. Nothing changes after a result is seen.
BACKTEST ONLY. Code: `scripts/backtest/rulebook/runner-v2.ts`.

## 1. Entries: identical to Step 2b
- Same scanner, filters and news check; the stock is in the SP scanner top 3 at some minute 7:00-8:30.
- Same signal: a 1-min close back above VWAP between 8:30 and 9:00, after a pullback (last 10 bars) that touched VWAP and held the premarket base (lowest low 7:00-8:29).
- Same fill model: the first 1-min bar (from the next minute, valid 5 minutes) trading through the trigger fills at max(trigger, open) + slippage; no fill above trigger + 0.5%.
- One trade per day (earliest signal, ties by ticker), $2,000 starting equity, compounding.
- Every v2 trade is matched to its Step 2b trade by date and ticker. Only the share count can differ, because the stop is different.

## 2. Pressure, computed at each 1-min bar close
- signed volume = volume × ((close − low) − (high − close)) ÷ (high − low); 0 when high = low.
- P5 = sum of the last 5 minutes, P15 = sum of the last 15 minutes. A minute with no bar counts as 0.
- Selling volume = sum of the negative signed volumes only (as a positive number).

## 3. Stop and size
- Initial stop = min(premarket base low, VWAP at the signal bar) − 0.25 × 5-min ATR(14) at the signal.
  If that is more than 15% below the fill, the stop is fill × 0.85 (the trade is not skipped).
- Risk per trade = 0.5% of equity (same as Step 2b). Shares = risk ÷ (fill − stop), then the usual caps:
  100% of equity, 1% of day volume so far, no fill above 10% of the bar's volume, at least 0.5R left after caps.
- 1R = the initial dollar risk (shares × (fill − initial stop)). All R results use it.
- Pivot low: a 1-min bar whose low is lower than the 3 bars before and the 3 bars after it (confirmed 3 bars later; bars in sequence, a minute with no trade has no bar).
- Higher low: a confirmed pivot low above the previous confirmed pivot low, both formed after the entry bar.
- When a higher low is confirmed, the stop moves up to (that higher low − 0.25 × current 5-min ATR), only if that is above the current stop. It never moves down.
- Stop fills: bar opens at/below the stop → open − slippage; low touches the stop → stop − slippage. On the fill bar the stop counts only if the bar closes at/below it.

## 4. Add (once only)
- Signal on a 1-min bar closing 9:30-9:44: P5 > 0 and the close is above the premarket high (4:00-9:29).
- One add order only: trigger = that close, same fill model as the entry (from the next bar, 5 minutes, limit + 0.5%).
- Add shares = (1R − current open risk) ÷ (add fill − current stop), where open risk = shares × (average cost − current stop).
  No add if that is under 1 share. Same caps (100% of equity in total, 1% of day volume, 10% of the bar).
- So an add is only possible after a higher low has lifted the stop (decision 3). Total risk never above 1R.

## 5. Exits: whichever comes first
- Pressure exit (the only signal exit), all three on the same 1-min bar close:
  P5 < 0; selling volume over the last 5 minutes > over the 5 minutes before; the close is below the last higher low.
  Fills at the next bar's open − slippage. (No higher low yet → this exit cannot fire.)
- The stop (initial or raised).
- 15:30 backstop: the 15:30 bar's open − slippage.
- The hold conditions (P15 > 0, above VWAP, rising lows) describe a healthy trade; they are not exit rules (decision 1).

## 6. Costs and windows
- Slippage 0.5%, 1% before 9:30; SEC fee $20.60/M on sells; FINRA TAF $0.000195/share (max $9.79); volume caps as above. Signals on closed bars only.
- Tuning: Oct 14, 2024 - Jul 31, 2026, run once. Holdout: Aug 1 - Oct 13, 2026, run once. Each window starts at $2,000.
- The script refuses to run a window a second time (lock file in the output folder).

## 7. Report
- Usual stats for v2 beside Step 2b on the same window (trades, win %, average win/loss, expectancy, PF, max drawdown).
- Trade-by-trade comparison CSV (date, ticker, Step 2b R, v2 R, exits, times).
- Trades held past 9:30: count, total and average R. Trades exited before 9:30: count and average R.
- Exit times in 15-minute buckets, plus 10:35-10:45 on its own line.
- Results by calendar month.
- "No add" version, everything else the same.
- Attribution ladder (report only, same locked numbers): Step 2b → v2 stop (with the 2b +20% target and 11:30 exit) → v2 exits (no add) → full v2. The change at each step is that part's contribution.

## 8. Pass rule (holdout, v2 full)
- At least 25 holdout trades, positive expectancy after costs, PF above 1.5.

## Decisions (Jose, Oct 16, 2026)
1. The exit trio is the only signal exit; the hold conditions just describe a healthy trade.
2. The raised stop sits at the last higher low − 0.25 ATR, so the trio fires first and the stop is the safety net.
3. An add can only happen after a higher low has lifted the stop; total risk capped at 1R.
4. Minimum 25 holdout trades, locked before any results.
