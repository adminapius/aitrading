# Strategy R ("Ross-type"): H1, H2, H3 - DRAFT (Oct 25, 2026)

**Status: DRAFT. Nothing is locked, built or run.** Open decisions are listed with a default (section 10); Jose
approves or changes them, then the spec is locked before any result is seen. Source: the Ross audit
(`docs/ross-audit.md`), hypotheses H1 (who) and H2 (when), plus H3 (Jose, Oct 25).

Live Strategy E and its paper test are not touched.

## 1. Lines (all three judged; same filters, trigger, stop, exit, sizing, costs and pass rule)
| Line | Entry window (ET) | What it asks |
|---|---|---|
| **H1** | 07:00-11:00 | Do Ross-type stocks, traded by these rules, have an edge at our fills? |
| **H2** | 07:00-09:30 | Is it the pre-market part (Ross's median entry 07:46)? |
| **H3** | 09:45-11:00 | Is it the 09:45-11:00 part (where E-current made its tuning money)? |

"Entry window" = the time of the entry fill. Exits run until the stop, target or the 15:30 flatten for all three.

## 2. Universe and data
- **U1 universe** (`scripts/backtest/u1-delisted.ts`): today's Alpaca list plus FMP's delisted common stocks
  fetched under their old tickers, plus renames. Required; without it a third of Ross-type names are missing and
  the test is biased toward survivors. **[R1]**
- Point-in-time float = EDGAR shares outstanding on the trade date, as in `docs/strategy-ej-310-spec.md` D1
  (latest cover count filed strictly before the day, split-adjusted, at most 400 days old; delisted companies
  matched to EDGAR by their old name). No value = not enterable, counted by reason. Shares outstanding >= float,
  so this is a stricter gate [approximate]. Foreign filers: **[R2]**.
- 1-minute SIP bars (04:00-16:00), SIP NBBO quotes, Alpaca news, all cached; a probe (section 9) first.

## 3. Entry filters (at each minute, using only bars closed by then)
- Float <= 5M shares (section 2).
- Price $2-20 (last trade).
- News: a story on the ticker published within the last 120 minutes (Alpaca news feed). **[R3]**
- Day gain >= +20% over the prior official close; no upper cap.
- Minimum share volume in place of E's relative-volume check: >= 500,000 shares traded since 04:00. **[R4]**
- Common stock, not halted at that minute (section 6), executable quote present (section 7).

## 4. Entry trigger - default: the first pullback, then a new high of day **[R5]**
Two candidates from the audit:
- (a) **Break of the pre-market high.** Only 36% of Ross's pre-market entries were above every earlier pre-market
  high (39 entries), and it does not exist after 09:30, so it would not describe H3 at all.
- (b) **First pullback, then a new high of day** (Ross's "micro pullback" / "first pullback"; the audit's entries
  are mostly a dip in a fresh move, median gain at entry +58.6%). Works before and after the open, so the three
  lines share one trigger.

**Default (b)**, on 1-minute bars:
1. The stock passes section 3 and has set a new high of day H on a bar.
2. Pullback: one to five consecutive bars that do not exceed H. Pullback low L = the lowest low of those bars. The
   pullback must hold above VWAP and give back no more than half the move from the day's low to H. **[R6]**
3. Entry: a buy-stop at H + $0.01 while the pullback is valid; it fills on the first later bar that trades through
   H (section 7). If six bars pass without the break, or a bar closes below L, the setup resets.
4. One entry per symbol per day. **[R7]**

## 5. Stop and exit
- **Stop: the pullback low L - $0.01.** Risk per share = fill - stop. Skip if the risk is under $0.02 or over 10%
  of the price. **[R8]**
- **Exit - default: a 2R target** (limit at fill + 2 x risk, filled only on a trade-through by $0.01), otherwise the
  stop, otherwise the 15:30 ET flatten (Jose's standing rule). No scale-outs, no trailing, no adds. **[R9]**
  Why simple: one parameter, and the audit cannot say what Ross's exits are worth at our size; E-J showed how much
  exit engineering can move results on few trades.

## 6. Halts (LULD pauses from minute-bar gaps) **[R10]**
- During regular hours, a stock that traded in each of the previous 5 minutes and then has no bar for 5 or more
  consecutive minutes is treated as halted for that gap (a 5-minute LULD pause, possibly repeated).
- Pre-market gaps are not halts (thin trading is normal then; LULD runs 09:30-16:00).
- During a halt: no entries; pending entry orders are cancelled; **a stop cannot fill**; a target cannot fill.
- On the first bar after the halt: if it opens at or below the stop, the stop fills at that open minus the half
  spread and slippage (the gap is taken in full); if it opens at or above the target, the target fills at the target.

## 7. Fills: quote-based, spread modelled, no market impact (our size is small)
- Each fill uses the SIP NBBO quote at the start of the fill bar (pre-market spreads are wide, so this matters).
- **Buy:** max(H + $0.01, bar open) + half the quoted spread + $0.01 slippage. No fill if there is no quote within
  120 s or the spread is over 3% of the mid (counted). **[R11]**
- **Stop sell:** min(stop, bar open) - half the quoted spread - $0.01, on the first bar whose low touches the stop
  (stop checked before target in the same bar; on the entry bar only if the bar closes at or below the stop).
- **Target sell:** the target, on a trade-through by $0.01; no slippage (limit).
- **Flatten 15:30:** the 15:30 bar's open - half spread - $0.01.
- Volume caps as in E: shares <= 1% of the volume so far and <= 10% of the fill bar's volume.
- Fees: SEC $20.60 per $1M sold, FINRA TAF $0.000195 per share sold (max $9.79), commission $0.

## 8. Account, windows, pass rule
- $2,000 start, compounding; risk 1% of equity per trade; at most 25% of equity per position; at most 3 open
  positions; 4% daily loss limit; no margin; no overnight holds; flat by 15:30 ET. The PDT rule no longer applies
  at Alpaca (`docs/strategy-c-spec.md` section 7).
- **Windows: tuning Oct 14, 2024 - Jul 31, 2026; holdout Aug 1 - Oct 16, 2026.** Each runs once with a lock, tuning
  first. No parameter is tuned: tuning is reported, the verdict is the holdout.
- **Pass rule: the same as E's.** On the holdout, per line: at least 30 trades, expectancy > +0.10R and profit factor
  > 1.3 (R from the model fills above; there is no paper/model gap in a backtest). **[R12]**
- **How the three lines are judged and compared:**
  - Each line is judged alone against the pass rule; each passes or fails on its own.
  - They are not independent (H2 and H3 are parts of H1's day), so a side-by-side table (trades, expectancy, PF,
    R, $, win %) is reported, but **no line wins by beating another**.
  - Three tries raise the chance that one passes by luck. Default guard: a line counts as passed only if it also
    has positive expectancy in tuning. If more than one passes, all are recorded; the one taken to a paper test is
    decided by Jose before the run, default H1 (most trades). **[R13]**
  - A pass leads only to a locked paper test with its own fill audit, never straight to live money.

## 9. Probe first (counts only, no returns)
Before the lock: per window and line, trading days; U1 entities in the candidate set; candidate stock-days passing
section 3; triggers found; halts inferred; quote coverage and median pre-market spread; EDGAR float coverage
(found / foreign / no value / stale); expected trade count. If the holdout cannot reach 30 trades on a line, that
is decided before any result **[R14]**.

## 10. Open decisions (defaults proposed)
- **R1** U1 universe required. Default: yes; the U1 probe and the Ross Q1/Q2 rerun come first.
- **R2** Foreign filers (20-F / 40-F; ADR share counts are not comparable, known issue 3). Default: excluded, counted.
- **R3** News within 120 minutes from Alpaca's feed (Ross reads his own feed; coverage may differ). Default: Alpaca,
  120 minutes; the probe reports the share of candidate days with any story.
- **R4** Minimum volume 500,000 shares since 04:00 (Ross's names traded 1.5M shares in the first 5 minutes after
  the open; E-current's 0.42M). Default: 500,000, no dollar-volume floor beyond price x volume.
- **R5** Trigger. Default: (b) first pullback, then a new high of day.
- **R6** Pullback validity: 1-5 bars, above VWAP, at most 50% retrace of the day's low-to-high move. Default: as stated.
- **R7** Entries per symbol per day. Default: 1 (Ross re-enters; E allows 2).
- **R8** Risk bounds: $0.02 to 10% of price. Default: as stated.
- **R9** Exit. Default: 2R target, stop, 15:30 flatten. Alternative: 1.5R (closer to Ross's base hits).
- **R10** Halts inferred from 5-minute RTH bar gaps. Alternative: Nasdaq Trader's halt history (exact times, more
  work). Default: inferred.
- **R11** Quote rules: quote within 120 s, skip if the spread is over 3% of the mid. Default: as stated.
- **R12** Pass rule on all holdout trades with n >= 30 (E's paper rule judges exactly the 30th; in a backtest all
  holdout trades are used). Default: as stated.
- **R13** Multiple-line guard and which passing line goes to paper. Default: positive tuning expectancy required;
  H1 preferred.
- **R14** If the probe says the holdout cannot reach 30 trades on a line. Default: that line is reported as
  information only for the backtest and goes straight to a locked paper test only by Jose's decision.

## 11. Caveats
- Ross's edge may be his execution (direct-access routing, hotkeys, level 2 and tape reading, 10-second charts) and
  his size; this tests only whether the stock selection and a simple pullback trigger work at our fills.
- 1-minute bars cannot see a 10-second pullback; the trigger is a coarser version of his.
- EDGAR float misses new listings before their first 10-Q/20-F; recent IPOs, which Ross trades, are mostly not
  enterable [bias].
- Inferred halts miss halts shorter than a bar gap and may read a no-trade gap as a halt.
