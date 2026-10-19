# Strategy F: opening-range reversal + FVG (DRAFT, Oct 19, 2026; decisions answered, locks after the probe output)

BACKTEST ONLY. Nothing live. Rules as Jose wrote them; items marked **[D#]** were decided by Jose on Oct 19 (section 11).
No code beyond the data probe (`scripts/backtest/rulebook/strategy-f-probe.ts`) until the spec is locked.

## 1. Universe (point in time, decided each morning)
- Common stocks with a prior close above $10, ranked by average dollar volume (raw close x volume) over the prior 20
  trading days; top 100. Active and delisted names (no survivorship bias). Today's volume is never used.
- "Common stock" = the rulebook filter: no warrants, units, rights, preferreds, ETFs/ETNs/funds (so no leveraged ETFs),
  no symbols with a dot. That filter also drops ADRs (names containing "depositary"). **[D1]**
- SPY and QQQ: separate report line. **[D2]**
- SP penny-gapper universe (rulebook SP scanner): its own line, information only, not judged.

## 2. Opening range (OR)
- The 9:30-9:44 one-minute bars (the first 15-minute candle). OR high/low = extremes; OR open = 9:30 open; OR close = 9:44 close.
- OR range = high - low.
- Liquidity filter: trade only if OR range >= 25% of the prior day's daily ATR(14) (split-adjusted daily bars, Wilder).
- Direction: red OR (close < open) -> long setups only; green OR -> short setups only; OR close = open -> no trade.

## 3. Trading window and limits
- Entries 9:45-11:00 ET only. Unfilled orders cancel at 11:00. Open positions close at the 11:00 bar's open minus slippage.
- Information line: the same trades held to target or stop, or 15:55 at the latest.
- One trade per symbol per day. Max 3 open positions. **[D5]**
- Daily stop at -3R: once the day's closed trades sum to -3R or worse, cancel all working orders and take no new
  entries; open positions run to their own exits. **[D6]**
- Sizing **[D3]**:
  - Judged line: flat $20 risk per trade (1% of $2,000), no cash cap, not compounding. The pass rule (R and $) applies here.
  - Information line: the real $2,000 account, 1% of equity compounding, no leverage (cash cap applies).
  - Both lines: rulebook caps, <= 1% of the day's volume and no fill above 10% of a bar's volume.
- Shorts: Alpaca has no history of shortable / hard-to-borrow flags (only today's). Assumption: every top-100 stock was
  shortable and easy to borrow on every day; today's flags are reported by the probe. No borrow fee intraday. **[D4]**
- Short-sale restriction (Rule 201): skip a short when the stock is under SSR that day (it traded 10% or more below the
  prior close earlier today, or did so yesterday). **[D4]**

## 4. Variant F-A, Touch & Turn
- From 9:45 (OR closed): a limit order at the OR edge. Long at the OR low on a red day; short at the OR high on a green day.
- Target 38.2%: long OR low + 0.382 x range; short OR high - 0.382 x range.
- Stop: half the target distance beyond the entry (long OR low - 0.191 x range; short OR high + 0.191 x range): 2:1.
- Levels are fixed from the OR. If the bar opens through the limit, the fill is at that open (better price); R is
  measured from the actual fill. **[D7]**
- Fills (conservative): entry and target limits fill only on a trade-through by at least one tick (long entry:
  low <= limit - $0.01). Touch fills reported as information only. Stops fill at stop - slippage, or at the bar's open if
  it gaps through. Entry and stop in the same 1-minute bar = stop-out. Entry and target in the same bar: no target that
  bar (the order can't be known). **[D7]**

## 5. Variant F-B, Quick Flip
- Signal on 5-minute bars (9:30 grid) whose close falls in 9:45-11:00, a reversal candle outside the OR: long, the
  candle's low is below the OR low; short, its high is above the OR high.
  - Hammer (long) / shooting star (short), rulebook definitions (lower or upper wick >= 2x body, other wick <= 0.3x
    body), after at least 2 candles moving the other way = the two 5-minute candles right before it are both red
    (long) / both green (short); candles from 9:30 count. **[D8]**
  - Bullish / bearish engulfing (rulebook definition: body engulfs the previous opposite-color candle's body).
- Entry (stop order, active from the next candle):
  - Hammer: buy-stop 1 tick above the hammer's high, valid for the next 5-minute candle only.
  - Engulfing: buy-stop at the high of the previous red candle, valid for the next 5-minute candle only. **[D8]**
  - Mirror both for shorts. A gap through the stop level fills at the open + slippage.
- Stop: signal candle low - 1 tick (long); high + 1 tick (short).
- Target: the opposite OR edge (long OR high, short OR low).
- Skip if reward < 1.5R, measured at order placement from the stop-order price. If an order doesn't fill, a later
  signal the same day may still trade (one trade per symbol per day). **[D8]**

## 6. FVG split (information, not a filter)
- This repo has no 5-minute FVG detector (the only FVG code is a 1-minute gap check inside Strategy SP). Built from
  this definition only; nothing taken from Jose's other apps. **[D9]**
- 5-minute bars, 4:00-9:45 ET. Three candles of the same color. Bullish gap (3 green): third low > first high, gap =
  first high to third low. Bearish gap (3 red): third high < first low.
- Unfilled = not yet fully closed by any later bar up to the entry time (bullish: no later low <= first high). **[D9]**
- "FVG confluence" = an unfilled gap in the trade's direction whose nearest edge is within 0.25 x prior daily ATR(14) of
  the entry price (0 if the entry is inside it). Both variants reported FVG yes / no.

## 7. Costs and data
- S cost model: 0.05% slippage on market-type fills (stop exits, the 11:00 close, F-B stop-order entries); limit fills
  (F-A entry, targets) at the limit price. SEC fee $20.60/M on sells, FINRA TAF $0.000195/share (max $9.79).
- Signals use closed bars only; fills on later bars. SIP 1-minute bars (4:00-16:00), cached per symbol-day.
- Order priority when more orders fill than open slots: earlier fill first; same minute: higher dollar-volume rank.
  Orders left working may fill later if a slot frees before 11:00. **[D5]**

## 8. Windows
- Tuning Oct 14, 2024 - Jul 31, 2026, run once. Holdout Aug 1 - Oct 16, 2026, run once (3 more days than the rulebook's
  Oct 13 end; needs a small extra daily download). Lock file per window. Nothing changes after either run.

## 9. Diagnostic (checks the video's claim)
Per symbol-day, stocks and SPY/QQQ separately:
1. % of days with an OR big enough to count (>= 25% of daily ATR).
2. Of those, % where price came back to the OR edge on the setup side (red day: low <= OR low; green day: high >= OR
   high) between 9:45 and 11:00 (touch).
3. Of those, % that reached the 38.2% target before the 2:1 stop (same bar = stop), measured from the first touch.

## 10. Report and pass rule
Per variant: trades, win %, average win and loss, expectancy, PF, max drawdown, largest loss, profitable months;
R and dollar totals; splits long/short, large caps vs SPY/QQQ, FVG yes/no; exit reasons; entry time buckets
9:45-10:00, 10:00-10:30, 10:30-11:00. Plus the information lines (hold to 15:55, touch fills, SP penny line).

Pass (per variant, judged on the large-cap run at the flat $20 risk, locked at approval):
- Holdout: >= 30 trades, expectancy > +0.2R after costs, PF > 1.5, largest loss < 3R, positive in dollars.
- Tuning: total R > 0 and total dollars > 0.
- A pass goes to forward paper trading on Alpaca (about 30 trades) before any live money.

## 11. Decisions (Jose, Oct 19, 2026)
- **D1 ADRs:** kept out (rulebook common-stock filter). Default accepted.
- **D2 SPY/QQQ:** separate run, same rules, own sizing lines, report only, not judged. Default accepted.
- **D3 Sizing:** judged line = flat $20 risk per trade, no cash cap; pass rule (R and $) applies to it. The real
  $2,000 cash-capped account is an information line. No pattern-day-trader limit: FINRA eliminated the PDT rule
  effective June 4, 2026.
- **D4 Shorts:** assume shortable and easy to borrow on every day (no history); skip shorts under the short-sale
  restriction (after a 10% drop from the prior close, that day or carried from the day before).
- **D5 Slots:** earlier fill first, ties by dollar-volume rank; in the cash-capped line each position uses cash not
  already in open positions; working orders may fill when a slot frees. Default accepted.
- **D6 Daily stop:** closed-trade R only; stops new entries, open positions run. Default accepted.
- **D7 F-A fills:** fixed OR levels; fill at the open if it gaps through the limit; no target in the entry bar. Default accepted.
- **D8 F-B:** 2-candle rule for the hammer only; engulfing order valid one candle; reward check at order placement;
  later signals allowed if an order didn't fill. Default accepted.
- **D9 FVG:** built from Jose's written definition only; "unfilled" = no later candle has fully closed the gap.
