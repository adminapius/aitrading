# Backtest known issues (recorded Oct 24, 2026; not fixed)

Data issues found while specifying E-J $3-10 (docs/strategy-ej-310-spec.md, section 0.3). They apply to every
backtest in `scripts/backtest/` built on `buildUniverse` / `getAssets` (E replays, E-J, SW, H v2, F, the rulebook
strategies). Not built; fix before any future backtest that needs a clean universe. Live trading is not affected.

## 1. Universe is missing delistings (survivorship), mostly after Oct 2022
- The universe is Alpaca's asset list as it is today (`getAssets`: active + inactive, cached once), the same for
  every window. Its inactive symbols by last daily bar: 412 in Oct 2021 - Oct 2022, 10 in Oct 2022 - Oct 2023, 4 in
  Oct 2023 - Oct 2024.
- FMP's delisted list (listed exchanges, window Oct 14, 2021 - Oct 11, 2024): 3,302 symbols; 280 in the universe
  under the same symbol; 3,022 missing (515 / 1,407 / 1,100 by year). The FMP list includes preferreds, units,
  warrants and some funds, so the common-stock gap is smaller, but after Oct 2022 almost no delisting is present.
- **Fix U1 - built Oct 25, 2026 (opt-in; `scripts/backtest/u1-delisted.ts`, tests `tests/u1-delisted.test.mjs`).** No existing
  script turns it on, so the locked runs and their caches are unchanged. Probe: `npx tsx scripts/backtest/u1-delisted.ts --probe`
  (counts: FMP delisted commons, Alpaca bars under the old ticker with `asof`, EDGAR CIK by old name; writes
  `backtests/u1/entities.csv`, `renames.csv`, `probe.json`). Also added: FMP symbol changes, so an old ticker used
  before a rename resolves to the new symbol (Alpaca keeps the history under the new one). First user: the Ross audit
  (`ross-audit.ts --u1 --only=q1q2`).
- **U1 results (Jose's laptop, Oct 25, 2026; history Aug 18, 2024 - Oct 16, 2026, the E replays' history):**
  - FMP delisted, listed exchange, inside the history: 2,632. Dropped as preferred / unit / warrant / right / note /
    fund: 1,384; duplicates 27; already in the universe under the same ticker 37. **To add: 1,184 commons; 1,117
    added with Alpaca daily bars under the old ticker; 67 with no Alpaca data** (mostly OTC-style or renamed
    symbols, e.g. EMI, RAN, FSLUF, LAZY). Universe 14,140 -> 15,257 symbols; 1,073 added entities trade on or after
    Oct 14, 2024 (delisted 2024: 185, 2025: 469, 2026: 463). FMP symbol changes in the history: 779.
  - EDGAR company by old name (SEC cik-lookup-data, former names included): 885 unique name match, 124 shared name
    resolved by filing dates, 24 ambiguous, 84 no name match (1,093 of 1,117 = 97.9% with a CIK, 885 + 124 = 1,009
    resolved to one).
  - The first probe showed mutual funds (5-letter X), Nasdaq preferreds (5th letter M/N/O/P) and FMP's class-share
    spelling (CWEN-A) slipping through; fixed before the second probe (numbers above). The second probe's entity
    list still held 19 closed-end and ETF trusts named without "Fund" (e.g. "MFS High Income Municipal Trust",
    "Bitwise Funds Trust") and a few exchange-listed notes (e.g. OPINL); the names are now dropped too (Oct 25).
    None of them can reach a +20% day, so no R or Ross-audit count changes; the counts above are the second probe's.
  - **Ross audit Q1/Q2 rerun with U1 (cache only):** of the 34 sampled Ross ticker-days missing from today's
    universe, **26 are now found as delisted entities, 0 through a rename, 8 still missing** (3 of them low-confidence
    caption tickers: SAI?, TN?, JELS?; plus FOXO, BSLK, NVVE, ONCS, JTI). E still trades none of Ross's 110
    ticker-days; for the 26 newly found, E's first blockers are the same as before (not in the top 25 at its scan
    5, RVOL baseline unreliable 4, no trades yet at the scan 3, float over 10M or unknown 3, Ross entry time unknown
    3, others 8). Details: docs/ross-audit.md, "U1 rerun".
