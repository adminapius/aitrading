# Ross audit ("Strategy R" research) - read-only

Status: **Done (Oct 25, 2026).** Step 1 trades collected, Step 2 run by Jose (cache only, `backtests/ross-audit/report.txt`), Step 3 findings and 2 hypotheses below. Nothing was built from them.

Nothing here changes Strategy E, runs a locked window, or touches the worker, Supabase or any live setting.
The E paper test (counting from Mon Oct 26, verdict at trade 30) is not affected.

## Caveats (read first)

- Every Ross number is **his own statement** in a YouTube recap, transcribed from YouTube's auto-captions. Times
  and prices are approximate ("about 7:05", "in at about 4.15"); some per-ticker P&L is derived from his running
  totals (marked "derived" in `notes`). Tickers misheard by the captions are marked with `?` or `confidence=low`.
- He trades **far larger size** than E's $2,000 account (5,000-30,000 shares; $10k-$60k days), with Lightspeed
  direct-access routing, hotkeys and a level-2/tape read that E does not have. His entries are often before 07:00
  ET or between E's scan times. A ticker-day he made money on is not evidence E could have.
- Survivorship: the recaps are what he chose to publish. Red-day recaps are published and were eligible for the
  sample (titles like "RED DAY RECAP" were not excluded), but only 1 of 38 sampled days is a red day for him.
- Five sampled rows are his $2,000 small-account challenge (flagged `SMALL ACCOUNT`); they are excluded from the Q4
  medians and the Q5 Ross day P&L.

## Step 1 - collection (Oct 25, 2026)

Source: Firecrawl `youtube-com` provider (`videos/channel_videos`, `video_details`, `video_transcript`), channel
`UCBayuhgYpKNbhJxfExYkPfA`. **Firecrawl credits used: about 585** (26 paid calls of 5 credits per capability; the
free `find-tools` and `bash` projections cost nothing).

Window: **Oct 14, 2024 - Oct 16, 2026**, the days the E replay's minute cache covers.

Sampling rule (fixed before any transcript was read):
- A recap is a video of 2-40 minutes whose title is not a watch list (`watch list`, `watching for`, `on watch`,
  `stocks I'm watching`) or a pure lesson (`How I ...`, `The Truth About ...`, `Stock Selection in ...`,
  `Forcing a Crash ...`). Red/loss titles are kept.
- Recaps are indexed newest to oldest from index 0 (FmDkfY71Rng, Oct 15, 2026); every index with `i % 15 == 0`
  is sampled. A sampled video with no trades (or that turns out not to be a recap) is recorded and replaced by
  index `i+1`.
- Plan B (add `i % 15 == 7`) was **not needed**: the first pass reached Oct 28, 2024 (index 555; index 570 is
  Oct 3, 2024, outside the window) with 110 traded ticker-days.

Deviation: index 450 ("Interactive Brokers IBKR Platform Review") was replaced by 451 on its title alone; its
transcript was not fetched.

Result, in `backtests/ross-audit/trades.csv` (one row per ticker per day; `row_type` = traded / passed / day):
- **110 sampled traded ticker-days on 38 trading days** (105 main account, 5 small account), **29 of them red**
  (he lost money on the ticker that day), 1 fully red day (Mar 25, 2025: -$17,372.37).
- **85 passes** with his stated reason, 6 `day` rows (no-trade or not-a-recap samples), and 8 `MENTIONED` rows (P&L
  he stated for a day other than the sampled one - kept for context, excluded from every question).
- His temperature words per day: hot 45 ticker-days, neutral 32, cold 28 (quoted in `temperature_quote`).

