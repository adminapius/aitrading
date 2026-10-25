# Strategy R ("Ross-type"): H1, H2, H3 - DRAFT (Oct 25, 2026)

**Status: DRAFT; R1-R14 approved by Jose as proposed (Oct 25, 2026), with the three additions in section 10. Not
locked, built or run. R is locked only after U1 (PR #114) is merged and its results are recorded in
docs/backtest-known-issues.md (Jose, Oct 25, 2026).** Source: the Ross audit (`docs/ross-audit.md`), hypotheses H1
(who) and H2 (when), plus H3 (Jose, Oct 25).

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
- **Float coverage (LOCKED Oct 25, 2026 by Jose, before any result):** the run reports EDGAR float coverage by
  calendar year for R's candidate stock-days (section 3's filters other than float, U1 included): found / no value,
  with the reasons (foreign, new listing, stale, no CIK, other). Stocks without a float value are excluded and
  counted. **If coverage is under 75% in any calendar year of the tuning or holdout window, the run is reported as
  information only and cannot pass.** Coverage was under 90% before (61.6-69.9% of E's enterable stock-days by
  year, docs/backtest-known-issues.md issue 2). The probe (section 9) reports the same numbers first.
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
- Fees: E's constants (`RULEBOOK.costs`): SEC $20.60 per $1M sold, FINRA TAF $0.000195 per share sold (max
  $9.79), commission $0, on top of the fill prices above (Jose, Oct 25).

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

## 9. Probe first (counts only: no exits, no returns)
`npx tsx scripts/backtest/strategy-r.ts --probe` (built Oct 25, 2026; needs the U1 code, so it runs from a branch
that includes it). It also caches the data the run needs. It reports, per window:
- trading days; pre-screened stock-days (daily high >= +20%, $2-20 touched, >= 500k shares); **candidate stock-days**
  (section 3 except float holds at some bar close 07:00-11:00), and how many of them are U1 delisted entities;
  inferred halts on candidate days.
- **Float coverage by calendar year** for the candidate stock-days against the 75% floor (section 2), with the
  **foreign filers excluded by R2 counted by year** (Jose's R2 addition), misses by reason, the share <= 5M, and U1
  coverage.
- Per line (H1, H2, H3): breaks found; why a break was not a setup (window, price, gain, volume, news, foreign, no
  float, float over 5M); setups; skipped setups by reason; **setups skipped for a spread over 3%, by hour**, with a
  **flag if more than half of H2's setups are skipped** (Jose's R11 addition; the rule does not change); median
  quoted spread pre-market and in regular hours; quote coverage.