- Original proposal: add FMP's delisted common stocks (drop preferreds `-P*`, units, warrants,
  rights, funds) to the universe as delisted; load their daily and minute bars from Alpaca under the old ticker
  and count those with no Alpaca data; map each to its EDGAR company by the old company name (SEC's
  cik-lookup-data / former names), not today's ticker map, so reused tickers resolve to the right company. A probe
  step counts how many have Alpaca bars before anything runs.

## 2. Float on the trade date (E and E-J only)
- The replay only lets a stock be entered with a float value (`market.ts`: `float != null && float <= 10M`), and
  its float sources (FMP current float, 12-quarter history, daily market cap x today's free-float %) list only
  companies that trade today: delisted stocks could never be entered; live stocks used today's float.
- Point-in-time EDGAR shares outstanding (`scripts/backtest/edgar-float.ts`, built Oct 24, tested) covered 61.6% /
  66.1% / 69.9% of enterable stock-days by year (domestic 72-82%, foreign 38-48%). Missing: new listings before their
  first 10-Q / 20-F (1,556 stock-days), multi-class companies whose cover counts are per class and not in the
  companyconcept API (part of no-value 1,110), stale values, counts dated before the first daily bar, name
  mismatches (renamed companies; matching on SEC's former names would reduce these), no CIK.
- Shares outstanding >= float, so it is a stricter gate than live E's FMP float [approximate].

## 3. ADR share counts
- A 20-F / 40-F cover page reports ordinary shares, not ADSs. With ratios such as 1 ADS = 10 or 100 shares, the
  share count is not comparable to the tradable ADS count, so a 10M gate means something different for ADRs (even
  where a foreign value exists). A fix needs each ADR's ratio on the trade date (depositary data), or excluding
  ADRs / foreign filers from a test, decided before any result.

## 4. Smaller notes
- 08:00 ET premarket flush: real prints on exchange D; the backtest fills a stop on any touch (worst case), live E
  checks the bid every 15 s (docs/strategy-ej-spec.md, section 11).
- Some SEC companyconcept responses are `units: {shares: {}}` (an empty object): read as no data.

## Parked strategies (failed their locked tests; no paper test; any follow-up is a new locked spec)
Code archived Oct 25, 2026 (not deleted): runners in `scripts/backtest/archive/` (C, R, E-J, E-J $3-10) and
`scripts/backtest/archive/rulebook/` (F, SW, H v2 `swing-v2`); their tests in `tests/archive/` (not part of `npm test`;
run with `npx tsx --test tests/archive/*.test.mjs`). Shared tools stay in place: U1, EDGAR float, the fill and halt
models (`scripts/backtest/fill-halt-models.ts`), the E-J/E replay engine (`ej-engine.ts`), the fill audit
(`rulebook/audit.ts`), and the shared windows (`scripts/backtest/windows.ts`). Run-lock files on the laptop
(`backtests/*/RUN-LOCK.json`) are untouched.
- **R (Ross-type H1 / H2 / H3), FAIL and final, Oct 25, 2026** (docs/strategy-r-spec.md, section 12): Ross-type
  selection plus a 1-minute pullback trigger: win rate 31% vs 33% needed for 2R; pre-market worst.
- C (rest-of-day momentum, SPY), FAIL and final, Oct 25, 2026: docs/strategy-c-spec.md, section 12.
- E-J, holdout FAIL, Oct 24, 2026: docs/strategy-ej-spec.md.
- E-J $3-10, parked Oct 24, 2026 (no clean out-of-sample data): docs/strategy-ej-310-spec.md.
- SW, holdout FAIL, Oct 24, 2026: docs/strategy-sw-spec.md, section 13.
- H v2, FAIL, Oct 19, 2026: docs/h-v2-spec.md.
- F, FAIL, Oct 19, 2026: docs/strategy-f-spec.md, section 13.
