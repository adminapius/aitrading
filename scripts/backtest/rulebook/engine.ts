// Account + order engine for the S & SP rulebook backtest. One Account per run; frames (market data + signals)
// are shared read-only across runs. Stops are held internally by the backtester (no broker stop orders).
import { RULEBOOK, type VariantConfig } from './config'
import { MIN_MS } from './common'
import type { Bar } from './indicators'
import type { FiveEvent, Signal, SymbolDay, Version } from './types'

const A = RULEBOOK.account
const F = RULEBOOK.fills

export type RunConfig = { id: string; label: string; versions: Version[]; spSlippageMultiplier: number; variant?: 'E' | 'F' }

export type TradeRecord = {
  run: string
  date: string
  ticker: string
  version: Version
  setup: string
  entryIndex: number // nth entry in this ticker today (≥2 = re-entry)
  entryTime: number
  entryPrice: number // first fill
  avgCost: number
  stop: number // initial stop
  shares: number // initial shares
  maxShares: number // after pyramid adds
  units: number
  exitTime: number
  exitPrice: number // share-weighted average of all exit fills
  exitReason: string
  partials: string
  rResult: number
  pnl: number
  fees: number
  equityAfter: number
  riskDollars: number
  mfeR: number
  maeR: number
  holdMinutes: number
  roomR: number
  gapPct: number | null
  rvol: number | null
  note: string
}

type Position = {
  id: number
  frame: SymbolDay
  signal: Signal
  version: Version
  symbol: string
  entryTime: number
  entryMinute: number
  entryPrice: number
  avgCost: number
  shares: number
  initialShares: number
  maxShares: number
  initialStop: number
  stop: number
  riskPerShare: number
  riskDollars: number
  maxHigh: number
  minLow: number
  units: number
  scale1Done: boolean
  scale2Done: boolean
  target1: number
  target2: number | null
  pendingExit: string | null
  timeChecked: boolean
  lastClose: number
  runnerCount: number
  eventsSeen: number
  pnl: number
  fees: number
  exitShares: number
  exitValue: number
  partials: string[]
  entryIndex: number
  lastExitTime: number
  lastReason: string
}

type Order = { signal: Signal; frame: SymbolDay; shares: number; expires: number; riskDollars: number; add: Position | null; newStop: number }

export const engineStats = () => ({ signals: 0, ordersPlaced: 0, filled: 0, expiredUnfilled: 0, rejectedBarVolume: 0, rejectedWidthAtFill: 0, rejectedCapAtFill: 0, adds: 0, skipped: {} as Record<string, number> })

export class Account {
  equity = A.startingEquity
  peak = A.startingEquity
  sizingEquity = A.startingEquity
  consecutiveLosses = 0
  halved = false
  winsSinceHalved = 0
  trades: TradeRecord[] = []
  stats = engineStats()
  equityByDay: Array<{ day: string; equity: number }> = []
  private nextId = 1
  private dayR = 0
  private small = true
  private positions: Position[] = []
  private orders: Order[] = []
  private tickerEntries = new Map<string, number>()
  private tickerLosses = new Map<string, number>()
  private tickerLastBasis = new Map<string, number>()
  private usedLevels = new Set<string>()

  private readonly variant: VariantConfig | null

  constructor(readonly run: RunConfig) {
    this.variant = run.variant ? RULEBOOK.variants[run.variant] : null
  }

  private skip(reason: string) {
    this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1
  }

  private slippage(version: Version, minute: number) {
    if (version === 'S') return RULEBOOK.S.slippage
    const base = minute < RULEBOOK.SP.regularOpenMinute ? RULEBOOK.SP.slippagePremarket : RULEBOOK.SP.slippage
    return base * this.run.spSlippageMultiplier
  }

  private riskFraction(version: Version) {
    return version === 'S' ? RULEBOOK.S.riskPerTrade : RULEBOOK.SP.riskPerTrade
  }

