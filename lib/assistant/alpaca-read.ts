// READ-ONLY Alpaca access for assistant mode. Only GET requests exist in this file; there is deliberately no way to
// send another method (tests/assistant-guard.test.mjs checks this file and every assistant file).
import { alpacaHeaders, tradingConfig } from '@/lib/trading-config'
import { accountMode, accountProblem, keyProblem, manualCredentials, manualTradingUrl } from '@/lib/assistant/config'

export type ManualAccount = { id: string; account_number?: string; equity: number; last_equity: number; buying_power: number; status?: string; mode: 'paper' | 'live' }
export type FillActivity = { id: string; activity_type: string; symbol: string; side: 'buy' | 'sell' | 'sell_short'; qty: string; price: string; transaction_time: string; order_id: string }

async function get<T>(baseUrl: string, path: string, headers: Record<string, string>, timeoutMs = 8_000): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
  if (!response.ok) throw new Error(`Alpaca GET ${path.split('?')[0]} failed (${response.status})`)
  return await response.json() as T
}

function manualHeaders() {
  const { key, secret } = manualCredentials()
  return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }
}

/** A1 guard: the manual keys exist, are not E's, and reach a different account than E's. Throws with the reason. */
export async function assertSeparateAccount(): Promise<ManualAccount> {
  const { key, secret } = manualCredentials()
  const keyIssue = keyProblem(key, secret, process.env.ALPACA_API_KEY)
  if (keyIssue) throw new Error(keyIssue)
  const base = manualTradingUrl()
  const manual = await get<{ id: string; account_number?: string; equity: string; last_equity: string; buying_power: string; status?: string }>(base, '/v2/account', manualHeaders())
  const e = await get<{ id: string; account_number?: string }>(tradingConfig.alpacaBaseUrl, '/v2/account', alpacaHeaders()).catch(() => null)
  const accountIssue = accountProblem(manual, e)
  if (accountIssue) throw new Error(accountIssue)
  return { id: manual.id, account_number: manual.account_number, equity: Number(manual.equity), last_equity: Number(manual.last_equity), buying_power: Number(manual.buying_power), status: manual.status, mode: accountMode(base) }
}

/** Fill activities of the manual account since `afterIso` (paged, oldest first). */
export async function manualFillsSince(afterIso: string, maxPages = 20): Promise<FillActivity[]> {
  const out: FillActivity[] = []
  let token: string | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const q = new URLSearchParams({ after: afterIso, direction: 'asc', page_size: '100' })
    if (token) q.set('page_token', token)
    const rows = await get<FillActivity[]>(manualTradingUrl(), `/v2/account/activities/FILL?${q}`, manualHeaders())
    if (!Array.isArray(rows) || !rows.length) break
    out.push(...rows)
    if (rows.length < 100) break
    token = rows.at(-1)!.id
  }
  return out
}

/** A market-data GET with the existing data keys (read-only; no account is touched). */
export async function marketData<T>(path: string): Promise<T> {
  return get<T>(tradingConfig.alpacaDataUrl, path, alpacaHeaders())
}
