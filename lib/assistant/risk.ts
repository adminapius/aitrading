// Risk calculator (spec section 3). Pure; runs in the browser and on the server. No orders.
import { ASSISTANT } from '@/lib/assistant/config'

export type RiskInput = { entry: number; stop: number; equity: number; buyingPower?: number; spreadPct?: number; halted?: boolean; dilution?: boolean; limitHit?: boolean }
export type RiskResult = { ok: boolean; shares: number; riskPerShare: number; dollarRisk: number; target1R: number; target2R: number; positionValue: number; positionPctOfEquity: number; capped: string | null; warnings: string[] }

export function riskPlan(x: RiskInput, riskPct = ASSISTANT.riskPct): RiskResult {
  const warnings: string[] = []
  const riskPerShare = x.entry - x.stop
  const empty = { ok: false, shares: 0, riskPerShare, dollarRisk: 0, target1R: NaN, target2R: NaN, positionValue: 0, positionPctOfEquity: 0, capped: null, warnings }
  if (!(x.entry > 0) || !(x.stop > 0) || !(x.equity > 0)) { warnings.push('Enter an entry, a stop and the account equity.'); return empty }
  if (riskPerShare <= 0) { warnings.push('The stop must be below the entry (long).'); return empty }
  // 1e-9 absorbs float noise (5.00 - 4.80 = 0.2000000000000002 would give 99 shares, not 100)
  let shares = Math.floor((riskPct * x.equity) / riskPerShare + 1e-9)
  let capped: string | null = null
  if (x.buyingPower != null && x.buyingPower > 0 && shares * x.entry > x.buyingPower) { shares = Math.floor(x.buyingPower / x.entry + 1e-9); capped = 'buying power' }
  if (riskPerShare < 0.02) warnings.push('Risk under $0.02 a share: the stop is inside normal noise.')
  if (riskPerShare > 0.1 * x.entry) warnings.push('Stop more than 10% below the entry.')
  if (x.spreadPct != null && x.spreadPct > 1) warnings.push(`Spread ${x.spreadPct.toFixed(2)}% (over 1%).`)
  if (x.halted) warnings.push('The stock is halted or was just halted.')
  if (x.dilution) warnings.push('Dilution flag: recent S-1/S-3/424B or an at-the-market offering.')
  if (x.limitHit) warnings.push('A daily limit is already hit.')
  if (shares < 1) warnings.push('Under one share at 1% risk.')
  const positionValue = shares * x.entry
  return {
    ok: shares >= 1, shares, riskPerShare, dollarRisk: shares * riskPerShare,
    target1R: x.entry + riskPerShare, target2R: x.entry + 2 * riskPerShare,
    positionValue, positionPctOfEquity: positionValue / x.equity, capped, warnings,
  }
}
