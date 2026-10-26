// Journal (spec section 5) and hard limits (section 4). Pure functions; the routes load and store the rows.
import { ASSISTANT } from '@/lib/assistant/config'

export type Fill = { id: string; symbol: string; side: 'buy' | 'sell' | 'sell_short'; qty: number; price: number; at: string; orderId?: string; mode: 'paper' | 'live' }
export type Plan = { id: string; symbol: string; entry: number; stop: number; setup?: string; createdAt: string }
export type RoundTrip = {
  key: string; symbol: string; mode: 'paper' | 'live'; side: 'long' | 'short'; day: string; entryAt: string; exitAt: string | null; open: boolean
  shares: number; avgEntry: number; avgExit: number | null; gross: number; fees: number; net: number; fillIds: string[]
}
export type JournalTrade = RoundTrip & { stop: number | null; stopFrom: 'plan' | 'manual' | null; r: number | null; setup: string; notes: string; screenshot: string | null; afterLimit: boolean }

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const etTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
export const etDay = (iso: string) => etDate.format(new Date(iso))
export const etMinute = (iso: string) => { const [h, m] = etTime.format(new Date(iso)).split(':').map(Number); return h * 60 + m }

export const sellFees = (shares: number, price: number) => shares * price * ASSISTANT.fees.secPerDollar + Math.min(shares * ASSISTANT.fees.tafPerShare, ASSISTANT.fees.tafMax)

/**
 * Fills -> round trips per symbol and account mode: a trade opens when the position leaves 0 and closes when it
 * returns to 0; adds and scale-outs belong to it; a fill that crosses 0 is split (close, then open the rest).
 * P&L from cash flows, fees estimated on sells (SEC + FINRA TAF). Pure.
 */
export function roundTrips(fills: Fill[]): RoundTrip[] {
  const sorted = [...fills].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const out: RoundTrip[] = []
  type State = { pos: number; t: RoundTrip; inQty: number; inCost: number; outQty: number; outValue: number }
  const state = new Map<string, State>()
  for (const f of sorted) {
    const k = `${f.mode}|${f.symbol}`
    let qty = f.qty
    const dir = f.side === 'buy' ? 1 : -1
    while (qty > 1e-9) {
      let s = state.get(k)
      if (!s || Math.abs(s.pos) < 1e-9) {
        const t: RoundTrip = { key: `${f.mode}|${f.symbol}|${f.at}|${f.id}`, symbol: f.symbol, mode: f.mode, side: dir > 0 ? 'long' : 'short', day: etDay(f.at), entryAt: f.at, exitAt: null, open: true, shares: 0, avgEntry: 0, avgExit: null, gross: 0, fees: 0, net: 0, fillIds: [] }
        out.push(t)
        s = { pos: 0, t, inQty: 0, inCost: 0, outQty: 0, outValue: 0 }
        state.set(k, s)
      }
      const t = s.t
      if (!t.fillIds.includes(f.id)) t.fillIds.push(f.id)
      const opening = (t.side === 'long') === (dir > 0)
      const use = opening ? qty : Math.min(qty, Math.abs(s.pos))
      if (opening) { s.inQty += use; s.inCost += use * f.price; s.pos += dir * use }
      else { s.outQty += use; s.outValue += use * f.price; s.pos += dir * use }
      if (dir < 0) t.fees += sellFees(use, f.price)
      qty -= use
      t.shares = s.inQty
      t.avgEntry = s.inCost / s.inQty
      t.avgExit = s.outQty > 0 ? s.outValue / s.outQty : null
      t.gross = t.side === 'long' ? s.outValue - (s.outQty / s.inQty) * s.inCost : (s.outQty / s.inQty) * s.inCost - s.outValue
      t.net = t.gross - t.fees
      if (Math.abs(s.pos) < 1e-9) { t.open = false; t.exitAt = f.at }
    }
  }
  return out
}

/** A8: the latest saved plan for the symbol made up to 10 minutes before the first fill. Pure. */
export function matchPlan(trade: Pick<RoundTrip, 'symbol' | 'entryAt'>, plans: Plan[]): Plan | null {
  const t = Date.parse(trade.entryAt)
  return plans.filter((p) => p.symbol === trade.symbol && Date.parse(p.createdAt) <= t && t - Date.parse(p.createdAt) <= ASSISTANT.planMatchMinutes * 60_000)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

/** R = net P&L / (shares x |entry - stop|); null without a stop or a closed trade. Pure. */
export function rOf(t: Pick<RoundTrip, 'net' | 'shares' | 'avgEntry' | 'open'>, stop: number | null) {
  if (t.open || stop == null) return null
  const risk = t.shares * Math.abs(t.avgEntry - stop)
  return risk > 0 ? t.net / risk : null
}

export const timeBucket = (iso: string) => { const m = etMinute(iso); return m < 9 * 60 + 45 ? 'before 09:45' : m < 11 * 60 ? '09:45-11:00' : 'after 11:00' }
export const priceBand = (p: number) => (p < 2 ? 'under $2' : p < 5 ? '$2-5' : p < 10 ? '$5-10' : p < 20 ? '$10-20' : 'over $20')

export type Stats = { trades: number; withR: number; noStop: number; winPct: number; expectancyR: number; pf: number; totalR: number; net: number; avgWinR: number; avgLossR: number }
/** Stats over closed trades; R figures use trades with a stop only. Pure. */
export function stats(trades: JournalTrade[]): Stats {
  const closed = trades.filter((t) => !t.open)
  const rs = closed.filter((t) => t.r != null).map((t) => t.r!)
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0)
  const pos = wins.reduce((a, b) => a + b, 0), neg = -losses.reduce((a, b) => a + b, 0)
  const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)
  return {
    trades: closed.length, withR: rs.length, noStop: closed.length - rs.length,
    winPct: closed.length ? (100 * closed.filter((t) => t.net > 0).length) / closed.length : 0,
    expectancyR: avg(rs), pf: neg > 0 ? pos / neg : pos > 0 ? Infinity : 0, totalR: rs.reduce((a, b) => a + b, 0),
    net: closed.reduce((a, t) => a + t.net, 0), avgWinR: avg(wins), avgLossR: avg(losses),
  }
}

