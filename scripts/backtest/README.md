# Offline 6-month backtest

Replays the live paper strategy (main @ 925bdc9) over 2026-04-08 → 2026-10-07 on historical Alpaca data.
It never calls the live worker, the paper RPCs, Supabase, or any production table. `liveTradingEnabled` is untouched.

## Run

```bash
# Alpaca + FMP keys must be in the environment (ALPACA_API_KEY, ALPACA_API_SECRET, FMP_API_KEY)
set -a && source /path/to/.env && set +a

# Full run. Refuses to call Alpaca on weekdays between 07:00 and 16:00 ET.
pnpm exec tsx scripts/backtest/run.ts

# Re-run from the local cache only (no network, allowed any time)
pnpm exec tsx scripts/backtest/run.ts --cache-only

# Options
#   --from=YYYY-MM-DD --to=YYYY-MM-DD   period (default 2026-04-08..2026-10-07)
#   --days=N                            only the first N trading days (smoke test)
#   --out=path                          output dir (default backtests/2026-10-6m)
```

Downloads are cached gzip-compressed under `.cache/backtest/` (git-ignored), so reruns don't refetch.

## Files

| File | Purpose |
| --- | --- |
| `data.ts` | Rate-limited, cached Alpaca/FMP client (bars, news, quotes, assets incl. inactive, float) |
| `universe.ts` | Point-in-time daily universe: every US common stock that traded, including delisted |
| `market.ts` | Per-day minute data, same-time RVOL baseline, scanner filters, top-gainer ranking |
| `simulate.ts` | 1-minute stepper, fills, exits, guardrails, strategies A–D |
| `report.ts` | Metrics, monthly / regime breakdowns, CSV + JSON writer |
| `run.ts` | Entry point, run specs (A, B, C, D, A/C at 2x and 3x slippage) |

## Output

`backtests/2026-10-6m/trades.csv` (every trade, all runs) and `backtests/2026-10-6m/summary.json`
(metrics, monthly and regime breakdowns, best/worst trades, equity curves, sensitivity, limitations,
adapter differences, API call counts and runtime). The `/backtest` page renders `summary.json` read-only.

Strategy code (`lib/strategy.ts`, `lib/paper-exits.ts`, `lib/elliott-wave*.ts`) is imported unchanged; every
adaptation is listed under `adapterDifferences` in `summary.json`. No parameters are tuned.
