# H v2 - daily swing, course rules (LOCKED SPEC)

Approved by Jose on Oct 19, 2026 (10:03 PT), before any H v2 result existed. Every number below is locked.
Run the tuning window once, then the holdout window once. Nothing changes after a result is seen. BACKTEST ONLY.
Code: `scripts/backtest/rulebook/swing-v2.ts`. H v1 (`swing.ts`) is unchanged and runs beside it as the reference.

H v1 already used the holdout window, so a pass here goes to forward paper trading (about 30 trades) before any live money.

## 1. Kept from H v1
- Split-adjusted daily bars; universe NYSE/NASDAQ/AMEX common stocks, price >= $5, 20-day average volume >= 1M (raw bars, that day).
- N = 20-day ATR (Wilder). Initial stop 2N (Entry B: see 4).
- Protective level each day = max(stop, prior 10-day low): touch -> fill at the level; open below it -> fill at the open (gap-stop).
- 2 closes below the 50 SMA -> exit at the next open.
- Turtle sizing: 1% risk, cash only (no leverage), max 5 open, total open risk <= 20% of equity.
- Same-day signals ranked by nearness to the 52-week high (close / 252-day high), regardless of entry type (decision 4).
- $2,000 compounding (each window starts at $2,000); slippage 0.05%; SEC fee + FINRA TAF. Signals on closed daily bars; fills at the next open.

## 2. Filters (checked at the signal day's close)
- Market: SPY 50 SMA > SPY 200 SMA (split-adjusted SPY). Applies to every entry (decision 1).
- Stock trend: 20 EMA > 50 SMA > 200 SMA (breakout and retest). Entry A keeps its v1 test 20 SMA > 50 SMA > 200 SMA (decision 1).

## 3. Breakout entry ("BO")
- Signal day closes above the prior 20-day high (highest high of the 20 sessions before it). Fill at the next open. No intraday touch entries.
- Volume on the signal day >= 1.5 x the average volume of the 50 sessions before it [adapted].
- Tight range: highest high - lowest low of the 15 sessions before the signal day <= 3N, N as of the signal day [adapted].
- Stop 2N. No room rule (decision 2).

## 4. Entry B - retest ("RT")
- Needs a breakout that passed section 2 and 3. Broken level = that breakout's prior 20-day high.
- Within the 10 sessions after the breakout day: the first day with low <= level + 0.5N and close > level (N as of that day) is the signal; fill at the next open.
- Market filter and earnings rule checked again at the retest day.
- Stop = the tighter of (fill - 2N) and (retest-day low - 0.5N); sized from that stop at 1% risk. No trade if the stop is not below the fill.
- One position per stock: no retest entry if a position in that stock is already open. No room rule (decision 2).

## 5. Entry A (MA bounce)
- Exactly as H v1: 3rd touch of the 20 or 50 SMA after 2 bounces, with a hammer / bullish engulfing / morning star closing above the 20 SMA,
  in a 20 SMA > 50 SMA > 200 SMA trend; room >= 2R to the nearest daily swing high of the last 60 days (decision 2).
- Detected on its own (in v1 a breakout on the same day took precedence; here the breakout is a separate entry type).
- Plus the market filter and the earnings rule (decision 1).

## 6. Earnings [approximate] (decision 3)
- Dates and report times from FMP's earnings calendar (actual report dates, not dates as announced at the time: a small look-ahead).
- No new entry if the stock's next earnings date falls within the 5 trading days starting on the fill day.
- Exit any open position at the last close before the report, at that close - slippage:
  report before the open on day E -> close of the trading day before E; after the close on day E -> close of E; time unknown -> treated as before the open [adapted].
- Reported: signals blocked by earnings, trades exited for earnings, and those exits' R.

## 7. Runs and report
- Runs: H v1 (reference), breakout only, Entry B only, Entry A only, combined (all three), combined without the market filter (report only).
- Windows: tuning Oct 14, 2024 - Jul 31, 2026 (run once); holdout Aug 1 - Oct 13, 2026 (run once); lock file per window.
- Report: usual stats per run; exits by type and the gap-stop count; signals blocked by each filter; earnings effect; results by month.
- Pass rule (same rulebook rule as H v1, for the window): expectancy > 0.2R, PF > 1.5, max DD < 15R, largest loss < 3R,
  profitable months >= 4/6 of the window's months, trades >= 100 prorated by the window's share of the 501 trading days.

## Decisions (Jose, Oct 19, 2026)
1. Market filter and earnings rule apply to every entry; Entry A keeps its v1 trend test (20 SMA > 50 SMA > 200 SMA).
2. Room rule (>= 2R to the nearest daily swing high, 60 days) for Entry A only, not for breakouts or retests.
3. Earnings dates accepted as [approximate]; probe the FMP download first; report how many trades the earnings rule blocked or exited.
4. Same-day priority: rank all signals by nearness to the 52-week high, regardless of entry type.
