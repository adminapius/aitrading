// Strategy E-J exit engines - BACKTEST ONLY. Spec (LOCKED Oct 24, 2026): docs/strategy-ej-spec.md
// One trade = one E entry, stepped bar by bar on 1-minute SIP bars. Pure (no I/O) so it is unit-tested.
//
// Modes:
//   'E'      E-current: bracket stop (fill - 1 ATR) and target (fill + 1.5 ATR), full exit; flatten at flatMinute.
//   'EJ'     Jose's engine: scale-outs at +$0.50 / +$1.00, breakeven after the 1st, runner on a 5-minute close below
//            VWAP, up to 2 adds after scale-out 2 (each 1/3 of the original size, own +$0.50 half and stop), 1R cap.
//   'EJ-noadd'  the same without adds.
import { RULEBOOK } from './rulebook/config'
import type { MinuteBar, SymbolDay } from './market'

export const EJ = {
  so1: 0.5,
  so2: 1.0,
  addTake: 0.5,
  addStopBelow: 0.5,
  maxAdds: 2,
  noAddsFrom: 15 * 60, // no adds from 15:00 (D12)
  targetAtr: 1.5, // E-current target and the D4 "reached its target" level
  rvolBars: 12, // D11: last 5-minute bar vs the average of the previous 12
  tick: 0.01,
  slippage: 0.005,
  slippagePremarket: 0.01, // before 9:30
  openMinute: 9 * 60 + 30,
  maxShareOfBarVolume: 0.1,
  maxShareOfDayVolume: 0.01, // of the volume so far that day
} as const

const C = RULEBOOK.costs
export type Mode = 'E' | 'EJ' | 'EJ-noadd'
export type Entry = {
  day: string; symbol: string; minute: number; fillIndex: number; fill: number; shares: number; stop: number; atr: number
  rank: number; regime: string; entryIndex: number
}
export type Fill = { t: number; side: 'buy' | 'sell'; shares: number; price: number; why: string; lot: 'base' | 'add1' | 'add2' }
export type TradeResult = {
  mode: Mode; entry: Entry; pnl: number; fees: number; r: number; exitReason: string; exitT: number; fills: Fill[]
  reached050: boolean; reached100: boolean; reachedTarget: boolean; so1: boolean; so2: boolean
  adds: number; addPnl: number; maxHigh: number
}

export const slipAt = (minute: number) => (minute < EJ.openMinute ? EJ.slippagePremarket : EJ.slippage)
export const sellFees = (price: number, shares: number) => price * shares * C.secFeePerDollar + Math.min(shares * C.finraTafPerShare, C.finraTafMaxPerTrade)

/** Session VWAP from 4:00 ET (premarket included) at bar i (D9). */
export const vwapAt = (d: SymbolDay, i: number) => (d.cumVolume[i] > 0 ? d.cumPriceVolume[i] / d.cumVolume[i] : d.bars[i].c)

/** D11: the last completed 5-minute bar (clock grid) as of bar i's close has volume above the average of the previous 12. */
export function rvol5Above(bars: MinuteBar[], i: number, midnight: number) {
  const minuteOf = (b: MinuteBar) => Math.round((b.t - midnight) / 60_000)
  const m = minuteOf(bars[i])
  const lastEnd = (m + 1) % 5 === 0 ? m + 1 : Math.floor((m + 1) / 5) * 5 // end minute of the last completed 5-minute bar
  const vol = new Map<number, number>()
  for (let k = 0; k <= i; k += 1) {
    const s = Math.floor(minuteOf(bars[k]) / 5) * 5
    if (s + 5 > lastEnd) continue
    vol.set(s, (vol.get(s) ?? 0) + bars[k].v)
  }
  const last = vol.get(lastEnd - 5)
  if (last == null) return false
  const prev: number[] = []
  for (let s = lastEnd - 10; prev.length < EJ.rvolBars && s >= 0; s -= 5) { const v = vol.get(s); if (v != null) prev.push(v) }
  if (prev.length < EJ.rvolBars) return false
  return last > prev.reduce((a, b) => a + b, 0) / prev.length
}

type Lot = { name: 'base' | 'add1' | 'add2'; shares: number; price: number; stop: number; fromIndex: number; halfLeft: number }