| idx | trading date | Ross traded | his day P&L | temp |
|---|---|---|---|---|
| 0 | 2026-10-15 | VBIO | 519 | cold |
| 15 | 2026-09-24 | APUS, PFSA | 2,992.62 | cold |
| 30 -> 31 | 2026-08-31 | AEHL (Sep 1: no trades) | 975.63 | neutral |
| 45 | 2026-08-12 | RMCF, OFAL, SPRC | 17,617 | neutral |
| 60 | 2026-07-27 | EDBL, VTIX? | 32,000 | neutral |
| 75 | 2026-07-14 | NXTC, JTI?, UBXG | 13,200.70 | hot |
| 90 | 2026-07-01 | DXST, CANF (small acct), GEM | 1,068.75 | hot |
| 105 | 2026-06-18 | CDT, WOK, CRVO, an IPO, ATPC | 2,900 | hot |
| 120 | 2026-06-02 | BJDX | 1,723.23 | cold |
| 135 -> 136 | 2026-05-06 | ERNA (May 7: no trades) | positive | neutral |
| 150 | 2026-04-15 | BIRD | 18,000 | hot |
| 165 | 2026-03-27 | ONCS, ARTL | 20,868.98 | cold |
| 180 | 2026-03-10 | INKT, VTAK, APVO, ATPC | 1,302.55 | cold |
| 195 | 2026-02-18 | SNSE | 9,373.32 | cold |
| 210 | 2026-01-26 | NVVE | 11,734.61 | neutral |
| 225 -> 226 | 2026-01-06 | ALMS, OPTX, ELAB | 7,549.61 | cold |
| 240 | 2025-12-17 | MBRX, PCSA | 12,500 | cold |
| 255 | 2025-11-26 | SPRC, AMBR | n/a | cold |
| 270 | 2025-11-03 | PHIO, NCRA, THAR | 11,697.67 | neutral |
| 285 -> 286 | 2025-10-13 | STI, ATON, CHNR, NDRA | 18,668 | neutral |
| 300 | 2025-09-22 | AGRI, QLGN, BOXL (small acct) | 3,149.40 | hot |
| 315 | 2025-09-02 | SHFS, ADN | 9,943.25 | neutral |
| 330 | 2025-08-13 | BSLK, ATNF | 19,967.50 | cold |
| 345 -> 346 | 2025-07-25 | LHAI, SWVL?, PHIO, ATNF, MCVT, one unnamed | ~15,000 | hot |
| 360 | 2025-07-01 | CLRO, BMNR, BGLC, SNGX, TRNR, VVOS, WTO | 51,000 | hot |
| 375 | 2025-06-10 | MEGL, EVGN, JELS? | 36,000 | hot |
| 390 | 2025-05-21 | SYTA, EDBL, ASST, SGMA, ZKIN | ~11,072 | neutral |
| 405 | 2025-04-30 | STSS, JTAI, SAGT | ~13,263 | cold |
| 420 -> 421 | 2025-04-09 | VERO, FMTO | 35,347.34 | hot |
| 435 | 2025-03-25 | TN?, KBSX, POAI, BLNE, DATS, ALMS, MGRX | **-17,372.37** | neutral |
| 450 -> 451 | 2025-03-11 | SNOA, MNTS | 2,926.44 | cold |
| 465 | 2025-02-26 | SYTA, MULN | ~49,535 | hot |
| 480 | 2025-02-10 | PNBK, NLSP, CDT, BDRX | n/a | neutral |
| 495 | 2025-01-21 | TPET, NXXT?, INM, XTIA, BTCT | 20,802.60 | hot |
| 510 | 2024-12-31 | VRME, APM, MLGO | ~33,798 | hot |
| 525 | 2024-12-06 | UPC, ZBAO, ALBT | 23,952.98 | hot |
| 540 | 2024-11-12 | SAI?, LEDS, FOXO | n/a (small green) | cold |
| 555 | 2024-10-28 | EVOK, AMIX, SPGC | 47,646 | hot |

## Step 2 - audit against the E replay's cache (run Oct 25, 2026)

Script: `scripts/backtest/ross-audit.ts` (tests: `tests/ross-audit.test.mjs`). Cache only by default; it reads the
E replay's universe, minute bars, RVOL baselines, news and quotes from `.cache/backtest`, and E-current trades from
the locked E-J runs (`backtests/strategy-ej/{tuning,holdout}/trades.csv`). It writes only `backtests/ross-audit/`
`q1q2.csv`, `q3.csv`, `q4.csv`, `q5-daily.csv` and `report.txt`.

```
npx tsx scripts/backtest/ross-audit.ts --csv=backtests/ross-audit/trades.csv --ej=backtests/strategy-ej --out=backtests/ross-audit
```

