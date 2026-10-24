# Strategy SW: swing trading by the course (DRAFT, Oct 23, 2026; not locked until Jose approves)

BACKTEST ONLY. Strategy E and A stay unchanged. Rules as Jose wrote them (lesson tags kept). Items marked **[D#]**
are open decisions (section 10) with a proposed default. No SW code beyond the data probe
(`scripts/backtest/rulebook/strategy-sw-probe.ts`) until this spec is locked.

## 1. Universe (point in time, decided each day)
- US common stocks, prior raw close above $10, 50-day average volume above 1M shares, top 500 by 50-day average
  dollar volume (raw close x volume). No ETFs, warrants or ADRs (rulebook common-stock filter, which drops names
  with "depositary"). SPY only as the market filter. Long only.
- Delisted stocks: the universe comes from Alpaca's active AND inactive asset lists, with each symbol's own daily
  history, so a stock that later delisted is tradeable while it traded. Limits **[D2]**: Alpaca's history begins
  in 2016 and its inactive list may miss some early delistings; a reused ticker can mix two companies (the probe
  counts long gaps inside a history).

## 2. Data and windows
- Daily bars from Alpaca SIP, 2016-01-01 to 2026-10-16: raw bars for the $10, volume and dollar-volume tests;
  split-adjusted bars for every indicator, scaled to each day's price terms (as in Strategy F). Weekly bars built
  from the split-adjusted daily bars (Monday-Friday weeks). **[D3]**
- Windows, each run once, nothing changes after a run: tuning 2016 to Dec 31, 2022; validation 2023 to Dec 31,
  2024; final holdout Jan 1, 2025 to Oct 16, 2026. The 200 SMA and weekly MACD need about 10 months of history,
  so the first possible signal is around late 2016. **[D1]**
- The holdout overlaps the earlier H v1 / H v2 runs (Oct 2024-Oct 2026) on the same stocks. SW's rules are
  different (filters, setups, exits), but the overlap is real and is stated here.

## 3. Filters at the signal day's close
- Market (L5, L7): SPY 50 SMA above its 200 SMA.
- Stock trend (L5): 20 EMA > 50 SMA > 100 SMA > 200 SMA, and close above the 50 SMA.
- Weekly trend (L2, L6): weekly MACD (12, 26, 9) line above its signal line, using the last completed week
  only (no look-ahead into the current week). **[D8]**
- Earnings (L11): no entry when an earnings date falls within the 5 trading days starting on the fill day.
  Source **[D5, decided by Jose Oct 23]**: SEC EDGAR 8-K filings with Item 2.02, 2016 onward; FMP calendar as a
  cross-check from 2022 (the FMP plan returns HTTP 402 before 2022). Tagged [approximate]: these are ACTUAL report
  dates, not the dates announced in advance. Timing from the EDGAR acceptance time (UTC -> Eastern): before 9:30 =
  before the open, after 16:00 = after the close, in between = during the session (treated like before the open).

## 4. Setup SW-A: MA bounce (L8, candles from L3)
- A test = a day whose low touches or comes within 0.25 ATR(20) of the 20 EMA or the 50 SMA while the close stays
  above that MA. Tests count within the current uptrend run (since the stock-trend filter last turned on); a new
  test only counts after price has made a higher high than the high before the previous test. **[D6]**
- Signal on the 3rd test of the same MA, when that day is a confirmation candle (rulebook definitions):
  hammer (lower shadow >= 2x body, upper <= 0.3x body), bullish engulfing (green body engulfs the prior red body),
  or morning star (long red, small bar, green closing above half of the first body).
- Entry at the next day's open. Swing low for the stop = the lowest low of the 3rd test day and the 2 days before it.

## 5. Setup SW-M: MACD system (L6)
- Weekly MACD bullish (filter above). Daily MACD (12, 26, 9) line crosses above its signal line at day D's close.
- "Enter at the next open if the cross still holds": the cross must still hold at day D+1's close; entry at
  day D+2's open; if it failed, skip. **[D7]**
- Swing low for the stop = the lowest low of the 10 trading days up to the signal day.
- Reversal rule (L6): exit at the next open after a bearish weekly MACD crossover (known at the week's last close).

## 6. Stops and exits (both setups)
- Initial stop: the lower of (swing low - 0.5 ATR) and (entry - 2 ATR), ATR = 20-day, from the actual fill.
  Skip if the stop is less than 1.5 ATR or more than 3 ATR below entry. Note: taking the lower of the two always
  gives at least 2 ATR, so in practice the skip is only for stops wider than 3 ATR.
- Never lower a stop (L12). R-trail (L12): each time the close reaches another +1R of open profit, the stop rises
  by 1R (+1R -> breakeven, +2R -> +1R, ...), effective the next day. **[D9]**
- Trend exit (L8): two consecutive closes below the 50 SMA -> exit at the next open.
- Time stop (L12) [adapted]: no close at or above +1R within 15 trading days -> exit at the next open. **[D9]**
- Earnings: exit at the close before a report (before-open report on day D -> exit at D-1's close; after-close
  report on day D -> exit at D's close; unknown time -> treated as before the open).
- Stop fills: the day's low touches the stop -> stop - slippage; the day opens through the stop -> open - slippage
  (gap-stop, counted). Exits are checked in this order each day: gap-stop, stop, then the close-based rules.

## 7. Sizing and portfolio (L11, L12, L14)
- Risk 1% of current equity per trade; shares = risk / (entry - stop), floored; cash only, no margin; $2,000
  start, compounding.
- At most 6 open positions; at most 20% of equity at risk across open positions (risk = shares x (entry - current
  stop), so a trailed-to-breakeven stop counts as 0). At most 2 positions per sector. **[D4]**
- Drawdown rule (L14, simplified): while equity is more than 10% below its peak, risk 0.5% per trade.
- Competing signals: nearest to the 52-week high first (close / 252-day high close), then dollar volume.
- Information-only line: the same signals at a flat $20 risk, no cash cap, so R and dollars match.
- Costs: 0.05% slippage on every fill, SEC fee and FINRA TAF on sells. Signals on closed daily bars, fills at the
  next open.

## 8. Report (per window; runs SW-A only, SW-M only, combined)
Trades, win %, average win and loss, expectancy, profit factor, max drawdown (R and %), largest loss, R and
dollars, CAGR, share of profitable months and years; exits by type and the gap-stop count; signals blocked by each
filter and by the portfolio rules; average holding time; SPY buy-and-hold over the same window (CAGR, max drawdown,
Sharpe). The flat-$20 line is reported next to the combined run.

## 9. Pass rule (locked at approval; applied to the combined run in the final holdout)
- At least 60 trades, expectancy > +0.2R, profit factor > 1.4, max drawdown < 15R, largest loss < 3R, positive
  in dollars.
- Validation must also be positive in R and in dollars.
- SPY comparison **[D10]**.
- A pass goes to forward paper trading on Alpaca (about 30 trades) before any live money.

## 10. Open decisions (proposed defaults in bold)
- **D1 Start:** Alpaca history starts Jan 2016; **tuning keeps its window, with indicators warming up in 2016**
  (first signals around late 2016).
- **D2 Delisted / ticker reuse:** **use Alpaca's active + inactive lists; report how many delisted symbols have
  data; a symbol with a gap over 60 trading days is split there and the later part is treated as a new stock.**
- **D3 Prices:** **raw prices for the $10 / volume / dollar-volume tests, split-adjusted (scaled to the day) for
  indicators; no dividend adjustment.**
- **D4 Sector:** FMP has only the current / last-known sector, not point in time. **Use it; a stock with no sector
  counts as its own group (not limited).**
- **D5 Earnings: DECIDED (Jose, Oct 23):** SEC EDGAR 8-K Item 2.02 from 2016, FMP cross-check from 2022,
  tagged [approximate] (actual report dates). Coverage by year measured by `strategy-sw-edgar-probe.ts`
  before the lock. A stock with no earnings 8-K in a year gets no block that year.
- **D6 SW-A "tested twice and bounced":** **as in section 4** (tests inside the current uptrend run, each new test
  only after a higher high, the 3rd test with a confirmation candle signals).
- **D7 SW-M "cross still holds":** it can only be known at a close, so **confirm at D+1's close and enter at
  D+2's open.** (The alternative is to enter at D+1's open with no confirmation.)
- **D8 Weekly bars:** **last completed week only.**
- **D9 Trail and time stop:** **both use daily closes** (the alternative is the daily high).
- **D10 SPY:** "SW must beat it on a risk-adjusted basis". **Proposed: an extra pass condition in the holdout:
  SW combined Sharpe (daily equity returns, $2,000 line) above SPY buy-and-hold Sharpe.** Or report only.