  private openValue(exclude?: Position) {
    return this.positions.filter((position) => position !== exclude).reduce((sum, position) => sum + position.shares * position.avgCost, 0)
  }

  simulateDay(day: string, allFrames: SymbolDay[]) {
    const frames = allFrames.filter((frame) => this.run.versions.includes(frame.version))
    // Session open: 1R from current equity; 2:1 drawdown rule; small-account mode below $10k.
    this.peak = Math.max(this.peak, this.equity)
    const drawdown = 1 - this.equity / this.peak
    this.sizingEquity = Math.max(0, this.peak * (1 - A.drawdownMultiplier * drawdown))
    this.small = this.equity < A.smallAccountThreshold
    this.dayR = 0
    this.tickerEntries.clear()
    this.tickerLosses.clear()
    this.tickerLastBasis.clear()
    this.usedLevels.clear()
    if (!frames.length) {
      this.equityByDay.push({ day, equity: this.equity })
      return
    }
    const midnight = frames[0].midnight
    const signals = frames.flatMap((frame) => frame.signals.map((signal) => ({ signal, frame })))
      .sort((left, right) => left.signal.time - right.signal.time || right.signal.roomR - left.signal.roomR || left.signal.version.localeCompare(right.signal.version))
    this.stats.signals += signals.length
    const eventIndex = new Map<SymbolDay, number>(frames.map((frame) => [frame, 0]))
    let cursor = 0
    const flatten = RULEBOOK.management.flattenMinute

    for (let m = 4 * 60; m < 16 * 60; m += 1) {
      const barStart = midnight + m * MIN_MS
      const boundary = barStart + MIN_MS
      // 1) Working entry orders on this bar.
      for (const order of [...this.orders]) {
        if (barStart >= order.expires || m >= flatten) {
          this.orders.splice(this.orders.indexOf(order), 1)
          this.stats.expiredUnfilled += 1
          continue
        }
        const bar = order.frame.byMinute[m]
        if (bar && bar.t >= order.signal.time) this.tryFill(order, bar, m)
      }
      // 2) Open positions on this bar.
      for (const position of [...this.positions]) {
        const bar = position.frame.byMinute[m]
        if (bar && bar.t > position.entryTime) this.processBar(position, bar, m)
      }
      // 3) Facts known at this boundary: 5m closes, time stops, then new signals.
      for (const frame of frames) {
        let index = eventIndex.get(frame)!
        while (index < frame.events.length && frame.events[index].end <= boundary) {
          const event = frame.events[index]
          if (event.end === boundary) for (const position of this.positions) if (position.frame === frame) this.applyEvent(position, event)
          index += 1
        }
        eventIndex.set(frame, index)
      }
      for (const position of this.positions) {
        const limit = (position.version === 'S' ? RULEBOOK.S.timeStopMinutes : RULEBOOK.SP.timeStopMinutes) * MIN_MS
        if (!position.timeChecked && boundary - position.entryTime >= limit) {
          position.timeChecked = true
          const stalled = this.variant?.timeStopOnlyIfBelowEntry ? position.lastClose < position.entryPrice : position.maxHigh < position.entryPrice + position.riskPerShare
          if (stalled && !position.pendingExit) position.pendingExit = 'time-stop'
        }
      }
      while (cursor < signals.length && signals[cursor].signal.time <= boundary) {
        const { signal, frame } = signals[cursor]
        cursor += 1
        if (signal.time === boundary) this.onSignal(signal, frame, m)
      }
    }
    // Anything still open after the last bar (no bar at/after 15:30): exit at its last close.
    for (const position of [...this.positions]) {
      const last = position.frame.bars.at(-1)!
      this.sell(position, position.shares, last.c * (1 - this.slippage(position.version, 959)), 'flatten', last.t + MIN_MS)
    }
    this.orders = []
    this.equityByDay.push({ day, equity: this.equity })
  }

