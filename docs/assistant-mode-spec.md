# Assistant mode: a trading assistant for Jose's manual trades - DESIGN (Oct 25, 2026)

**Status: APPROVED by Jose (Oct 25, 2026) with the decisions in section 9; built on branch `assistant-mode`
(section 10); NOT merged. Merge after Friday Oct 30, 2026, after 16:00 ET, with Jose's go (A9).** Strategy E, its paper test (counting from Mon Oct 26, 2026), shadow A and the Friday report
are not touched.

## 0. Principles (non-negotiable)
1. **The assistant never places, changes or cancels an order.** It reads data and shows it. All assistant code goes
   through a read-only Alpaca client that exposes GET calls only; a test fails the build if any assistant module
   imports the order or position functions in `lib/alpaca-broker.ts` (`POST /v2/orders`, `DELETE /v2/orders`,
   `DELETE /v2/positions`). Alpaca keys cannot be made read-only, so the guarantee is in code and in the test.
2. **Manual trades live in a separate Alpaca account, never in E's paper account** (decision A1). Reason, from the
   code: E's 15:30 flatten closes *every* position in its account (`closeAllPositions`: `DELETE
   /v2/positions?cancel_orders=true`), and E's limits read that account (max 3 positions, 4% daily loss on account
   equity). A manual trade there would be force-closed at 15:30 and would change E's paper test. The assistant reads
   the manual account with its own keys (`ALPACA_MANUAL_KEY` / `ALPACA_MANUAL_SECRET`), separate from E's.
3. **Existing data sources only:** Alpaca (market data: snapshots, bars, quotes, news, the market-data stream;
   trading API: account and fill activities), FMP (current plan), SEC EDGAR (free, with a user agent), Supabase
   (database and storage). Notifications use Web Push (a browser standard, no data provider).
4. **Nothing here is a signal to trade.** Columns, flags and alerts describe a stock; there is no buy/sell output.
   The dashboard's Gemini "AI SIGNAL" is proposed for removal in the AI cost audit (Job 1).

## 1. Scanner panel (07:00-11:00 ET)
A table of live gainers, refreshed every 15 s (the Railway scheduler's cadence), sortable, with Jose's filters
(section 2) as optional highlights.

| Column | Source | How |
|---|---|---|
| Symbol, price, % gain | Alpaca snapshots (existing `/api/scan`) | Last trade vs the prior close. |
| Relative volume | Existing `lib/scan-data.ts` | Cumulative volume vs the 10-session average for the same 15-minute bucket; shown as "thin" when the baseline is under the existing reliability minimum (as E does). |
| Float (EDGAR, point-in-time) | SEC companyconcept + submissions (port of `scripts/backtest/edgar-float.ts` to `lib/`) | Latest cover-page shares outstanding **filed before today**, split-adjusted, at most 400 days old; a reason when missing (no CIK, foreign filer, stale, no value). Cached once a day per company. Tagged "shares outstanding (>= float)". FMP's current float shown greyed next to it (decision A5). |
| Latest headline and its age | Alpaca news (existing in `lib/scan-data.ts`) | Newest story on the symbol since the prior close; age in minutes. |
| Halt status | Alpaca market-data stream, trading-status and LULD channels | "Halted / resumed hh:mm / LULD pause" from the status messages (decision A6). Fallback when the stream is not available: "no trade for 5+ min in regular hours" from minute bars, labelled "inferred". |
| Dilution flag | SEC submissions JSON (free) | Red if the company filed S-1, S-1/A, F-1, S-3, S-3/A, F-3 or any 424B in the last 90 days, or a 424B5 or 8-K mentioning an at-the-market offering in the last 180 days (decision A4). Shows the form, date and a link to the filing. |

- Universe: the top 50 gainers of at least +10%, price at least $1 (decision A7), the same mover feed the scanner
  uses now.
- No new order logic and no change to E's scan: the panel calls its own route (`/api/assistant/scanner`), which reuses
  the scanner's read functions.

## 2. Alerts (no orders)
- **Filters, editable in a settings page** (stored in Supabase `ait_assistant_settings`): float max, price min/max,
  % gain min, relative volume min, news within N minutes, exclude dilution-flagged, exclude halted, time window.
  Defaults = the Ross-type filters (float <= 5M, $2-20, gain >= 20%, news <= 120 min), editable.
- **Evaluation runs server-side**, so a phone gets alerts with the dashboard closed: a **separate Railway service**
  (same repo, its own start command) checks the scanner every 15 s from 07:00 to 11:00 ET. E's Railway scheduler and
  `/api/worker/run` are not changed.
- **Delivery:** Web Push to the browser and to the phone (iPhone: the app added to the Home Screen, iOS 16.4 or later;
  Android: Chrome), with VAPID keys in the environment. Alternative: email (decision A2).
- One alert per symbol per filter per day (re-alert option: again after a new high of day). The alert text names
  the facts (symbol, gain, float, relative volume, news age, dilution, halt) and ends "Assistant only; no order was
  sent."
- An alert log in Supabase (`ait_assistant_alerts`) for the journal's "alerted before entry?" field.

## 3. Risk calculator
- Inputs: entry, stop; optional account size override. Account equity from the manual account (`GET /v2/account`).
- Output: **shares = floor(1% x equity / (entry - stop))**, also capped by buying power; dollar risk; 1R and 2R
  targets (entry + 1 x and 2 x (entry - stop)); position value as % of equity.
- Warnings (not blocks): stop at or above entry; risk under $0.02 a share; stop more than 10% below entry (the reason
  30% of R's setups were skipped); spread over 1% from the current quote; halted; dilution-flagged; the day's limits
  already hit (section 4).
- "Save plan" stores symbol, entry, stop, setup tag and time, so the journal can compute R for the trade. Runs in
  the browser; no orders.

## 4. Hard limits (counters, red when hit)
- From today's manual fills (section 5): **realized P&L vs a daily max loss** and **round trips opened vs a max
  trades count**, both set in settings (decision A3).
- Shown on every assistant page; red banner "Daily max loss hit" / "Max trades hit" once reached, with the time it
  happened, and a push notification once.
- The assistant cannot stop Jose from trading (it sends no orders and Alpaca has no API lock for this); the limit is
  a visible commitment, logged in the journal ("trade taken after the limit was hit").

## 5. Journal
- **Import:** Alpaca fill activities from the manual account (`GET /v2/account/activities/FILL`, paged, `page_token`;
  fields price, qty, side, transaction_time, order_id), every 5 minutes during market hours and once after the close,
  into `ait_manual_fills` (raw, de-duplicated by activity id).
- **Round trips** (`ait_manual_trades`): per symbol, a trade opens when the position goes from 0 to non-zero and
  closes when it returns to 0; partial fills and scale-outs belong to that trade (average entry, average exit).
  Long and short both supported.
- **R:** net P&L / (shares x (entry - stop)), with the stop from the saved plan (section 3) matched by symbol within
  10 minutes before the first fill; otherwise Jose enters the stop in the journal. Trades with no stop are listed
  but left out of R statistics, counted. Fees: SEC and FINRA TAF estimated with E's constants unless Alpaca reports
  them.
- **Every trade shows "paper" or "live"** (from the manual account's host: `paper-api.alpaca.markets` = paper). Paper and
  live trades are never mixed in a statistic: each group is labelled with its account mode.
- **Per trade:** setup tag (Jose's editable list; default tags: first pullback, pre-market high break, news
  continuation, other), entry and exit time, shares, R, $, notes, a screenshot slot (Supabase Storage, up to 2 MB an
  image), "alerted before entry", "after a limit was hit".
- **Stats:** overall and by setup, by time of day (before 09:45, 09:45-11:00, after 11:00, the same split as E), by
  price band ($2-5, $5-10, $10-20, over $20): trades, win %, expectancy R, PF, total R, $, average win and loss R.
- **Edge readout (Jose, Oct 25):** the 30-trade yardstick is judged on **paper trades only, before any live money**: at
  30+ paper trades with R, the same rule as E's test (expectancy > +0.10R and PF > 1.3). Live trades are shown, never
  counted toward it. Slices under 30 trades are shown greyed as "too few to judge"; with many slices, one will look good by
  chance, so only the overall line and slices fixed in advance count.

## 6. Data flow and storage
- Tables (as built): `ait_assistant_settings`, `ait_manual_fills` (raw fills, with account id and paper/live),
  `ait_trade_plans`, `ait_manual_trade_notes` (Jose's setup, notes, stop and screenshot per round trip; the round trips
  themselves are rebuilt from the fills), `ait_assistant_days` (each day's starting equity), `ait_assistant_alerts`,
  `ait_push_subscriptions`, `ait_assistant_halts`, `ait_edgar_daily` (float and dilution per symbol per day); one private
  storage bucket for screenshots. Row-level security as on the existing tables; the service key stays server-side.
- Routes and the Railway service: section 10.

## 7. Monthly cost estimate (incremental; Jose's plans unknown, so ranges)
| Feature | Calls | Paid service | Estimated extra cost |
|---|---|---|---|
| Scanner panel | Alpaca snapshots and news every 15 s, 07:00-11:00, while open: about 1,000 requests a day (same plan); SEC: about 100-200 requests a day for float and filings (cached daily) | Alpaca and FMP (existing flat plans), SEC (free); Vercel function calls | $0 on the data side; Vercel calls within most plans |
| Halt status | One market-data stream connection (status channel) in the assistant service | Alpaca (existing plan; the status channel must be included in it, checked in the build's first step) | $0 if included |
| Alerts | Server-side check every 15 s, 4 hours a day | Railway (usage-based) | about $1-5 (one small always-on service) |
| Risk calculator | One account read per open | Alpaca | $0 |
| Hard limits | From the journal's fills | none | $0 |
| Journal | Fill import every 5 min in market hours (about 80 requests a day) | Alpaca; Supabase storage for screenshots (about 300 KB each; 300 trades about 90 MB) | $0 within Supabase's free 1 GB; otherwise a few cents |
| **Total** | | | **about $1-5 a month**, almost all the extra Railway service |

No paid AI is used. If the Alpaca plan does not include the status channel, halts fall back to the inferred
version at $0.

## 8. Build plan (after Jose's go; each phase its own PR with tests)
1. Read-only Alpaca client for the manual account + the guard test; journal import and round trips; risk calculator;
   hard limits. (Needs A1's account and keys.)
2. Scanner panel: EDGAR float port, dilution flags, headline age; halt status via the stream (probe the status
   channel first).
3. Alerts: the assistant Railway service, settings page, Web Push.

Timing: by Jose's rule for E's test week (merges after 16:00 ET, only safety or broken fixes), the build merges after
Friday Oct 30, 2026 unless Jose decides otherwise (decision A9).

## 9. Decisions (Jose, Oct 25, 2026)
- **A1 Manual trading account:** a new, separate Alpaca **paper** account, created by Jose, with its own keys. The
  assistant refuses to start with E's keys (same key, or the keys reach E's account id or account number).
- **A2 Alerts:** push notifications (Web Push: browser and phone).
- **A3 Limits:** max loss 3% of the day's starting equity; 4 trades a day (editable in settings).
- **A4 Dilution lookback:** S-1/F-1/S-3/F-3/424B in 90 days; at-the-market mentions in 180 days.
- **A5 Float display:** EDGAR shares outstanding primary; FMP's current float greyed next to it.
- **A6 Halt source:** Alpaca's trading-status stream; inferred from no trade for 5+ min in regular hours otherwise.
- **A7 Scanner universe:** top 50 gainers, at least +10%, at least $1.
- **A8 Journal R:** stop from the saved plan (within 10 minutes before the first fill), else entered by hand; trades
  without a stop excluded from R stats, counted.
- **A9 Timing:** built on `assistant-mode`; merged after Friday Oct 30, 2026, after 16:00 ET, with Jose's go.
- Added by Jose: every journal trade shows "paper" or "live"; the 30-trade yardstick is judged on paper trades only,
  before any live money.

## 10. What is built (branch `assistant-mode`, Oct 25, 2026)
- `lib/assistant/`: `config.ts` (names, defaults, the A1 checks), `alpaca-read.ts` (GET-only client for the manual
  account; E's keys only for market-data GETs and E's account id), `risk.ts`, `journal.ts` (round trips, plans, R,
  stats, limits, the paper yardstick), `scanner.ts` (rows, filters, halts, alert text), `edgar.ts` (live EDGAR float
  and dilution), `service.ts`, `push.ts`, `store.ts` (assistant tables only, login), `http.ts`.
- Routes `app/api/assistant/*`: login, logout, session (runs the A1 guard), journal, import, trade, screenshot, plan,
  settings, scanner, alerts (service only), push, halts (service only). Page `/assistant` (tabs: Scanner, Risk,
  Journal, Settings), `public/assistant-sw.js`, `public/assistant.webmanifest` (Home Screen app for iPhone push).
- **Login:** the dashboard has none; the assistant does (a password gives a 12-hour signed, HttpOnly cookie). The
  service uses a bearer secret.
- `assistant-worker/` (Python, its own Railway service with `assistant-worker/railway.json`): alerts every 15 s
  07:00-11:00 ET, fill import every 5 min 04:00-20:00 ET and once at 20:05, the trading-status stream. It calls only
  `/api/assistant/*`.
- Migration `supabase/migrations/20261031090000_assistant_mode.sql` (assistant tables + private screenshot bucket);
  **not applied** until the merge.
- Tests: `tests/assistant-guard.test.mjs` (no order code or order endpoint in any assistant file; GET-only client; the
  service never calls E's routes; the A1 refusals), `tests/assistant.test.mjs` (risk, round trips, R, limits,
  filters, EDGAR parsing, sessions), `tests/assistant_worker_test.py` (status mapping).

### Environment variables (values set by Jose; never in chat)
| Name | Where | What |
|---|---|---|
| `ALPACA_MANUAL_KEY`, `ALPACA_MANUAL_SECRET` | Vercel, Railway assistant service (and PowerShell for local runs) | The separate paper account's keys |
| `ALPACA_MANUAL_BASE_URL` (optional) | Vercel | Defaults to `https://paper-api.alpaca.markets`; changing it to live is a separate decision |
| `ASSISTANT_PASSWORD` | Vercel | 12+ characters |
| `ASSISTANT_SESSION_SECRET` | Vercel | 32+ random characters |
| `ASSISTANT_SERVICE_SECRET` | Vercel and the Railway assistant service | The same random value in both |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Vercel | From `npx web-push generate-vapid-keys`; subject `mailto:` + Jose's email |
| `SEC_USER_AGENT` | Vercel | "Name email", as on the laptop |
| `VERCEL_APP_URL` | Railway assistant service | The app's https URL |
| `ALPACA_STREAM_KEY` / `_SECRET` / `_FEED` (optional) | Railway assistant service | If the manual account's keys have no SIP stream; default the manual keys and `sip` |

### At the merge (after Oct 30, with Jose's go)
1. Apply the migration. 2. Set the variables above. 3. Create the Railway service from this repo with config file
`assistant-worker/railway.json`. 4. Check `/health` on it (the stream line says whether the status channel connected;
if not, halts use the inferred status). 5. Sign in at `/assistant`, turn on push for each device, send a test push.

Sources checked Oct 25, 2026: Alpaca docs, Real-time Stock Data (trading status and LULD channels) and Account
Activities (FILL activity fields and paging).
