# Out-of-sample test — E and A, 2025-10-01 to 2026-03-31

Never used for design or tuning. Strategy E exactly as in `lib/strategies/clean-momentum.ts` (source commit 925bdc9), no changes. A included for reference. SIP feed, daily point-in-time float, 125 trading days, $2,000 starting equity.

Command:

```
BACKTEST_PIT_FLOAT=daily pnpm exec tsx scripts/backtest/run.ts --from=2025-10-01 --to=2026-03-31 --runs=E,E-x2,E-x3,A,A-x2,A-x3 --out=backtests/2025-10-oos
```

Run time 2,282 s; 52,063 Alpaca SIP calls (118,804 served from cache). All FMP fetches succeeded after retry (0 failures).

## Results

| Run | Trades | Win % | Avg R | PF | P&L | Max DD | Ending equity |
|---|---:|---:|---:|---:|---:|---:|---:|
| E x1 | 33 | 33.3% | -0.143 | 0.896 | -$26.28 | $119.15 (5.81%) | $1,973.72 |
| E x2 | 33 | 33.3% | -0.164 | 0.849 | -$39.22 | $122.93 (6.01%) | $1,960.78 |
| E x3 | 33 | 33.3% | -0.186 | 0.811 | -$49.82 | $124.62 (6.10%) | $1,950.18 |
| A x1 | 802 | 37.4% | -0.160 | 0.765 | -$1,171.52 | $1,315.22 (61.97%) | $828.48 |
| A x2 | 793 | 35.2% | -0.230 | 0.672 | -$1,438.77 | $1,497.17 (72.82%) | $561.23 |
| A x3 | 774 | 32.8% | -0.314 | 0.587 | -$1,629.91 | $1,670.28 (81.86%) | $370.09 |

## Per-month P&L

| Month | E trades | E x1 | E x2 | E x3 | A trades | A x1 | A x2 | A x3 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-10 | 4 | -$19.08 | -$20.31 | -$21.53 | 133 | -$390.53 | -$501.37 | -$572.66 |
| 2025-11 | 5 | -$35.55 | -$36.15 | -$36.75 | 78 | -$72.24 | -$120.26 | -$138.53 |
| 2025-12 | 8 | +$63.70 | +$60.47 | +$59.32 | 161 | +$89.15 | -$4.34 | -$90.47 |
| 2026-01 | 4 | -$49.15 | -$51.50 | -$53.86 | 159 | -$345.04 | -$377.52 | -$412.07 |
| 2026-02 | 4 | -$4.81 | -$6.04 | -$7.28 | 113 | -$240.68 | -$246.05 | -$245.77 |
| 2026-03 | 8 | +$18.61 | +$14.31 | +$10.28 | 158 | -$212.17 | -$189.24 | -$170.41 |

E exits (x1): 8 target, 15 stop, 10 15:55 flatten.

## Float coverage

3,796 candidate symbols. Daily market-cap history for 3,745; 51 had none (mostly ETFs/ETNs). 59 had no current free-float %. Quarterly share history for 3,535; 261 empty. Lookups: 606,439 daily, 14,346 quarterly, 400,440 current-float fallback, 308,860 with no float at all. See `float-coverage.json`.

## Harness fix found during this run

The first attempt produced no trades from October through February. The cause was the 15-minute bar fetch window, which was pinned to the April 2026 design period, so any earlier period got no intraday history and every entry failed closed. That run was discarded. The fix (`43f502d`) derives the window from the requested period. It is harness-only; strategy logic is unchanged.
