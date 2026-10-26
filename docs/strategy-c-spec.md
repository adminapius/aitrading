# Strategy C: rest-of-day momentum on SPY (LOCKED Oct 24, 2026)

BACKTEST ONLY. Rules as Jose wrote them (Oct 24, 2026). It replaces the RSI(2) idea, which never got a spec. Items
marked **[D#]** are Jose's decisions (section 9: D1-D15 approved as proposed, Oct 24, 2026, with his notes).
Locked before any result. Code: `scripts/backtest/strategy-c.ts` (probe and close-check: coverage only, no returns; the
locked run, `--run`, built Oct 25 after the probe's coverage was recorded here, D15; section 11), tests in `tests/strategy-c.test.mjs`. E's paper test
(counting from Mon Oct 26, 2026) is not touched.

Source: Baltussen, Da, Lammers & Martens (2021), "Hedging demand and market intraday momentum", Journal of
Financial Economics 142 (PDF: academicweb.nd.edu/~zda/intramom.pdf, checked Oct 24, 2026).

## 0. Checked against the paper
What the paper does (quoted):
- Predictor: "the return until the last half hour, the return of buying at previous day's close and selling 30
  minutes before today's close", **r_ROD,t = P(c-30, t) / P(c, t-1) - 1** (eq. 2). It predicts the last half-hour
  return r_LH (eq. 7).
- Timing strategy: eta(r) = r_LH if r > 0, otherwise -r_LH (eq. 12): **long the last half hour when r_ROD > 0,
  short otherwise.** Benchmarks: "Always Long" the last half hour, and buy-and-hold to the end of the sample.
- Prices: equity index futures, with trading hours "based on the trading hours of their underlying markets"; the
  previous close is "the price at our closing time on the previous day" (for the S&P 500, 16:00 ET, not the 16:15
  futures settlement).
- Sample: **December 1974 - May 2020**; the gamma tests 1996 - May 2020.
- Mechanism: the effect is concentrated on days when option dealers are net short gamma (Table 7: slope 6.63,
  t = 4.78, when NGE < 0; 0.82, t = 1.03, not significant, when NGE >= 0), plus leveraged-ETF rebalancing.

Jose's rule matches the paper's signal and holding period. The differences, all to be stated in the report:
1. **Long/flat, not long/short.** No published long-only result exists, so this is a new test, not a replication.
2. **ETFs, not futures.** The ETF close is the closing-auction price; ETFs pay dividends, futures do not. On an
   ex-dividend day the ETF's prior close includes the dividend, so the literal r is pushed down by about the
   dividend (SPY, QQQ and IWM about 4 days a year; **DIA monthly**). See **[D1]**.
3. **Signal and fill time.** The paper uses the 15:30 price for both the signal and the trade, gross of costs.
   Here: the signal is the close of the 15:29 bar (the price at 15:30:00), and the fill is the 15:30 bar's open
   plus slippage, plus fees. Live, the order goes out a few seconds after 15:30:00 **[D3]**.
4. **Half days:** the paper's excerpt does not say how early closes are handled; here they are skipped.
5. **Windows:** Jun 2020 onward is after the paper's sample (true out of sample). Jan 2016 - May 2020 is inside it.

## 1. Rules (as Jose wrote them)
- Universe: **SPY** (judged). QQQ, IWM and DIA: robustness lines, same rules, reported separately, never pooled,
  never used to pick a ticker.
- At 15:30 ET: r = close of the 15:29 bar / prior day's official close - 1 **[D1, D2]**.
- r > 0: buy at the 15:30 bar's open + slippage **[D3]**; sell at today's official close (market-on-close) **[D2]**.
- r <= 0: flat. Skip half days and days with missing data **[D7]**. No overnight holds, ever.
- Size: $2,000 start, compounding, 100% of equity, no margin; fractional shares **[D4]**.
- Costs: slippage $0.01 per share each way, plus the SEC fee and FINRA TAF on the sell **[D11]**. Stress line:
  $0.03 per share each way.

## 2. Runs and lines
- **Judged:** Strategy C on SPY, base costs, pass/fail window.
- Same rules: QQQ, IWM, DIA (robustness); SPY at the $0.03 stress cost; SPY in the 2016-2020 consistency window.
- Information only: SPY buy-and-hold; the same rule long/short (short at the same fills, no borrow cost); the
  alternatives in D1, D3 and D4 **[D13]**.

## 3. Windows
- **Pass/fail: Jun 1, 2020 - Oct 16, 2026.** Runs once, with a run-once lock.
- **Consistency check: Jan 4, 2016 - May 29, 2020.** Reported; its sign is one pass condition (rule 5).
- Both windows and every line run in the same single run **[D14]**.

## 4. Pass rule (locked as Jose wrote it; every condition on SPY, pass/fail window, base costs)
1. Sharpe (daily, whole account, flat days counted as 0) >= SPY buy-and-hold's Sharpe **[D5, D6]**.
2. Average net return per trade > 0, with t-stat >= 2 **[D9]**.
3. Still profitable at the $0.03 stress cost (total net return > 0) **[D12]**.
4. Positive in at least 4 of the 6 calendar years 2021-2026 (2026 = Jan 1 - Oct 16) **[D10]**.
5. Positive on at least 2 of QQQ, IWM and DIA, and positive in the 2016-2020 check **[D12]**.

Fail on any condition = fail. No reruns with changed rules, windows or tickers.
- **If it passes:** a locked paper test on its own Alpaca paper account for 3 months or 30 trades, whichever is
  longer; its pass rule and fill audit (live fills vs the modeled 15:30 open and closing price) are set before it
  starts. No live money before that. The account is set up only after a pass.
- **If it fails:** the honest fallback is holding SPY, with a 10-month moving-average filter as drawdown control.
  The report explains why (section 6).

## 5. Report (each line, each window)
Trades; win %; average win and loss in bp and $; the idle-cash share on trade days (D4); PF; CAGR; Sharpe; max drawdown; time in the market; results by
year; by VIX level (below 20 vs 20 or above) **[D8]**; the largest loss; the longest losing streak; days skipped,
by reason; the pass-rule check with each condition's value.

## 6. Fallback explanation (written into the report, whatever the result)
Every short-term strategy tested so far failed its locked test, and published evidence on retail day trading is
poor. If C also fails, the evidence points to owning the index at near-zero cost: SPY buy-and-hold, with a
10-month moving-average filter (hold SPY while the month-end close is above its 10-month average, otherwise cash)
as drawdown control, accepting that the filter mainly helps in long bear markets and lags in fast recoveries.
Its numbers on the same windows are an information line **[D13]**; it is not a strategy under test.

## 7. Account mechanics (checked Oct 24, 2026)
- **Market-on-close cutoff:** Alpaca `time_in_force: cls` orders execute only in the closing auction; "CLS orders
  submitted after 3:50pm but before 7:00pm ET will be rejected" (Alpaca docs, Placing Orders). The 15:30 entry
  leaves 20 minutes to place the MOC sell.
- **Fractional shares:** Alpaca supports fractional orders for "market, limit, stop & stop limit orders with a
  time in force=Day" (Alpaca docs, Fractional Trading). **A fractional market-on-close sell is not possible**, so
  live C would hold whole shares only **[D4]**.
- **Pattern-day-trader rule: removed at Alpaca.** FINRA's effective date was June 4, 2026; Alpaca's blog (updated
  June 4, 2026) says it has "officially lifted the Pattern Day Trader rule" in production for Trading API users:
  no PDT designation, no $25,000 minimum, no day-trade counting; intraday margin calls instead, and pre-trade checks
  that reject orders that would create a margin deficit. A $2,000 account can day trade, so **no cash-account
  workaround is needed**. C uses no margin (100% of equity). Whether paper accounts mirror this is to be checked
  when a paper account is set up (only after a pass).

## 8. Data
Alpaca SIP 1-minute bars (15:29, 15:30, and 15:31 for the D3 line) and daily bars, 2016 onward, for SPY, QQQ, IWM
and DIA; Alpaca's market calendar for half days; closing-auction prints from SIP trades **[D2]**; VIX daily closes
from FMP **[D8]**. No stock universe, so the survivorship issues in docs/backtest-known-issues.md do not apply.
A probe first checks coverage only and computes no returns **[D15]**.

## 8b. Live flow, if C ever goes to paper (a note, not a test rule; Jose, Oct 24, 2026)
- C runs on **its own Alpaca paper account**. E's 15:30 flatten (schedule window and Alpaca-clock rule) must never
  touch C's account, because C buys at exactly 15:30.
- Order flow: buy at 15:30; send the market-on-close sell right after the buy fills, well before the 15:50 cutoff;
  **alert if the MOC sell is not acknowledged by 15:45.**
- No gamma or other filter is added (that would be tuning).

## 9. Decisions (approved by Jose as proposed, Oct 24, 2026; his notes added)
- **D1 Dividends:** **adjust the prior close for that day's dividend (prior close x the one-day dividend factor
  from Alpaca's dividend-adjusted daily closes), so an ex-dividend day is not read as a down day.** The literal
  rule (raw prior close) is an information line. This changes the signal on about 4 days a year (DIA about 12).
  **Approved.**
- **D2 Official close:** **the closing-auction print on the ETF's primary exchange from SIP trades just after
  16:00:00 (SPY, IWM, DIA: NYSE Arca; QQQ: Nasdaq); if none is found, the daily bar's close, counted.** The probe
  measures how often the daily bar close differs from the auction print; if they match on nearly every day, the
  daily close is used instead and the spec says so before lock. The same price is the prior day's close.
  **Approved:** the official closing-auction print; the probe checks the daily bar's close against it.
- **D3 Entry fill:** **as Jose wrote it: the 15:30 bar's open + $0.01.** Information line: the 15:31 bar's open +
  $0.01, for a live order that goes out up to a minute late.
- **D4 Shares:** Alpaca cannot sell fractional shares market-on-close (section 7). **Judged line: whole shares
  (floor of equity / fill price), the remainder held as cash, because that is what live C can do. Fractional
  shares: an information line.** Alternative: keep fractional as judged, as written.
  **Approved:** whole shares judged (with about $2,000 and SPY above $600 that is 2-3 shares, the rest idle cash);
  **the report shows the idle-cash share** (average and range of cash / equity on trade days). Fractional is an
  information line.
- **D5 Sharpe:** **daily returns of the whole account on every session in the window (0 on flat and skipped days),
  annualized x sqrt(252), risk-free rate 0 for both C and buy-and-hold.** **Approved:** cash earns no interest on
  flat days (conservative).
- **D6 Buy-and-hold:** **SPY total return (dividend-adjusted daily closes), invested at the window's first close,
  same Sharpe method.**
- **D7 Skips:** **half days from Alpaca's calendar (close before 16:00); a missing 15:29 or 15:30 bar, closing
  price or prior close: skipped (flat), counted by reason.**
- **D8 VIX level:** **the prior day's VIX close (known before 15:30; no look-ahead), from FMP; below 20 vs 20 or
  above.**
- **D9 t-stat:** **mean net return per trade / (standard deviation / sqrt(n)), per-trade returns in %.**
- **D10 Years:** **calendar years; a year is positive if its net account return is above 0; 2026 runs Jan 1 -
  Oct 16.**
- **D11 Fees:** **the same constants as the other backtests: SEC $20.60 per $1M of sales, FINRA TAF $0.000195 per
  share sold (max $9.79), commission $0, every year.** (Actual historical SEC rates varied; at $2,000 a trade the fee
  is a few cents.)
- **D12 "Positive" in rules 3 and 5:** **total net return > 0 over the window (rule 3 at $0.03; rule 5 for each of
  QQQ, IWM, DIA in the pass/fail window at base costs, and for SPY in 2016-2020 at base costs).**
- **D13 Information lines:** **buy-and-hold, long/short, raw-prior-close (D1), 15:31 fill (D3), fractional (D4),
  and the SPY 10-month-average fallback (section 6), each on both windows.** None is judged.
- **D14 One run:** **both windows and every line in a single run with one lock, since rule 5 uses the 2016-2020
  window.**
- **D15 Probe first:** **a probe that reports data coverage only (sessions, half days, missing bars, closing-print
  matches, VIX days) and computes no returns, then lock.** **Approved.** The probe also caches all the run's data.
- D3, D6-D14: approved as proposed.

## 10. Probe result (Jose's laptop, Oct 25, 2026; coverage only, no returns; 13,465 Alpaca requests, 12.0 min)

| window | ETF | sessions | half days | no 15:29 | no 15:30 | no 15:31 | no prior close | auction print M / 6 / none | abs(print - daily close) <= $0.005 / <= $0.01 / > $0.01 (max) | ex-div days |
|---|---|---|---|---|---|---|---|---|---|---|
| consistency | SPY | 1109 | 9 | 1 | 1 | 0 | 1 | 0 / 1099 / 1 | 104 / 222 / 877 ($7.13) | 538 |
| consistency | QQQ | 1109 | 9 | 0 | 0 | 0 | 1 | 0 / 0 / 1100 | n/a | 573 |
| consistency | IWM | 1109 | 9 | 1 | 0 | 1 | 1 | 0 / 1098 / 2 | 321 / 432 / 666 ($1.89) | 534 |
| consistency | DIA | 1109 | 9 | 3 | 1 | 1 | 1 | 0 / 1098 / 2 | 797 / 830 / 268 ($4.62) | 565 |
| pass/fail | SPY | 1604 | 12 | 0 | 0 | 0 | 0 | 1300 / 292 / 0 | 1368 / 1383 / 209 ($0.58) | 798 |
| pass/fail | QQQ | 1604 | 12 | 0 | 0 | 0 | 0 | 1295 / 23 / 274 | 1318 / 1318 / 0 ($0.00) | 802 |
| pass/fail | IWM | 1604 | 12 | 0 | 0 | 0 | 0 | 1212 / 379 / 1 | 1392 / 1411 / 180 ($0.62) | 801 |
| pass/fail | DIA | 1604 | 12 | 1 | 0 | 0 | 0 | 1261 / 331 / 0 | 1482 / 1489 / 103 ($0.67) | 848 |

VIX (FMP prior-day close): 2,778 closes; 0 of 2,692 full sessions without a prior-day VIX.

Reading:
- **Minute bars, prior closes, half days and VIX are fine** (at most 3 missing bars per ETF per window; those
  days are skipped and counted, D7).
- **The "ex-div days" column is wrong as a count** (538-848 a window, where these ETFs pay 4 times a year, DIA 12). It counts
  every day where the one-day factor is below 1, which picks up rounding in Alpaca's adjusted closes. The run must
  treat a day as ex-dividend only when the factor implies a real dividend (at least half a cent a share,
  i.e. (1 - factor) x prior close >= 0.005). Fixed in `dividendFactor` (Oct 25): a factor implying under half a cent a share is treated as 1. A bug fix in the D1 code, not a rule change.
- **D2, pass/fail window:** the daily bar's close differs from the auction print by more than $0.01 on 6-13% of
  days (max $0.58), so **the daily close is not used in place of the auction print** (as D2 said). QQQ has no
  primary print on 274 days; those use the daily close, counted (as D2 said).
- **D2, consistency window (2016-2020): not usable as is.** No condition-M prints exist before 2020; the largest
  condition-6 print on the primary exchange differs from the daily close by more than $0.01 on 79% of SPY days
  (max $7.13), and QQQ has no primary closing print at all. One of the two prices is wrong on those days. Rule 5
  (SPY positive in 2016-2020) and the robustness lines depend on it, so this must be settled **before the run is
  built**. A follow-up check (`--close-check`, no returns) compares both prices with the 15:59 bar's close on every
  mismatch day and lists which exchanges carry the closing-condition trades. Its result and Jose's decision on the
  close source for 2016-2020 go here, then the run is built.

**Close check (Jose's laptop, Oct 25, 2026; 1,258 Alpaca requests, 3.8 min; no returns).** On each mismatch day
(print vs daily close > $0.01), both prices against the 15:59 bar's close:

| window | ETF | mismatch days | nearer the 15:59 close: print / daily / tie | median distance: print / daily |
|---|---|---|---|---|
| consistency | SPY | 877 | 339 / 480 / 58 | $0.030 / $0.029 |
| consistency | QQQ | 0 (no primary print) | - | - |
| consistency | IWM | 666 | 260 / 343 / 63 | $0.020 / $0.020 |
| consistency | DIA | 268 | 121 / 122 / 25 | $0.030 / $0.030 |
| pass/fail | SPY | 209 | 143 / 54 / 12 | $0.030 / $0.060 |
| pass/fail | IWM | 180 | 101 / 76 / 3 | $0.030 / $0.040 |
| pass/fail | DIA | 103 | 63 / 37 / 3 | $0.040 / $0.050 |

- On a typical mismatch day both prices are a few cents from 15:59 and neither is clearly better (2016-2020), but
  **the large errors are all on the daily-bar side**: e.g. SPY 2020-03-12 print $248.11, daily $255.24, 15:59 close
  $248.10; DIA 2020-03-16 print $202.49, daily $207.11, 15:59 $202.43; IWM 2020-03-16 print $103.62, daily $105.51.
  The primary print is one or two closing trades at a single price (2 prints at the same price on every example).
- QQQ: before 2020 its closing-condition trades appear only on T (FINRA TRF) and P (Arca), never on Q (Nasdaq),
  so there is no primary print and D2's fallback (daily close, counted) applies to all 1,100 sessions.
- Reading (Claude, for Jose's decision): **keep D2 as written** - primary-exchange closing print, daily close only
  when there is none, counted. QQQ's 2016-2020 robustness line then runs entirely on daily closes and is flagged as
  such in the report.
- **Decided by Jose (Oct 25, 2026): keep D2 as written** - the primary-exchange closing-auction print, the daily
  bar's close only when there is none, counted. **QQQ 2016-2020 is flagged as running on daily closes.** The run
  is built (section 11); not run yet.

## 11. The run (built Oct 25, 2026; not run yet)
`npx tsx scripts/backtest/strategy-c.ts --run` writes `backtests/strategy-c/run/` (report.txt, summary.json,
trades.csv, RUN-LOCK.json). It runs once: the lock is written as soon as all the data is loaded and before any
return is computed; a second `--run` refuses. How the code reads the locked rules where the spec leaves a detail
open (fixed here before any result):
- **Lines:** C base on SPY, QQQ, IWM, DIA in both windows; on SPY only, in both windows: the $0.03 stress line,
  buy-and-hold, long/short, raw prior close (D1), 15:31 fill (D3), fractional (D4) and the 10-month average
  (section 6).
- **Per-trade return (rule 2, D9):** net P&L / the position's cost (shares x fill), in %. The account's daily
  return (P&L / equity before the trade) drives Sharpe, CAGR, drawdown and the yearly returns.
- **Official close (D2):** per trade, the report counts exits and prior closes that came from the daily bar. A
  line where more than half the exits use the daily bar is flagged (expected: QQQ 2016-2020). A half day's close
  (not at 16:00) always comes from the daily bar, so the session after a half day uses it as its prior close.
- **Skips (D7):** in this order: half day, no 15:29 bar, no 15:30 bar (15:31 on the D3 line), no prior close, no
  closing price; each is a 0-return session. A whole-share line with equity below one share would skip (counted).
- **Long/short:** short at the 15:30 open - $0.01, cover at the close + $0.01; SEC fee and TAF on the short sale;
  no borrow cost.
- **Buy-and-hold (D6):** SPY dividend-adjusted closes, from the window's first close (0 that day), every session.
- **10-month average (section 6):** SPY dividend-adjusted closes from Jan 2015 (so the filter exists from the first
  window); month m's last close above the average of the last 10 month-ends (m included) -> hold SPY in month m+1,
  else cash at 0; switches at the month-end close; no costs.
- **Years (D10):** a year's net account return compounds its daily returns; a year with no trade is 0, not
  positive. **VIX (D8):** the prior session's FMP close; a trade without one is listed as "no VIX".
- **Time in the market:** the share of sessions with a position (each held only 15:30-16:00).


## 12. Result (LOCKED run, Jose's laptop, Oct 25, 2026; ran once; `backtests/strategy-c/run/`)
**VERDICT: FAIL on all five conditions.** C does not go to paper. Per section 4, no rerun with changed rules,
windows or tickers.

| Pass rule (SPY, Jun 1, 2020 - Oct 16, 2026, base costs) | Value | |
|---|---|---|
| 1. Sharpe >= buy-and-hold | -0.502 vs 1.025 | FAIL |
| 2. Mean net return per trade > 0, t >= 2 | -0.0102% per trade, t = -1.26, n = 866 | FAIL |
| 3. Total net return > 0 at $0.03 | -13.69% | FAIL |
| 4. >= 4 of 6 years positive (2021-2026) | 1 of 6 (2022 +2.53%; 2021 -4.86%, 2023 -0.41%, 2024 -2.98%, 2025 -0.83%, 2026 -1.30%) | FAIL |
| 5. >= 2 of QQQ/IWM/DIA positive, and SPY 2016-2020 positive | 0 of 3 (QQQ -6.91%, IWM -17.13%, DIA -13.23%); SPY 2016-2020 +1.02% | FAIL |

| Line | Window | Trades | Win % | PF | Net | Sharpe | Max DD |
|---|---|---|---|---|---|---|---|
| **C base SPY (judged)** | pass/fail | 866 | 47.3% | 0.87 | -7.82% | -0.50 | 10.9% |
| C base QQQ | pass/fail | 877 | 48.3% | 0.91 | -6.91% | -0.38 | 11.3% |
| C base IWM | pass/fail | 817 | 47.5% | 0.79 | -17.13% | -0.98 | 21.3% |
| C base DIA | pass/fail | 852 | 45.2% | 0.77 | -13.23% | -1.01 | 16.0% |
| SPY $0.03 stress | pass/fail | 866 | 45.2% | 0.78 | -13.69% | -0.93 | 16.2% |
| SPY long/short (info) | pass/fail | 1,592 | 48.8% | 0.95 | -6.23% | -0.26 | 16.1% |
| SPY 15:31 fill (info) | pass/fail | 866 | 49.3% | 0.90 | -5.81% | -0.37 | 9.1% |
| SPY raw prior close (info) | pass/fail | 864 | 47.3% | 0.88 | -7.47% | -0.48 | 10.6% |
| SPY fractional (info) | pass/fail | 866 | 47.3% | 0.88 | -8.69% | -0.50 | 12.0% |
| **SPY buy-and-hold** | pass/fail | - | - | - | **+173.22%** (CAGR 17.1%) | 1.03 | 24.5% |
| **SPY 10-month average** (info, no costs) | pass/fail | - | - | - | **+95.38%** (CAGR 11.1%) | 0.88 | 25.5% |
| C base SPY | 2016-2020 | 609 | 48.6% | 1.02 | +1.02% | 0.08 | 8.2% |
| C base QQQ (daily closes, flagged) | 2016-2020 | 641 | 50.2% | 1.11 | +5.08% | 0.32 | 5.3% |
| C base IWM | 2016-2020 | 591 | 46.5% | 0.84 | -8.75% | -0.57 | 12.1% |
| C base DIA | 2016-2020 | 616 | 46.3% | 1.13 | +5.46% | 0.34 | 10.4% |
| SPY long/short (info) | 2016-2020 | 1,099 | 47.9% | 1.05 | +4.11% | 0.20 | 9.0% |
| SPY buy-and-hold | 2016-2020 | - | - | - | +63.15% | 0.70 | 33.8% |
| SPY 10-month average | 2016-2020 | - | - | - | +21.71% | 0.48 | 20.8% |

Reading (facts only):
- After the paper's sample (Jun 2020 on), the rest-of-day signal had no edge on any of the four ETFs at these
  fills; every robustness and information line in that window is negative. Inside the paper's sample (2016-2020)
  SPY was flat (+1.0%) and the long/short version, the paper's own rule, made +4.1% gross of borrow costs.
- By VIX: in 2016-2020 the high-VIX days (prior close >= 20) were positive for SPY, QQQ and DIA (+6.0 / +7.9 /
  +12.4bp a trade; IWM -3.0bp) and low-VIX days negative for all four; in the pass/fail window both buckets were
  negative for all four (SPY -1.2bp low, -0.7bp high). Not a rule, recorded because the paper ties the effect to
  dealer gamma, which matters more in stressed markets.
- Data: 0 of 866 judged exits used the daily-bar fallback (D2); QQQ 2016-2020 ran entirely on daily closes, as
  flagged. Skips: half days only (12), plus a handful of missing 15:29 bars.
- **Fallback (section 6):** SPY buy-and-hold made +173% in the pass/fail window; the 10-month average line made +95%
  with a similar max drawdown (25.5% vs 24.5%). It lost more than buy-and-hold in 2022 (-20.97% vs -18.18%) and
  gave up most of 2023 (+8.77% vs +26.18%); in 2016-2020 it cut the max drawdown from 33.8% to 20.8% but returned
  +21.7% vs +63.2%. On these windows the filter cost return and only reduced drawdown in the earlier one. Neither
  is a strategy under test.
