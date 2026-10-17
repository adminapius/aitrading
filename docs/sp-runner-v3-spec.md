# SP-Runner v3 (LOCKED, Oct 16, 2026)

v3 = SP-Runner v2 exactly (`docs/sp-runner-v2-spec.md`), with one change, decided by Jose before any v3 result existed:

- **No stop raise before 9:45.** The initial stop holds until then. Higher lows are still detected as in v2 (so the pressure-exit trio works as in v2), but a higher low may raise the stop only when the raise would take effect at 9:45 or later. From 9:45 on, each newly confirmed higher low raises the stop to (higher low − 0.25 × 5-min ATR) as in v2. No catch-up raise at 9:45 for higher lows confirmed earlier.

Consequence, stated before the run: the add window is 9:30-9:45 and an add needs the stop already lifted (v2 decision 3), so **v3 can never add**. Kept as locked; not changed.

## Step 1: sanity check (information only, not a pass test)
- One run over tuning + holdout (Oct 14, 2024 - Oct 13, 2026) on cached data; same entries, fills and costs as v2 and Step 2b.
- Reported beside v2 and Step 2b, per window and combined, with and without the WLDS 2025-09-10 trade (+13.6R in v2).
- If v3 is not positive in-sample (tuning + holdout, WLDS 2025-09-10 left out: total R ≤ 0), the SP-Runner idea stops here.

## Step 2 (only if step 1 is positive)
- Freeze v3 and paper-trade it forward on Alpaca paper alongside Strategy E, tagged, every trade logged, merged inside the window.
- Runs until about 30 trades, no changes during the test. Pass: positive expectancy after costs and PF above 1.5.