- **Estimated trades per line** (Jose's R12/R14 addition): setups that would fill, as a range: upper = every fill
  (no position cap), lower = at most 3 a day (the position cap). Sizing at $2,000 with no P&L (the probe computes
  none), so the 4% daily loss limit and compounding are not in the estimate. A holdout line whose upper count is
  under 30 is flagged for R14 before the lock; one whose range straddles 30 is flagged too, and its count in the
  run decides.
- The trigger and filters run exactly as in sections 3-7; the probe stops at the entry (no stop, target or exit is
  simulated). Files: `backtests/strategy-r/probe/report.txt`, `probe.json`, `setups.csv` (one row per setup: the
  decision, never an outcome).

### 9b. Probe result (Jose's laptop, Oct 25, 2026; counts only; 35.9 min, SEC 2,382 and Alpaca 5,763 requests)
Universe 14,140 symbols + 1,117 U1 delisted entities (U1 merged Oct 25, PR #114). Daily pre-screen: 3,128 symbols,
16,332 stock-days (536 of the candidate stock-days are U1 entities).

| Window | Trading days | Pre-screened stock-days | Candidate stock-days | of them U1 | Inferred halts on candidate days |
|---|---|---|---|---|---|
| Tuning Oct 14, 2024 - Jul 31, 2026 | 450 | 14,667 | 3,349 | 536 | 424 |
| Holdout Aug 1 - Oct 16, 2026 | 54 | 1,665 | 384 | 4 | 80 |

**Float coverage (locked floor 75%; gate = covered / (candidates - foreign), see R15): passes in every year.**

| Window, year | Candidates | Foreign (R2) | Covered | Coverage | Incl. foreign | <= 5M of covered | U1 covered |
|---|---|---|---|---|---|---|---|
| Tuning 2024 | 418 | 92 (22.0%) | 276 | 84.7% | 66.0% | 34.8% | 64 of 102 |
| Tuning 2025 | 1,894 | 492 (26.0%) | 1,191 | 85.0% | 62.9% | 31.9% | 247 of 369 |
| Tuning 2026 | 1,037 | 357 (34.4%) | 568 | 83.5% | 54.8% | 32.2% | 35 of 65 |
| Holdout 2026 | 384 | 131 (34.1%) | 213 | 84.2% | 55.5% | 47.4% | 1 of 4 |

Missing (tuning, all years): no value 121, stale 113, no CIK 69, none filed before 36, no split data 25, name
mismatch 9. **Counting foreign filers as not covered would put every year under 75% (54.8-66.0%).**

**Setups and estimated trades (sizing at $2,000, no P&L; upper = every fill, lower = at most 3 a day; no day had
more than 3, so the range is one number):**

| Line | Tuning setups / would fill | Holdout setups / would fill | Holdout estimate vs 30 |
|---|---|---|---|
| H1 07:00-11:00 | 263 / 154 | 48 / 24 | **24: under 30** |
| H2 07:00-09:30 | 161 / 107 | 24 / 14 | **14: under 30** |
| H3 09:45-11:00 | 114 / 49 | 23 / 9 | **9: under 30** |

- Why breaks were not setups (tuning H1, 25,909 breaks): gain under 20% at that bar 16,145; no news within 120 min
  3,332; price outside $2-20 2,978; volume under 500k 1,667; float over 5M 864; foreign filer 430; no float value 230.
- Skipped setups (tuning H1): risk over 10% of price 80 (30% of setups); no quote within 120 s 27; spread over 3% 2.
- **R11: spread over 3% skipped 2 of 263 H1 setups, 0 of 161 H2, 1 of 114 H3; no H2 flag.** Median quoted spread at
  setups 0.36% pre-market, 0.49-0.55% after the open (tuning); 0.48% / 0.43% (holdout). 71 of 633 quote look-ups
  (11.2%) found no quote in the 120 s before the fill bar.
- **R14 is triggered on all three lines**: the holdout cannot reach 30 trades on any of them (24 / 14 / 9), before
  the position cap and the daily loss limit, which can only lower the count. With the approved default, every line's
  backtest verdict is information only, and a paper test happens only by Jose's decision. Decision R16 below.

## 10. Open decisions (defaults proposed)
Approved by Jose as proposed (Oct 25, 2026), with three additions: **R2** also reports the candidate stock-days
excluded as foreign filers, by year (Ross trades many Cayman and Chinese names; this shows what the exclusion
costs). **R11** reports setups skipped for a spread over 3%, by line and by hour; if more than half of H2's setups
are skipped, the report flags it; the rule does not change. **R12/R14** the probe estimates holdout trade counts per
line before the lock; fees are E's constants on top of R11's fill price.

- **R1** U1 universe required. Default: yes; the U1 probe and the Ross Q1/Q2 rerun come first. (Locked by Jose,
  Oct 25: U1 merged and its results in before R is locked.)
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

**Open (proposed Oct 25, needs Jose's call before the lock):**
- **R15 Coverage base.** The locked 75% floor needs a denominator. Default: covered / (candidate stock-days - foreign
  filers), because R2 excludes foreign filers by rule, not for missing data; the share including foreign filers is
  reported next to it. Alternative: count foreign filers as not covered (stricter; with many Cayman and Chinese
  names it may push a year under 75%). **Probe (Oct 25): with the default every year passes (83.5-85.0%); with the
  alternative every year fails (54.8-66.0%).**
- **R16 Holdout too short for every line (probe, Oct 25).** Holdout estimates 24 / 14 / 9 trades, all under 30.
  Options, to decide before the lock:
  - (a) Default, as approved in R14: run both windows once; every line's backtest is information only; a locked
    paper test only if Jose decides it from the results.
  - (b) Judge each line on the whole window, Oct 14, 2024 - Oct 16, 2026 (estimates H1 178, H2 121, H3 58), since R
    tunes no parameter. Against it: the rules came from the Ross audit, whose sampled days span that whole window,
    so no part of it is unseen by the rule design; the tuning-positive guard (R13) would no longer be separate.
  - (c) Add an older holdout (for example Oct 2022 - Oct 2024): needs U1 and EDGAR float extended back, a new probe,
    and E's earlier EDGAR coverage there was 66-70% (issue 2), so it may fail the 75% floor.

## 11. Caveats
- Ross's edge may be his execution (direct-access routing, hotkeys, level 2 and tape reading, 10-second charts) and
  his size; this tests only whether the stock selection and a simple pullback trigger work at our fills.
- 1-minute bars cannot see a 10-second pullback; the trigger is a coarser version of his.
- EDGAR float misses new listings before their first 10-Q/20-F; recent IPOs, which Ross trades, are mostly not
  enterable [bias].
- Inferred halts miss halts shorter than a bar gap and may read a no-trade gap as a halt.
