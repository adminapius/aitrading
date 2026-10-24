# Strategy E-J $3-10 (DRAFT, Oct 24, 2026; not locked)

BACKTEST ONLY. Rules as Jose wrote them (Oct 24, 2026). Items marked **[D#]** are open decisions (section 9), each
with a proposed default. No code, no download and no results until Jose approves and the spec is locked. Live
Strategy E and its paper test (counting from Mon Oct 26, 2026) are not touched.

## 0. Read before approving
### 0.1 Data coverage for Oct 14, 2021 - Oct 11, 2024 (asked: confirm before writing the spec)
**Not fully covered.** By source:

| Data | Covers 2021-2024? | Note |
|---|---|---|
| 1-minute SIP bars (Alpaca) | Source yes; **cache no** | The E-J runs cached Aug 2024 onward (57-day lookback before Oct 14, 2024). The whole window is a new download; the probe sizes it. |
| Daily bars, 15-minute RVOL baselines, Alpaca news, historical NBBO quotes | Yes (Alpaca, from 2016) | New download, same code. |
| Universe incl. delistings (Alpaca asset list, active + inactive) | Mostly | Delisted symbols are in the universe and get bars. Not checked: symbols whose ticker was later reused by another company (the old company's history is not under that ticker). |
| **Float (E's float <= 10M gate)** | **No** | See below. |

**The float gap is the real problem, and it already applies to every E replay so far.** The replay only lets a
stock be entered when it has a float value (`market.ts:130`: `float != null && float <= 10_000_000`). All float
sources are lists of companies that trade today:
- current float (FMP `shares-float-all`): live companies only, so **every delisted symbol has no float and can never
  be entered**; for live companies it is today's float, not the float on the trade date;
- quarterly history (FMP `enterprise-values`, `limit=12`): only the last 12 quarters, about late 2023 onward;
  before that it falls back to today's float;
- daily (FMP market cap / close x today's free-float %): needs today's free-float %, so again live companies only.

For a 2021-2024 window this matters much more than for 2024-2026: many 2021-2022 small-cap gainers (SPACs, meme
names) have since delisted, and the survivors' floats changed a lot through dilution and reverse splits. So as the
code stands, the window would test mostly survivors, with floats from the wrong years. **[D1]** proposes a fix.

**Earliest fully covered window:** none, as the code stands: the delisted-float gap exists for every window, and
point-in-time float exists only from about late 2023 (too short: E-current took 36 $3-10 trades in 21 months of
tuning, so one year would give about 20, under the 30 required). With D1's fix the data reaches back to 2021, and
the probe checks the coverage by year before anything is locked **[D2]**.

### 0.2 What the existing E-J results already say about $3-10 (information, not a decision)
The range was picked from the **holdout** (13 trades), not from tuning. In tuning (Oct 14, 2024 - Jul 31, 2026,
`backtests/strategy-ej/tuning/trades.csv`, same entries) the $3-10 trades went the other way:

| Tuning, same entries | $3-5 | $5-10 | $3-10 total |
|---|---|---|---|
| E-current (flat 15:55) | 25 trades, +5.7R / +$136, PF 1.47 | 11 trades, -5.3R / -$94, PF 0.26 | 36 trades, **+0.4R / +$43** |
| E-J without adds | 25 trades, +1.8R / +$75, PF 1.13 | 11 trades, -5.4R / -$95, PF 0.18 | 36 trades, **-3.6R / -$20** |

(The adds lost $11.54 in tuning, as Jose noted.) On those 36 trades, E-J without adds would have failed this
pass rule: it lost money, and E-current beat it in R and dollars. Both E-J windows are now used, so the 2021-2024
window is the only fresh test, as Jose set. This is why the info-only run on the Aug-Oct 2026 holdout is not judged.

## 1. Rules (as Jose wrote them)
- **Base: E-J without adds.** Everything else exactly as E-J (docs/strategy-ej-spec.md, sections 1-4 and 10): E's
  entries and sizing, the scan schedule (every 15 min 7:00-7:45, every 5 min from 8:00), sell 1/3 at fill + $0.50 and
  move the stop to breakeven, sell 1/3 at fill + $1.00, the runner exits on a 5-minute close below VWAP, flat by
  15:30, the SP slippage, fees and the same volume caps. No adds.
- **The one change: the entry price must be $3.00 to $10.00 [D3].**
- Why: the fixed +$0.50 / +$1.00 scale-outs are about 0.5-1.5 ATR on $3-10 stocks; above $10 they are often worth
  less than 0.3R.

## 2. Runs
- **E-J $3-10** (judged).
- **E-current $3-10** (the comparison): E's bracket (stop fill - 1 ATR, target fill + 1.5 ATR), the same $3-10
  filter, flat at **[D5]**.
- Same entries for both **[D4]**.
- Information lines (not judged): E-current $3-10 flat at the other time in D5.

## 3. Windows
- **Fresh window: Oct 14, 2021 - Oct 11, 2024, run once, its own lock file** (`backtests/strategy-ej-310/fresh/`),
  subject to D2. Same universe rules, delisted symbols included. The 57-day lookback reaches back to mid-Aug 2021
  (ATR and RVOL baselines only). E-J tuning's own lookback reached into Aug-Oct 2024 for baselines only; no E-J
  trade is in this window.
- **Information only: Aug 1 - Oct 16, 2026** with the same filter (`backtests/strategy-ej-310/info-holdout/`),
  run once after the fresh window, not judged (the range was chosen from it).

## 4. Pass rule (fresh window; locked before any result)
E-J $3-10 passes only if all hold:
1. at least 30 trades;
2. expectancy > +0.1R;
3. PF > 1.3;
4. positive dollars;
5. beats E-current $3-10 in total R **and** in total dollars (same entries, same window).

A pass -> a fresh 30-trade locked paper test on Alpaca, run next to E **[D11]**; it does not replace E until that
test passes. A fail -> parked; nothing changes.

## 5. Report (each window, each run)
All runs; the $3-5 vs $5-10 split **[D6]**; trades, win %, average win and loss, expectancy, PF, total R and $;
largest loss; max drawdown in R and $; the exit breakdown; results by month (and by year for the fresh window);
the 08:00 exit count **[D7]**; scale-out hit rates; entry blocks, including the count blocked by the price filter;
float source and coverage counts **[D1]**.

## 6. Costs and fills
Exactly as E-J (D6/D7 there): SP slippage 0.5% (1% before 9:30) on market-type fills; scale-outs as limits on a
1-tick trade-through; worst case inside a bar; SEC fee and FINRA TAF; 1% of the day's volume so far and 10% of the
bar. One cost model for both runs.

## 7. Data and run order
1. Probe **[D2]**: per year, trading days, gainer-pool symbol-days, entry candidates, the share with a float value
   (live vs delisted, by source), minute-cache coverage, and a timed 3-day sample with a full download estimate. No
   trades.
2. Fresh window, once.
3. Info holdout, once.
Downloads pause 06:45-16:05 ET on weekdays, as before.

## 8. Code (after lock)
Reuse `scripts/backtest/ej-engine.ts` (mode 'EJ-noadd', and 'E') unchanged. New runner
`scripts/backtest/strategy-ej-310.ts` (its own windows, filter, lock files and report); `strategy-ej.ts` is not
changed (its runs are locked and recorded). The D1 float source is a new data module, with tests.

## 9. Open decisions (proposed defaults in bold)
- **D1 Float on the trade date, delisted included:** **use SEC EDGAR's shares outstanding as the float for every
  symbol, live or delisted: the cover-page value (`dei:EntityCommonStockSharesOutstanding`) of the latest 10-Q /
  10-K / 20-F filed before the trade date, adjusted for splits between that date and the trade date. Tagged
  [approximate].** EDGAR keeps filings for delisted companies, so this removes the survivor bias, and it is point
  in time. Trade-off: shares outstanding >= float, so the <= 10M gate is somewhat stricter than live E's FMP float
  (a few stocks with more than 10M shares but under 10M float are missed). A symbol with no EDGAR value has no
  float and is not entered, as now, and is counted in the report. Alternatives: (b) FMP daily market cap / close x
  today's free-float % (point in time for live companies only; delisted stay out); (c) keep the current replay
  float (today's float; delisted stay out), and state the bias.
- **D2 Window and coverage check:** **Oct 14, 2021 - Oct 11, 2024 as Jose set, if the probe shows at least 90% of
  each year's entry candidates (gain > 2%, price >= $3) with a D1 float value, live and delisted counted separately.
  If a year falls short, the window starts at the first year that meets it, and the spec records it before lock.**
- **D3 Price filter:** live E cannot know the fill price before it sends the order. **Filter on the ask at the
  scan (the price E sizes and sends from): $3.00 <= ask <= $10.00. Fills that land outside $3-10 after slippage are
  kept and counted in the report.** Alternative: filter on the fill itself (backtest-only; not something live can do).
- **D4 Same entries:** **as E-J D5: the E-current $3-10 portfolio run (3 slots, E's sizing, cooldown, 4% daily
  loss limit) fixes the entry list, and E-J $3-10 manages exactly those entries. The filter applies before slots,
  so a $10+ stock never takes a slot.** An E-J-own-slots information line, as before.
- **D5 E-current flatten time:** live E flattens at 15:30 since Oct 24, 2026. **E-current $3-10 flattens at 15:30
  (as live E now), with a 15:55 information line.** (E-J's D1 used 15:55 because live E did then.)
- **D6 Price bands:** **$3-5 = $3.00 to $4.99, $5-10 = $5.00 to $10.00, by the entry ask.**
- **D7 08:00 exit count:** **news-regime trades still open at 08:00:00 ET, and how many of them exited between
  08:00:00 and 08:00:59, by exit type.**
- **D8 Start equity:** **$2,000 compounding, as E-J.**
- **D9 Year split:** **report each year (Oct-Oct) separately as information; no pass condition per year.**
  2021 includes the SPAC and meme-stock peak.
- **D10 Probe first:** **the probe runs and its coverage is recorded in this spec before lock.**
- **D11 Paper test if it passes (decided now, so the rule is locked before results):** E-J $3-10 takes the same
  entries as E, so it cannot share E's Alpaca paper account (the second buy of the same stock is blocked, and the
  two would manage the same shares). **A second Alpaca paper account (its own keys and ledger), with its own fresh
  30-trade locked test, pass rule and fill audit set before it starts.** Alternative: run it as a shadow on E's
  entries (no fills; weaker evidence).