/** Simulates one entry to its end. flatMinute: bars starting at or after it are closed at their open. */
export function simulateTrade(mode: Mode, d: SymbolDay, midnight: number, e: Entry, flatMinute: number): TradeResult {
  const bars = d.bars
  const minuteOf = (b: MinuteBar) => Math.round((b.t - midnight) / 60_000)
  const fills: Fill[] = [{ t: bars[e.fillIndex].t, side: 'buy', shares: e.shares, price: e.fill, why: 'entry', lot: 'base' }]
  let fees = 0
  let pnl = 0
  const r0 = e.shares * (e.fill - e.stop)
  const target = e.fill + EJ.targetAtr * e.atr
  const third = e.shares >= 3 ? Math.floor(e.shares / 3) : 1
  const lots: Lot[] = [{ name: 'base', shares: e.shares, price: e.fill, stop: e.stop, fromIndex: e.fillIndex, halfLeft: 0 }]
  let phase = 0
  let adds = 0
  let addPnl = 0
  let maxHigh = e.fill
  let highAtLastAdd = -Infinity
  let pendingAdd = 0
  let pendingRunner = false
  let reached050 = false, reached100 = false, reachedTarget = false
  let exitReason = ''
  let exitT = bars[e.fillIndex].t
  const sell = (lot: Lot, shares: number, price: number, why: string, t: number) => {
    const q = Math.min(shares, lot.shares)
    if (q <= 0) return
    const f = sellFees(price, q)
    const p = q * (price - lot.price) - f
    fees += f
    pnl += p
    if (lot.name !== 'base') addPnl += p
    lot.shares -= q
    fills.push({ t, side: 'sell', shares: q, price, why, lot: lot.name })
    exitReason = why
    exitT = t
  }
  const open = () => lots.filter((l) => l.shares > 0)
  const closeAll = (price: number, why: string, t: number) => { for (const l of open()) sell(l, l.shares, price, why, t) }

  for (let i = e.fillIndex; i < bars.length; i += 1) {
    const b = bars[i]
    const m = minuteOf(b)
    const s = slipAt(m)
    if (m >= flatMinute) { closeAll(b.o * (1 - s), mode === 'E' && flatMinute > 15 * 60 + 30 ? 'flatten 15:55' : 'flat 15:30', b.t); break }
    // at the open: decisions taken at the previous bar's close
    if (pendingRunner) { closeAll(b.o * (1 - s), 'runner: 5-min close below VWAP', b.t); break }
    if (pendingAdd > 0) {
      const price = b.o * (1 + s)
      const stop = Math.max(price - EJ.addStopBelow, vwapAt(d, i - 1))
      const openRisk = open().reduce((sum, l) => sum + l.shares * Math.max(0, l.price - l.stop), 0)
      const perShare = price - stop
      let q = pendingAdd
      if (perShare > 0) q = Math.min(q, Math.floor((r0 - openRisk) / perShare + 1e-9))
      q = Math.min(q, Math.floor(EJ.maxShareOfBarVolume * b.v), Math.floor(EJ.maxShareOfDayVolume * (i > 0 ? d.cumVolume[i - 1] : 0)))
      pendingAdd = 0
      if (q >= 1 && perShare > 0) {
        adds += 1
        const name = adds === 1 ? 'add1' : 'add2'
        lots.push({ name, shares: q, price, stop, fromIndex: i, halfLeft: q >= 2 ? Math.floor(q / 2) : 1 })
        fills.push({ t: b.t, side: 'buy', shares: q, price, why: `add ${adds}`, lot: name })
        highAtLastAdd = maxHigh
      }
    }
    // stops first (worst case), then resting limits
    for (const l of open()) {
      if (b.o <= l.stop && i > l.fromIndex) { sell(l, l.shares, b.o * (1 - s), l.name === 'base' && phase >= 1 ? 'gap through breakeven' : 'gap-stop', b.t); continue }
      if (b.l <= l.stop) sell(l, l.shares, l.stop * (1 - s), l.name === 'base' ? (phase >= 1 ? 'breakeven stop' : 'stop') : `${l.name} stop`, b.t)
    }
    if (!open().length) break
    if (b.h >= e.fill + EJ.so1) reached050 = true
    if (b.h >= e.fill + EJ.so2) reached100 = true
    if (b.h >= target) reachedTarget = true
    const base = lots[0]
    if (mode === 'E') {
      if (i > e.fillIndex && base.shares > 0 && b.h >= target + EJ.tick) { sell(base, base.shares, Math.max(target, b.o), 'target', b.t); break }
    } else if (i > e.fillIndex) {
      if (phase === 0 && base.shares > 0 && b.h >= e.fill + EJ.so1 + EJ.tick) {
        sell(base, third, Math.max(e.fill + EJ.so1, b.o), 'scale-out 1', b.t)
        phase = 1
        base.stop = Math.max(base.stop, e.fill)
      }
      if (phase === 1 && base.shares > 0 && b.h >= e.fill + EJ.so2 + EJ.tick) {
        sell(base, Math.min(third, base.shares), Math.max(e.fill + EJ.so2, b.o), 'scale-out 2', b.t)
        phase = 2
      }
      for (const l of open()) if (l.name !== 'base' && l.halfLeft > 0 && i > l.fromIndex && b.h >= l.price + EJ.addTake + EJ.tick) {
        const q = Math.min(l.halfLeft, l.shares)
        sell(l, q, Math.max(l.price + EJ.addTake, b.o), `${l.name} +$0.50`, b.t)
        l.halfLeft = 0
      }
    }
    if (!open().length) break
    // at the close
    const prevMax = maxHigh
    maxHigh = Math.max(maxHigh, b.h)
    if (mode !== 'E' && phase >= 2) {
      const vw = vwapAt(d, i)
      if ((m + 1) % 5 === 0 && b.c < vw) pendingRunner = true
      else if (mode === 'EJ' && adds < EJ.maxAdds && m + 1 < EJ.noAddsFrom && b.h > prevMax && b.h > highAtLastAdd && b.h > e.fill + EJ.so2 && b.c > vw && rvol5Above(bars, i, midnight)) {
        pendingAdd = third
      }
    }
    if (i === bars.length - 1) closeAll(b.c * (1 - s), 'last bar of the day', b.t + 60_000)
  }
  return { mode, entry: e, pnl, fees, r: r0 > 0 ? pnl / r0 : 0, exitReason, exitT, fills, reached050, reached100, reachedTarget, so1: phase >= 1, so2: phase >= 2, adds, addPnl, maxHigh }
}

/** Incremental view for the portfolio loop: the trade's result is fully known once its exit time has passed. */
export function tradeEndsBy(result: TradeResult, now: number) {
  return result.exitT < now
}