  private onSignal(signal: Signal, frame: SymbolDay, m: number) {
    const minute = m + 1
    const held = this.positions.find((position) => position.symbol === signal.symbol)
    if (held) {
      if (held.version === 'SP' && signal.version === 'SP') this.tryAdd(held, signal, frame, m)
      else this.skip('already-in-symbol')
      return
    }
    if (this.orders.some((order) => order.signal.symbol === signal.symbol)) return this.skip('order-working')
    if (!signal.entryEligible) return this.skip(`${signal.version}-not-eligible: ${(signal.blockers ?? []).join(' + ') || 'unknown'}`)
    const V = signal.version === 'S' ? RULEBOOK.S : RULEBOOK.SP
    if (minute < V.entryStartMinute || minute > V.entryEndMinute || minute >= RULEBOOK.management.flattenMinute) return this.skip('outside-entry-window')
    if (this.dayR <= A.dailyLossStopR) return this.skip('daily-loss-stop')
    const limits = this.small ? A.small : A.normal
    const entryOrders = this.orders.filter((order) => !order.add).length
    if (this.positions.length + entryOrders >= limits.maxOpenPositions) return this.skip('max-open-positions')
    if (!this.small && this.positions.length + entryOrders + 1 > A.normal.maxOpenRiskR) return this.skip('max-open-risk')
    if (signal.levelKey && this.usedLevels.has(signal.levelKey)) return this.skip('level-already-traded')
    const entries = this.tickerEntries.get(signal.symbol) ?? 0
    if (signal.version === 'SP') {
      if (entries >= RULEBOOK.SP.retrade.maxEntriesPerTicker) return this.skip('SP-max-entries-ticker')
      if ((this.tickerLosses.get(signal.symbol) ?? 0) >= RULEBOOK.SP.retrade.maxLossesPerTicker) return this.skip('SP-max-losses-ticker')
      const lastBasis = this.tickerLastBasis.get(signal.symbol)
      if (lastBasis != null && !(signal.basisLow > lastBasis)) return this.skip('SP-no-higher-low')
    } else if (RULEBOOK.S.maxEntriesPerTickerPerDay != null && entries >= RULEBOOK.S.maxEntriesPerTickerPerDay) return this.skip('S-max-entries-ticker')
    const riskDollars = this.sizingEquity * this.riskFraction(signal.version) * (this.halved ? A.losingStreak.sizeMultiplier : 1)
    const perShare = signal.trigger - signal.stop
    if (!(riskDollars > 0) || !(perShare > 0)) return this.skip('no-risk-budget')
    let shares = Math.floor(riskDollars / perShare + 1e-9)
    const capValue = limits.positionValueCapPct * this.equity - this.openValue()
    shares = Math.min(shares, Math.floor(capValue / signal.limit), Math.floor(A.maxShareOfDayVolume * frame.cumVolume[m]))
    if (shares < 1 || shares * perShare < A.minRiskFractionAfterCaps * riskDollars) return this.skip('caps-below-half-R')
    this.orders.push({ signal, frame, shares, expires: signal.time + F.entryValidMinutes * MIN_MS, riskDollars, add: null, newStop: signal.stop })
    this.stats.ordersPlaced += 1
  }