How each question is answered:
- **Q1** - Ross's entry minute is his stated time, else the first minute (04:00-11:00) whose bar range holds his
  stated entry price. It is checked at E's last scan at or before that minute (E scans 07:00-08:00 every 15 min,
  then every 5 min, entries until 11:00; earlier entries are checked at 07:00). "In the scanner" = in E's top-25
  % gainers at that scan, scanner-eligible (price, volume, dollar volume) and on E's float list (float <= 10M and
  day gain > 2%). If the ticker is not in E's day set at all, the daily reason is given (not in the universe,
  daily volume, day high < $1, day gain < 10% with float unknown or > 10M). Also: was it ever eligible at any E
  scan 07:00-11:00, and did E trade it that day.
- **Q2** - at that scan: every E entry gate that fails (the same terms as `decideEntry`: RVOL, VWAP, volume,
  dollar volume, spread, float, news in 24h, ATR, score, size >= 1 share), then the quote and the clean-momentum
  filter (gain 20-30%, price >= $3, spread <= 0.5%, regime). The first blocking reason is counted. Portfolio state
  (3 slots, daily loss limit, cooldown) is ignored, so "E would enter" means "if a slot was free". A quote E never
  asked for is reported as "not cached" (`--fetch` would fetch it, read-only).
- **Q3** - every E-current trade on Ross's days, whether Ross traded that ticker, and his pass reason if he named it.
- **Q4** - medians at entry, Ross (main account) vs E on the same days: float, % gain, RVOL (E's baseline, only
  from 07:00 and only for top-25 names), price, time of day, news age (Alpaca news feed only), halt-like gaps
  (>= 6 minutes without a bar in regular hours before entry), first-5-minute volume (09:30-09:35), and whether a
  premarket entry was above every earlier premarket high.
- **Q5** - for every trading day in the window: stocks whose high from 04:00 to before 10:00 ET is >= +50% over
  the prior close on >= 10M shares since 04:00 (from E's gainer pool, so only names up >= 10% on the day can
  count). Bucketed against E-current's daily P&L (all days) and Ross's stated day P&L and hot/cold word (sampled
  days only), with simple correlations.

## Step 3 - findings

From `backtests/ross-audit/report.txt` (per-row detail in `q1q2.csv`, `q3.csv`, `q4.csv`, `q5-daily.csv` on Jose's
laptop). E here is **E-current from the locked E-J replay**: 66 trades in 504 days, $2,000 compounding.

**1. A third of what Ross traded does not exist in our replay data (data issue, not a strategy finding).**
34 of 110 ticker-days are "not in the universe". The universe is Alpaca's asset list as it is today
(known issue U1 in `docs/backtest-known-issues.md`): tickers that were since renamed, delisted or reverse-split
into a new symbol are missing. Ross's names are exactly that kind of stock. Every E backtest so far is blind to
them, and any test of a Ross-like rule would be biased (the names that later died are the ones missing).

**2. Of the 76 that are in the data, E's scanner and filters see few, and E traded none.**
- First blocking reason at the scan at or before his entry: not in E's top-25 gainers 15; **RVOL baseline unreliable
  12**; no trades yet at that scan 10; E filter `gain_range` (day gain outside 20-30%) 6; entry time unknown 6;
  not in E's day set for daily reasons 13; scanner minimum 4; float > 10M or unknown 3; price not above VWAP 3;
  RVOL too low 2; no minute bars 1; ticker not named 2.
- 46 of 110 were scanner- and float-eligible at some E scan 07:00-11:00; **E traded 0 of Ross's tickers** on his days.
- "RVOL baseline unreliable" means the stock averaged under 10,000 shares by that time of day over the prior 10
  sessions. Ross's best names are dormant until the news hits (SNSE traded 9,000 shares the day before), so E's
  rule that the RVOL baseline must be "reliable" removes them by design.
- **Q2 limitation:** Q2 ignores portfolio state (3 slots, loss limit), so "E would enter" is optimistic; no row
  reached that point anyway.

**3. Q3: on Ross's 38 days E made 5 trades, none in his tickers, together -$48.33.** None of the 5 were names
he said he passed on; they were simply not on his radar.

**4. Q4: Ross's trades are a different kind of trade from E's** (Ross main account n=53; E n=5, too few to compare
carefully):

