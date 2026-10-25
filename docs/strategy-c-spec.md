# Strategy C: rest-of-day momentum on SPY (LOCKED Oct 24, 2026)

BACKTEST ONLY. Rules as Jose wrote them (Oct 24, 2026). It replaces the RSI(2) idea, which never got a spec. Items
marked **[D#]** are Jose's decisions (section 9: D1-D15 approved as proposed, Oct 24, 2026, with his notes).
Locked before any result. Code: `scripts/backtest/strategy-c.ts` (probe now: coverage only, no returns; the run is
added after the probe's coverage is recorded here, D15), tests in `tests/strategy-c.test.mjs`. E's paper test
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
- **The "ex-div days" column is wrong as a count** (538-848 a window, where ETFs pay about 4 a year). It counts
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

