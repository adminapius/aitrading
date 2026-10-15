import type { AggBar, Bar } from './indicators'

export const MIN_MS = 60_000

export function minuteIn(midnight: number, t: number) {
  return Math.round((t - midnight) / MIN_MS)
}

export function minuteMaps(bars: Bar[], midnight: number) {
  const byMinute: Array<Bar | undefined> = new Array(1440).fill(undefined)
  const cumVolume: number[] = new Array(1440).fill(0)
  for (const bar of bars) {
    const minute = minuteIn(midnight, bar.t)
    if (minute >= 0 && minute < 1440) byMinute[minute] = bar
  }
  let total = 0
  for (let minute = 0; minute < 1440; minute += 1) {
    total += byMinute[minute]?.v ?? 0
    cumVolume[minute] = total
  }
  return { byMinute, cumVolume }
}

// Nearest resistance strictly above `price` (by at least one cent). Infinity when nothing is above.
export function nearestAbove(levels: Array<number | null | undefined>, price: number) {
  let best = Infinity
  for (const level of levels) if (level != null && Number.isFinite(level) && level > price + 0.01 && level < best) best = level
  return best
}

export type TypedLevel = [string, number | null | undefined]

// Nearest resistance strictly above `price`, with its level type (diagnostics).
export function nearestAboveTyped(levels: TypedLevel[], price: number) {
  let best = Infinity
  let type = 'none above'
  for (const [name, level] of levels) if (level != null && Number.isFinite(level) && level > price + 0.01 && level < best) { best = level; type = name }
  return { level: best, type }
}

// Every signal blocked by the room-to-resistance rule (diagnostics; base runs only).
export type RoomRow = { version: string; ticker: string; day: string; time: number; setup: string; entry: number; stop: number; level: number; type: string; roomR: number; minRoomR: number; otherBlockers: string }
export const roomLog: RoomRow[] = []

export function roomInR(resistance: number, trigger: number, stop: number) {
  const risk = trigger - stop
  if (!(risk > 0)) return 0
  return resistance === Infinity ? Infinity : (resistance - trigger) / risk
}

export type Pivot = { index: number; price: number; confirmedAt: number; rsi: number | null }

// Pivot highs/lows on aggregated bars; a pivot at i is confirmed when bar i+1 closes.
export function aggPivots(bars: AggBar[], rsi: Array<number | null>) {
  const highs: Pivot[] = []
  const lows: Pivot[] = []
  for (let index = 1; index < bars.length - 1; index += 1) {
    const bar = bars[index]
    if (bar.h > bars[index - 1].h && bar.h > bars[index + 1].h) highs.push({ index, price: bar.h, confirmedAt: bars[index + 1].end, rsi: rsi[index] })
    if (bar.l < bars[index - 1].l && bar.l < bars[index + 1].l) lows.push({ index, price: bar.l, confirmedAt: bars[index + 1].end, rsi: rsi[index] })
  }
  return { highs, lows }
}

// Pivots confirmed at or before `time` (lists are in confirmation order).
export function confirmedBy(pivots: Pivot[], time: number) {
  let count = 0
  while (count < pivots.length && pivots[count].confirmedAt <= time) count += 1
  return pivots.slice(Math.max(0, count - 2), count)
}

export function lastConfirmed(pivots: Pivot[], time: number) {
  let found: Pivot | undefined
  for (const pivot of pivots) {
    if (pivot.confirmedAt > time) break
    found = pivot
  }
  return found
}

export const round2 = (value: number) => Math.round(value * 100) / 100