  private tryAdd(position: Position, signal: Signal, frame: SymbolDay, m: number) {
    const P = RULEBOOK.SP.pyramid
    if (!signal.addEligible || position.units >= P.maxUnits) return
    if (this.orders.some((order) => order.add === position)) return
    if (signal.trigger < position.entryPrice + P.minOpenProfitR * position.riskPerShare) return
    const newStop = Math.max(position.stop, signal.basisLow - RULEBOOK.SP.stop.bufferAtr * signal.atr5)
    if (!(newStop < signal.trigger)) return
    const riskDollars = this.sizingEquity * RULEBOOK.SP.riskPerTrade * (this.halved ? A.losingStreak.sizeMultiplier : 1)
    const limits = this.small ? A.small : A.normal
    let shares = Math.floor(riskDollars / (signal.trigger - newStop) + 1e-9)
    const capValue = limits.positionValueCapPct * this.equity - this.openValue()
    shares = Math.min(shares, Math.floor(capValue / signal.limit), Math.floor(A.maxShareOfDayVolume * frame.cumVolume[m]) - position.shares)
    if (shares < 1 || shares * (signal.trigger - newStop) < A.minRiskFractionAfterCaps * riskDollars) return
    this.orders.push({ signal, frame, shares, expires: signal.time + F.entryValidMinutes * MIN_MS, riskDollars, add: position, newStop })
    this.stats.ordersPlaced += 1
  }

  // Entry fill: a bar trading through the trigger fills at max(trigger, open) + slippage, unless that is above the limit.
  private tryFill(order: Order, bar: Bar, m: number) {
    const { signal } = order
    if (bar.h < signal.trigger) return
    const price = Math.max(signal.trigger, bar.o)
    if (price > signal.limit) return
    const fill = price * (1 + this.slippage(signal.version, m))
    const remove = () => this.orders.splice(this.orders.indexOf(order), 1)
    let shares = order.shares
    if (shares > RULEBOOK.costs.rejectFillAboveBarVolumeShare * bar.v) {
      remove()
      this.stats.rejectedBarVolume += 1
      return
    }
    const stop = order.newStop
    const width = fill - stop
    const tooWide = signal.version === 'S'
      ? width > RULEBOOK.S.stop.maxAtr * signal.atr5
      : width > Math.min(RULEBOOK.SP.stop.maxWidthAtr * signal.atr5, RULEBOOK.SP.stop.maxWidthPct * fill)
    if (tooWide) {
      remove()
      this.stats.rejectedWidthAtFill += 1
      return
    }
    const limits = this.small ? A.small : A.normal
    const capValue = limits.positionValueCapPct * this.equity - this.openValue()
    shares = Math.min(shares, Math.floor(capValue / fill))
    if (shares < 1 || shares * width < A.minRiskFractionAfterCaps * order.riskDollars) {
      remove()
      this.stats.rejectedCapAtFill += 1
      return
    }
    remove()
    this.stats.filled += 1
    if (order.add) {
      const position = order.add
      if (!this.positions.includes(position)) return
      position.avgCost = (position.avgCost * position.shares + fill * shares) / (position.shares + shares)
      position.shares += shares
      position.maxShares = Math.max(position.maxShares, position.shares)
      position.stop = Math.max(position.stop, order.newStop)
      position.units += 1
      position.partials.push(`add ${shares}@${fill.toFixed(4)}`)
      this.stats.adds += 1
      return
    }
    const entryIndex = (this.tickerEntries.get(signal.symbol) ?? 0) + 1
    this.tickerEntries.set(signal.symbol, entryIndex)
    if (signal.version === 'SP') this.tickerLastBasis.set(signal.symbol, signal.basisLow)
    if (signal.levelKey) this.usedLevels.add(signal.levelKey)
    const riskPerShare = fill - stop
    const t1 = fill + (signal.version === 'S' ? RULEBOOK.S.exits.scale1R : RULEBOOK.SP.exits.scale1R) * riskPerShare
    let t2: number | null = null
    if (signal.version === 'SP') {
      const fiveR = fill + RULEBOOK.SP.exits.scale2R * riskPerShare
      const whole = Number.isInteger(t1) ? t1 + 1 : Math.ceil(t1)
      const pdh = order.frame.pdh != null && order.frame.pdh > t1 ? order.frame.pdh : Infinity
      t2 = Math.min(fiveR, whole, pdh)
    }
    const position: Position = {
      id: this.nextId++, frame: order.frame, signal, version: signal.version, symbol: signal.symbol, entryTime: bar.t, entryMinute: m,
      entryPrice: fill, avgCost: fill, shares, initialShares: shares, maxShares: shares, initialStop: stop, stop, riskPerShare,
      riskDollars: shares * riskPerShare, maxHigh: Math.max(fill, bar.c), minLow: Math.min(fill, bar.c), units: 1, scale1Done: false, scale2Done: false,
      target1: t1, target2: t2, pendingExit: null, timeChecked: false, lastClose: bar.c, runnerCount: 0, eventsSeen: 0, pnl: 0, fees: 0, exitShares: 0, exitValue: 0,
      partials: [], entryIndex, lastExitTime: bar.t, lastReason: '',
    }
    this.positions.push(position)
    // Entry bar: the order of high/low is unknown; the stop counts only if the bar closes at or below it.
    if (F.entryBarStopUsesClose && bar.c <= stop) this.sell(position, position.shares, stop * (1 - this.slippage(position.version, m)), 'stop', bar.t + MIN_MS)
  }

