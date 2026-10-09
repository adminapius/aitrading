# Strategy E, diagnosis period (2026-04-08..2026-07-31), point-in-time float

Float = FMP historical shares-float as of each trading day (3,442 of 3,749 candidate symbols had history; 259 empty, 48 failed and fell back to current float). Feed: sip. Validation period not touched.

| Float source | Trades | Wins | P&L |
|---|---|---|---|
| Current float (2026-10-clean-diagnosis) | 31 | 19 | $196.61 |
| Point-in-time float (this run) | 34 | 20 | $183.12 |

Only with current float: ELMT 2026-06-01 (+$28.23).
Only with point-in-time float: MNTS 2026-04-13 (+$16.15), MNTS 2026-04-15 (+$29.18), MNTS 2026-05-11 (-$20.03), QUCY 2026-05-21 (-$9.54).
