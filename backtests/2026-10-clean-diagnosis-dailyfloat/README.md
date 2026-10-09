# Strategy E — diagnosis period (2026-04-08 to 2026-07-31) with daily point-in-time float

Run: `BACKTEST_PIT_FLOAT=daily … --runs=E --sim-from=2026-04-08 --sim-to=2026-07-31`. Feed: Alpaca SIP. Validation period not touched.

## Float method

- `shares_outstanding(date) = FMP /stable/historical-market-capitalization(date) ÷ Alpaca SIP raw daily close(date)`
- `float(date) = shares_outstanding(date) × current freeFloat% from /stable/shares-float-all`
- The decision day uses the latest trading day strictly before it, at most 7 calendar days old (no same-day close lookahead).
- Fallback order: daily, then quarterly enterprise-values scaling of current float, then current float.
- The brief's path `/stable/historical-market-cap` returns HTTP 404 (also for AAPL); FMP's stable path is `historical-market-capitalization`.

**Limitation:** float = estimated from daily historical market cap ÷ close × current free-float %. Free-float % is today's value, so insider or lock-up changes during the period are not captured.

## Comparison

| Float source | Trades | Wins | P&L |
|---|---:|---:|---:|
| Current float | 31 | 19 | $196.61 |
| Quarterly point-in-time | 34 | 20 | $183.12 |
| Daily point-in-time | 35 | 18 | $141.57 |

Daily vs quarterly:
- Added: CING 06-02 (−$13.48), ELMT 06-01 (+$28.23), GLND 04-27 (−$19.36), SHAZ 06-17 (−$10.52), VRAX 07-16 (−$2.10)
- Removed: GDC 05-06 (−$19.70), VCIG 05-27 (+$29.23), VEEE 07-16 (+$1.69), VEEE 07-17 (+$11.44)
- Same trade, different P&L (sizing/sequence effects): EDSA 04-28, HQ 06-15, BIRD 06-17

Daily vs current:
- Added: CING 06-02, GLND 04-27, MNTS 04-13, MNTS 04-15, MNTS 05-11, QUCY 05-21, SHAZ 06-17, VRAX 07-16
- Removed: GDC 05-06, VCIG 05-27, VEEE 07-16, VEEE 07-17

## Coverage (3,749 candidate symbols; full detail in `float-coverage.json`)

- Quarterly: 3,487 with history, 262 empty, 0 failed first pass, 0 still failed. The previous 48 failures all downloaded with retries.
- Daily market cap: 3,734 with data, 15 empty, 64 failed first pass, 0 still failed.
- 66 symbols with daily data have no free-float % in FMP, so they fall back to quarterly.
- 18 symbols have neither usable daily data nor quarterly history and use current float: ATTT, BTLN, CCHH, COPR, CXII, DRK, EOCN, FGC, FRNM, HLSQ, PAAI, SAIQ, SVIA, VAI, VLOS, WATR, XTND, YFOR.
- The 262 symbols with no quarterly history (mostly ETFs/ETNs and new listings) are listed in `float-coverage.json` under `quarterly.empty`.
