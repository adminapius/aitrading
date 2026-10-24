# Strategy S & SP rulebook backtest (backtest only)

Implements "Strategy S & SP — Day Trading Rulebook" (Oct 14, 2026) with Jose's approved decisions. Nothing here
touches live or paper order execution; the live worker never imports these files.

| File | What it does |
| --- | --- |
| `config.ts` | **Every rule parameter.** Change values here only. `[adapted]` items are tunable (tuning window only). |
| `data.ts` | Universe (active + delisted, raw prices), S daily list at 9:00 ET, SP daily superset, minute bars (cached per symbol/day), 15-min RVOL baselines, news. |
| `strategy-s.ts` | S (long only): 15m gate, Setup A (MA bounce), Setup B (breakout / retest), stops, 5m exit facts. |
| `strategy-sp.ts` | SP: minute scanner (top 3), 5m gate, Setup 1, Setup 2, smart stop, 5m exit facts. |
| `engine.ts` | Account rules, sizing, fills (approved model), stops held internally, scale-outs, R-trail, exits, fees. |
| `report.ts` | trades.csv, summary.json, report.html (equity curve, month/setup/exit breakdowns, pass/fail per window). |
| `strategy-f.ts` | Strategy F (opening-range reversal + FVG), spec `docs/strategy-f-spec.md`; `strategy-f-probe.ts` = its data probe. |
| `strategy-sw.ts` | Strategy SW (swing, by the course), spec `docs/strategy-sw-spec.md`; `strategy-sw-prefetch.ts` caches its data; `edgar-earnings.ts` = SEC 8-K Item 2.02 earnings dates and the foreign-filer check. |
| `upload.ts` | Saves results to `ait_backtest_runs` / `ait_backtest_trades` (run ids `rulebook-A` … `rulebook-D`). |

Run (PowerShell, from the repo folder; keys set in your own terminal):

```
$env:NODE_OPTIONS="--max-old-space-size=8192"
npx tsx scripts/backtest/rulebook/run.ts --out=backtests/rulebook "--runs=A,B,C,D" --upload
```

Runs: A = S alone, B = SP alone, C = S + SP on the same $2,000, D = SP with slippage doubled.
Downloads pause 06:45–16:05 ET on weekdays (the live scanner owns Alpaca then) and resume on their own.
A rerun after a crash replays cached data quickly.
