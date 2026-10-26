// Assistant mode (docs/assistant-mode-spec.md). READ-ONLY: this module family never places, changes or cancels an
// order. A test (tests/assistant-guard.test.mjs) fails if any file under lib/assistant or app/api/assistant imports
// the order functions or calls an order endpoint.

/** Environment variable names (set by Jose; values never in chat or in the repo). */
export const ASSISTANT_ENV = {
  manualKey: 'ALPACA_MANUAL_KEY',
  manualSecret: 'ALPACA_MANUAL_SECRET',
  password: 'ASSISTANT_PASSWORD',
  sessionSecret: 'ASSISTANT_SESSION_SECRET',
  serviceSecret: 'ASSISTANT_SERVICE_SECRET',
  vapidPublic: 'VAPID_PUBLIC_KEY',
  vapidPrivate: 'VAPID_PRIVATE_KEY',
  vapidSubject: 'VAPID_SUBJECT',
  secUserAgent: 'SEC_USER_AGENT',
} as const

export const ASSISTANT = {
  riskPct: 0.01, // 1% of the manual account's equity per trade
  dailyMaxLossPct: 0.03, // A3
  maxTrades: 4, // A3
  dilutionDays: 90, // A4: S-1 / F-1 / S-3 / F-3 / 424B
  atmDays: 180, // A4: at-the-market mentions
  scannerTop: 50, // A7
  scannerMinGain: 10, // A7, percent
  scannerMinPrice: 1, // A7
  scannerWindow: [7 * 60, 11 * 60] as [number, number], // ET minutes
  haltInferMinutes: 5, // A6 fallback
  edgarMaxAgeDays: 400,
  planMatchMinutes: 10, // A8: a saved plan within 10 minutes before the first fill
  yardstick: { minTrades: 30, minExpectancyR: 0.1, minPf: 1.3 }, // E's paper yardstick, paper trades only
  fees: { secPerDollar: 20.6 / 1_000_000, tafPerShare: 0.000195, tafMax: 9.79 },
}

export const PAPER_TRADING_HOST = 'paper-api.alpaca.markets'

export function manualCredentials() {
  const key = process.env[ASSISTANT_ENV.manualKey]?.trim() ?? ''
  const secret = process.env[ASSISTANT_ENV.manualSecret]?.trim() ?? ''
  return { key, secret }
}

/** The trading host for the manual account; paper unless ALPACA_MANUAL_BASE_URL says otherwise (A1: paper first). */
export function manualTradingUrl() {
  return (process.env.ALPACA_MANUAL_BASE_URL?.trim() || `https://${PAPER_TRADING_HOST}`).replace(/\/+$/, '')
}

/** 'paper' or 'live' from the manual account's host. Pure given the URL. */
export const accountMode = (baseUrl: string): 'paper' | 'live' => (baseUrl.includes('paper-api.') ? 'paper' : 'live')

/**
 * A1: refuse to start with E's keys. Pure: the key comparison only; the account-id comparison is in
 * assertSeparateAccount (it needs both accounts' ids).
 */
export function keyProblem(manualKey: string, manualSecret: string, eKey: string | undefined): string | null {
  if (!manualKey || !manualSecret) return `${ASSISTANT_ENV.manualKey} and ${ASSISTANT_ENV.manualSecret} must be set (a separate Alpaca paper account for manual trades).`
  if (eKey && manualKey === eKey.trim()) return `${ASSISTANT_ENV.manualKey} is Strategy E's key. The assistant only reads a separate account; it will not start with E's keys.`
  return null
}

/** Same account id or account number as E's account: refuse. Pure. */
export function accountProblem(manual: { id?: string; account_number?: string } | null, e: { id?: string; account_number?: string } | null): string | null {
  if (!manual?.id) return 'The manual Alpaca account could not be read.'
  if (e?.id && (manual.id === e.id || (manual.account_number && manual.account_number === e.account_number))) return 'The manual keys reach Strategy E\'s Alpaca account. Create a separate paper account for manual trades.'
  return null
}