  private processBar(position: Position, bar: Bar, m: number) {
    position.lastClose = bar.c
    const slip = this.slippage(position.version, m)
    const exitAt = bar.t + MIN_MS
    if (m >= RULEBOOK.management.flattenMinute) return this.sell(position, position.shares, bar.o * (1 - slip), 'flatten', bar.t)
    if (position.pendingExit) return this.sell(position, position.shares, bar.o * (1 - slip), position.pendingExit, bar.t)
    const stopReason = position.stop > position.initialStop + 1e-9 ? 'trail-stop' : 'stop'
    if (bar.o <= position.stop) return this.sell(position, position.shares, bar.o * (1 - slip), `gap-${stopReason}`, bar.t)
    if (bar.l <= position.stop) return this.sell(position, position.shares, position.stop * (1 - slip), stopReason, exitAt)
    // Resting scale-out limits: fill at the target (or the open if it gapped above) once traded through by a tick.
    const through = RULEBOOK.fills.targetThroughTicks
    if (!position.scale1Done && bar.h >= position.target1 + through) {
      position.scale1Done = true
      const fraction = position.version === 'S' ? RULEBOOK.S.exits.scale1Fraction : RULEBOOK.SP.exits.scaleFraction
      const shares = Math.floor(position.shares * fraction)
      if (shares >= 1) this.sell(position, shares, Math.max(position.target1, bar.o), 'scale-1', exitAt)
    }
    if (position.version === 'SP' && position.scale1Done && !position.scale2Done && position.target2 != null && bar.h >= position.target2 + through && this.positions.includes(position)) {
      position.scale2Done = true
      const shares = Math.floor(position.shares / 2)
      if (shares >= 1) this.sell(position, shares, Math.max(position.target2, bar.o), 'scale-2', exitAt)
    }
    if (!this.positions.includes(position)) return
    position.maxHigh = Math.max(position.maxHigh, bar.h)
    position.minLow = Math.min(position.minLow, bar.l)
    if (this.variant?.rTrailOnFiveMinCloses) return // variant E: the R-trail moves on 5-min closes (applyEvent)
    // R-trail: every +1R of open profit raises the stop 1R (from the next bar).
    const steps = Math.floor((position.maxHigh - position.entryPrice) / (RULEBOOK.management.rTrailStepR * position.riskPerShare) + 1e-9)
    if (steps >= 1) position.stop = Math.max(position.stop, position.entryPrice + (steps - 1) * RULEBOOK.management.rTrailStepR * position.riskPerShare)
  }