export function groupStats(trades: JournalTrade[], by: (t: JournalTrade) => string) {
  const groups = new Map<string, JournalTrade[]>()
  for (const t of trades) groups.set(by(t), [...(groups.get(by(t)) ?? []), t])
  return [...groups].map(([key, list]) => ({ key, ...stats(list), enough: stats(list).withR >= ASSISTANT.yardstick.minTrades })).sort((a, b) => b.withR - a.withR)
}

/** The 30-trade yardstick, on PAPER trades only, before any live money (Jose, Oct 25). Pure. */
export function edgeReadout(trades: JournalTrade[]) {
  const paper = trades.filter((t) => t.mode === 'paper')
  const s = stats(paper)
  const y = ASSISTANT.yardstick
  if (s.withR < y.minTrades) return { status: 'collecting' as const, text: `${s.withR} of ${y.minTrades} paper trades with a stop`, stats: s }
  const pass = s.expectancyR > y.minExpectancyR && s.pf > y.minPf
  return { status: pass ? 'meets' as const : 'does-not-meet' as const, text: `${s.withR} paper trades: expectancy ${s.expectancyR.toFixed(2)}R (needs > +${y.minExpectancyR}R), PF ${Number.isFinite(s.pf) ? s.pf.toFixed(2) : 'inf'} (needs > ${y.minPf})`, stats: s }
}

export type Limits = { day: string; dayStartEquity: number; realized: number; maxLoss: number; lossHit: boolean; lossHitAt: string | null; tradesOpened: number; maxTrades: number; tradesHit: boolean; tradesHitAt: string | null }
/**
 * Section 4: today's realized P&L vs -3% of the day's starting equity, and round trips opened vs 4. `afterLimit`
 * marks trades opened after a limit was hit. Pure.
 */
export function dailyLimits(trips: RoundTrip[], day: string, dayStartEquity: number, maxLossPct = ASSISTANT.dailyMaxLossPct, maxTrades = ASSISTANT.maxTrades): { limits: Limits; afterLimit: Set<string> } {
  const opened = trips.filter((t) => t.day === day).sort((a, b) => a.entryAt.localeCompare(b.entryAt))
  const maxLoss = maxLossPct * dayStartEquity
  let realized = 0, lossHitAt: string | null = null
  for (const t of [...opened].filter((x) => !x.open && x.exitAt).sort((a, b) => a.exitAt!.localeCompare(b.exitAt!))) {
    realized += t.net
    if (!lossHitAt && realized <= -maxLoss) lossHitAt = t.exitAt
  }
  const tradesHitAt = opened.length >= maxTrades ? opened[maxTrades - 1].entryAt : null
  const afterLimit = new Set<string>()
  for (const [i, t] of opened.entries()) if ((lossHitAt && t.entryAt > lossHitAt) || i >= maxTrades) afterLimit.add(t.key)
  return { limits: { day, dayStartEquity, realized, maxLoss, lossHit: lossHitAt != null, lossHitAt, tradesOpened: opened.length, maxTrades, tradesHit: tradesHitAt != null, tradesHitAt }, afterLimit }
}

/** Joins round trips with plans and Jose's edits (setup, notes, stop, screenshot). Pure. */
export function journalTrades(trips: RoundTrip[], plans: Plan[], edits: Map<string, { setup?: string; notes?: string; stop?: number | null; screenshot?: string | null }>, afterLimit: Set<string> = new Set()): JournalTrade[] {
  return trips.map((t) => {
    const e = edits.get(t.key) ?? {}
    const plan = matchPlan(t, plans)
    const stop = e.stop != null ? e.stop : plan?.stop ?? null
    return { ...t, stop, stopFrom: e.stop != null ? 'manual' : plan ? 'plan' : null, r: rOf(t, stop), setup: e.setup ?? plan?.setup ?? 'untagged', notes: e.notes ?? '', screenshot: e.screenshot ?? null, afterLimit: afterLimit.has(t.key) }
  })
}