| at entry (median) | Ross | E |
|---|---|---|
| float | 1.56M | 5.36M |
| day gain | +58.6% | +25.4% (E's filter is 20-30%) |
| price | $4.61 | $21.28 |
| time | 07:46 ET | 09:45 ET |
| RVOL (E baseline, where available) | 10.1 (n 13) | 7.2 |
| news age (Alpaca feed) | 78 min (n 30) | 93 min |
| first-5-minute volume 09:30-09:35 | 1.51M | 0.42M |
| premarket entry above all earlier premarket highs | 36% of 39 | 0% of 1 |
| halt-like gaps before entry | 0 | 0 |

He buys earlier (pre-market, around 07:00-08:30), in smaller floats, cheaper stocks, already up much more, on
stocks with far more volume at the open. E's 20-30% gain band and its RVOL-reliability gate exclude most of that.

**5. Q5: the count of "big movers" does not explain either P&L.** Stocks up >= 50% on >= 10M shares by 10:00 ET
were almost always present (0 on only 3 of 504 days; 373 days had 3 or more). Correlation of that count with
Ross's day P&L: 0.03 (34 days); with E's day P&L: 0.07 (504 days). E made money mainly on 5+ days ($1.02 a day;
noise at this size). Ross's own word tracks his own P&L (median day: "hot" $28,875, "neutral" $11,698, "cold"
$2,993) more than this count (median count 4, 5, 3). His "hot/cold" is partly a description of his own results,
so it cannot be used as an independent market signal.

Caveats again: his numbers are self-reported; his entry minutes are stated or inferred from his stated price;
his size and execution (Lightspeed, hotkeys, tape reading) are not E's; only 1 of 38 sampled days was red.

## U1 rerun (Q1/Q2 only, cache only; Jose's laptop, Oct 25, 2026)
`npx tsx scripts/backtest/ross-audit.ts --u1 --only=q1q2 --out=backtests/ross-audit/u1` (universe 15,342 symbols on
the first U1 probe; 1,202 entities added; none of the later filter changes touches a Ross ticker).
- "Not in the universe" fell from 34 rows to 8: **26 found as delisted entities** (EVOK, SPGC, ALBT, VRME, APM, NLSP,
  SYTA x2, MULN, POAI, DATS, VERO, FMTO, STSS, SGMA, WTO, ATNF x2, ADN, AGRI, QLGN, ATON, THAR, SNSE, VTAK, UBXG),
  **0 through a rename, 8 still missing** (SAI?, FOXO, TN?, JELS?, BSLK, NVVE, ONCS, JTI; "?" = low-confidence
  caption ticker).
- E traded the same ticker on the same day: still 0 of 110. First blockers for the 26 newly found: not in E's top 25
  gainers at the scan 5, RVOL baseline unreliable 4, no trades yet at the scan 3, float over 10M or unknown 3, Ross
  entry time unknown 3, not in E's day set 5, scanner minimum 2, quote not cached 1.
- All 110: not in the top 25 at that scan 20, RVOL baseline unreliable 16, no trades yet 13, Ross entry time unknown
  9, not in the universe 8, others 44. Ever scanner- and float-eligible at an E scan 07:00-11:00: 57 of 110.
- Reading: U1 closes most of the survivorship gap for Ross-type names; it does not change the audit's finding that
  E's filters (top-25 rank, RVOL baseline, 20-30% gain, $3 floor) exclude them.

## Hypotheses for a future locked test (not built)

Both require fix U1 (delisted and renamed tickers in the universe) **first**; otherwise a third of the relevant
stocks are missing and the test is biased toward survivors.

- **H1 - who:** E's scanner admits Ross-type stocks: float <= 5M, price $2-20, breaking news within 2 hours, day
  gain >= 20% with no upper cap, and an absolute volume floor (for example >= 500,000 shares so far) in place of the
  RVOL-reliability gate. Same stops, targets, sizing and costs as E. The question: is expectancy positive at E's
  fill model, or is Ross's edge his execution and size?
- **H2 - when:** the same entries, but only at scans from 07:00 to 09:30 ET (Ross's median entry is 07:46; E's is
  09:45), compared with the same rules 09:30-11:00.

Each would need its own locked spec (windows, pass rule, costs) before any result is seen. Neither changes E's
paper test.