  private applyEvent(position: Position, event: FiveEvent) {
    if (event.end < position.entryTime + MIN_MS || position.pendingExit) return
    if (this.variant?.rTrailOnFiveMinCloses) {
      const step = RULEBOOK.management.rTrailStepR * position.riskPerShare
      const steps = Math.floor((event.close - position.entryPrice) / step + 1e-9)
      if (steps >= 1) position.stop = Math.max(position.stop, position.entryPrice + (steps - 1) * step)
    }
    position.eventsSeen += 1
    if (position.version === 'S') {
      const signal = position.signal
      if ((signal.setup === 'B' || signal.setup === 'B-retest') && signal.level != null && position.eventsSeen <= RULEBOOK.S.setupB.failedBreakoutBars && event.close < signal.level) {
        position.pendingExit = 'failed-breakout'
        return
      }
      if (event.exhaustion) {
        position.pendingExit = 'exhaustion'
        return
      }
      if (event.structureBreakAt != null && event.structureBreakAt > position.entryTime) {
        position.pendingExit = 'lower-high-low'
        return
      }
      position.runnerCount = event.runnerBelow ? position.runnerCount + 1 : 0
      if (position.scale1Done && position.runnerCount >= RULEBOOK.S.exits.runnerClosesBelow) position.pendingExit = 'below-50sma'
      return
    }
    if (event.belowVwap) {
      position.pendingExit = 'vwap-break'
      return
    }
    if (event.exhaustion) {
      position.pendingExit = 'keltner-exhaustion'
      return
    }
    position.runnerCount = event.runnerBelow ? position.runnerCount + 1 : 0
    if (position.scale2Done && position.runnerCount >= RULEBOOK.SP.exits.runnerClosesBelow) {
      position.pendingExit = 'below-8sma'
      return
    }
    if (event.tightenTo != null && event.tightenTo > position.stop) position.stop = event.tightenTo
  }

  private sell(position: Position, shares: number, price: number, reason: string, time: number) {
    const C = RULEBOOK.costs
    const notional = shares * price
    const fees = notional * C.secFeePerDollar + Math.min(shares * C.finraTafPerShare, C.finraTafMaxPerTrade) + C.commission
    const pnl = shares * (price - position.avgCost) - fees
    position.pnl += pnl
    position.fees += fees
    position.shares -= shares
    position.exitShares += shares
    position.exitValue += notional
    position.lastExitTime = time
    position.lastReason = reason
    this.equity += pnl
    if (position.shares > 0) {
      position.partials.push(`${reason} ${shares}@${price.toFixed(4)}`)
      return
    }
    this.positions.splice(this.positions.indexOf(position), 1)
    const r = position.pnl / position.riskDollars
    this.dayR += r
    if (r < A.lossThresholdR) {
      this.tickerLosses.set(position.symbol, (this.tickerLosses.get(position.symbol) ?? 0) + 1)
      this.consecutiveLosses += 1
      if (!this.halved && this.consecutiveLosses >= A.losingStreak.lossesToHalve) {
        this.halved = true
        this.winsSinceHalved = 0
      }
    } else {
      this.consecutiveLosses = 0
      if (this.halved && r > 0) {
        this.winsSinceHalved += 1
        if (this.winsSinceHalved >= A.losingStreak.winsToRestore) this.halved = false
      }
    }
    this.trades.push({
      run: this.run.id, date: position.frame.day, ticker: position.symbol, version: position.version, setup: position.signal.setup,
      entryIndex: position.entryIndex, entryTime: position.entryTime, entryPrice: position.entryPrice, avgCost: position.avgCost,
      stop: position.initialStop, shares: position.initialShares, maxShares: position.maxShares, units: position.units,
      exitTime: time, exitPrice: position.exitValue / position.exitShares, exitReason: reason, partials: position.partials.join('; '),
      rResult: r, pnl: position.pnl, fees: position.fees, equityAfter: this.equity, riskDollars: position.riskDollars,
      mfeR: (position.maxHigh - position.entryPrice) / position.riskPerShare, maeR: (position.minLow - position.entryPrice) / position.riskPerShare,
      holdMinutes: Math.round((time - position.entryTime) / MIN_MS), roomR: position.signal.roomR, gapPct: position.signal.gapPct, rvol: position.signal.rvol,
      note: position.signal.note,
    })
  }
}
