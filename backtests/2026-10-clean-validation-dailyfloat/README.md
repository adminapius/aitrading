# Strategy E — validation period with daily point-in-time float

Single rerun of E on the validation period (2026-08-03 to 2026-10-07, 47 trading days), SIP feed, `BACKTEST_PIT_FLOAT=daily`. Strategy code unchanged.

Command:

```
BACKTEST_PIT_FLOAT=daily pnpm exec tsx scripts/backtest/run.ts --sim-from=2026-08-03 --sim-to=2026-10-07 --runs=E,E-x2,E-x3 --out=backtests/2026-10-clean-validation-dailyfloat
```

## Results

| Run | Trades | Win % | Avg R | PF | P&L | Max DD |
|---|---:|---:|---:|---:|---:|---:|
| E x1 | 22 | 31.8% | -0.079 | 0.919 | -$12.30 | $98.48 (4.92%) |
| E x2 | 22 | 31.8% | -0.102 | 0.869 | -$20.55 | $103.40 (5.17%) |
| E x3 | 22 | 31.8% | -0.124 | 0.823 | -$28.80 | $108.31 (5.42%) |

Earlier current-float result (`2026-10-clean-validation`):

| Run | Trades | Win % | PF | P&L | Max DD |
|---|---:|---:|---:|---:|---:|
| E x1 | 23 | 39.1% | 1.193 | +$27.34 | $98.48 |
| E x2 | 23 | 39.1% | 1.114 | +$16.72 | $103.40 |
| E x3 | 23 | 39.1% | 1.055 | +$8.38 | $108.31 |

## Trade-level differences (x1)

- Only with current float: AEHL 2026-09-17 (+$13.18, target), VBIO 2026-09-30 (+$14.40, target)
- Only with daily float: GLND 2026-09-25 (-$9.78, stop)
- Same trade, different size: ARTL 2026-09-23 +$77.72 -> +$75.44 (equity path changed)

Net: -1 trade, -$39.64. Monthly (x1): 2026-08 11 trades -$78.47; 2026-09 10 trades +$76.04; 2026-10 1 trade -$9.87.

Float coverage: 3,478 candidates; daily shares for all 3,478; 76 without a current free-float % (fall back to quarterly/current); 48 market-cap fetches failed first pass, 0 after retry. See `float-coverage.json`.
