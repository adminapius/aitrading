import { decideEntry, simulatedMarginBuyingPower, strategyGuardrails, strategyRegime } from '../../lib/strategy'
import { paperExitLevels, paperExitReason } from '../../lib/paper-exits'
import { analyzeElliottWave, createElliottSignalDrafts, getElliottAllowedUses, isWave5FilterActive, type ElliottAnalysisResult, type ElliottRegime } from '../../lib/elliott-wave'
import { elliottWaveConfig } from '../../lib/elliott-wave-config'
import { scanConfig } from '../../lib/scan-config'
import { getLatestQuote } from './data'
import { DECISION_START_MINUTE, FLATTEN_MINUTE, MINUTE, type DayMarket, type MinuteBar, type MinuteCandidate } from './market'

export type StrategyId = 'A' | 'B' | 'C' | 'D'
export type RunSpec = { id: string; strategy: StrategyId; slippageMultiplier: number; label: string }
export type ExitKind = 'stop' | 'target' | 'flatten' | 'gap'

export type Trade = {
  run: string
  strategy: StrategyId
  date: string
  symbol: string
  regime: string
  rank: number
  entryAt: string
  entryPrice: number
  shares: number
  stop: number
  target: number | null
  exitAt: string
  exitPrice: number
  exitKind: ExitKind
  pnl: number
  r: number
  holdMinutes: number
  slippageFraction: number
  spreadSource: 'quote' | 'default'
  liquidityCapped: boolean
  t1Hit: boolean
  catalyst: string
  reason: string
}

type Position = {
  symbol: string
  regime: string
  rank: number
  entryAt: number
  entryPrice: number
  shares: number
  remaining: number
  stop: number
  target: number | null
  t2: number | null
  riskPerShare: number
  initialRisk: number
  slippageFraction: number
  spreadSource: 'quote' | 'default'
  liquidityCapped: boolean
  phase: 'standard' | 'wave3' | 'wave4'
  t1Hit: boolean
  t1Shares: number
  trailingStop: number
  realized: number
  exitShares: number
  exitNotional: number
  catalyst: string
  reason: string
}

export type RunState = {
  spec: RunSpec
  equity: number
  trades: Trade[]
  equityCurve: Array<{ date: string; equity: number }>
  usedSetups: Set<string>
  counters: Record<string, number>
}

export type SharedDayContext = {
  analyses: Map<string, ElliottAnalysisResult>
}

export const DEFAULT_SLIPPAGE_SUB5 = Number(process.env.BACKTEST_DEFAULT_SLIPPAGE_SUB5) || 0.005
export const DEFAULT_SLIPPAGE_OVER5 = Number(process.env.BACKTEST_DEFAULT_SLIPPAGE_OVER5) || 0.0025
export const LIQUIDITY_CAP_FRACTION = 0.05
export const STARTING_EQUITY = 2_000

export function createRunState(spec: RunSpec): RunState {
  return { spec, equity: STARTING_EQUITY, trades: [], equityCurve: [], usedSetups: new Set(), counters: {} }
}

function bump(state: RunState, key: string, amount = 1) {
  state.counters[key] = (state.counters[key] ?? 0) + amount
}

export function analysisFor(shared: SharedDayContext, market: DayMarket, symbol: string, minute: number, rvol: number, regimeRvol: number) {
  const key = `${symbol}@${minute}@${rvol.toFixed(4)}@${regimeRvol}`
  const cached = shared.analyses.get(key)
  if (cached) return cached
  const now = market.midnight + minute * MINUTE
  const data = market.symbols.get(symbol)
  const count = market.closedCount(symbol, now)
  const analysis = analyzeElliottWave({ bars: data ? data.elliottBars.slice(0, count) : [], now: new Date(now), rvol, regimeRvol })
  shared.analyses.set(key, analysis)
  return analysis
}

type Mark = { bid: number; ask: number; mid: number; spreadPct: number; source: 'quote' }

async function executableQuote(market: DayMarket, candidate: MinuteCandidate, now: number): Promise<Mark | null> {
  const quote = await getLatestQuote(market.day, candidate.symbol, new Date(now), scanConfig.maxQuoteAgeSeconds)
  if (!quote || !(quote.bp > 0) || !(quote.ap >= quote.bp)) return null
  const mid = (quote.bp + quote.ap) / 2
  const tolerance = mid * 0.005
  if (candidate.price < quote.bp - tolerance || candidate.price > quote.ap + tolerance) return null
  return { bid: quote.bp, ask: quote.ap, mid, spreadPct: ((quote.ap - quote.bp) / mid) * 100, source: 'quote' }
}

function scannerSpreadPasses(mark: Mark, candidate: MinuteCandidate, now: number) {
  const regime = strategyRegime(new Date(now))
  const maxSpread = Math.min(scanConfig.maxSpreadPercent, regime.spread * 100)
  return mark.spreadPct <= maxSpread && (candidate.volume ?? 0) * mark.mid >= regime.dollarVolume && mark.mid >= scanConfig.minPrice
}

function slippageFraction(mark: Mark | null, price: number, multiplier: number) {
  const base = mark ? Math.max(0, (mark.ask - mark.bid) / 2 / mark.mid) : price < 5 ? DEFAULT_SLIPPAGE_SUB5 : DEFAULT_SLIPPAGE_OVER5
  return base * multiplier
}

function closeShares(position: Position, shares: number, price: number) {
  position.realized += (price - position.entryPrice) * shares
  position.remaining -= shares
  position.exitShares += shares
  position.exitNotional += price * shares
}

function finalize(state: RunState, market: DayMarket, position: Position, kind: ExitKind, at: number) {
  const trade: Trade = {
    run: state.spec.id,
    strategy: state.spec.strategy,
    date: market.day,
    symbol: position.symbol,
    regime: position.regime,
    rank: position.rank,
    entryAt: new Date(position.entryAt).toISOString(),
    entryPrice: position.entryPrice,
    shares: position.shares,
    stop: position.stop,
    target: position.target,
    exitAt: new Date(at).toISOString(),
    exitPrice: position.exitShares ? position.exitNotional / position.exitShares : position.entryPrice,
    exitKind: kind,
    pnl: position.realized,
    r: position.initialRisk > 0 ? position.realized / position.initialRisk : 0,
    holdMinutes: Math.max(1, Math.round((at - position.entryAt) / MINUTE)),
    slippageFraction: position.slippageFraction,
    spreadSource: position.spreadSource,
    liquidityCapped: position.liquidityCapped,
    t1Hit: position.t1Hit,
    catalyst: position.catalyst,
    reason: position.reason,
  }
  state.trades.push(trade)
  return trade
}

function evaluateBar(state: RunState, market: DayMarket, shared: SharedDayContext, position: Position, bar: MinuteBar, minute: number): ExitKind | null {
  const slip = position.slippageFraction
  const exitAt = bar.t + MINUTE
  if (position.phase === 'standard') {
    const levels = paperExitLevels({ entry_price: position.entryPrice, stop_price: position.stop, target_price: position.target, metadata: { riskPerShare: position.riskPerShare } })
    const record = { entry_price: position.entryPrice, stop_price: levels.stopPrice, target_price: levels.targetPrice, metadata: { riskPerShare: position.riskPerShare } }
    if (levels.stopPrice != null && bar.o <= levels.stopPrice) {
      closeShares(position, position.remaining, bar.o * (1 - slip))
      return 'gap'
    }
    if (paperExitReason(record, { price: bar.l, bid: bar.l }, false) === 'protective stop reached') {
      closeShares(position, position.remaining, levels.stopPrice! * (1 - slip))
      return 'stop'
    }
    if (paperExitReason(record, { price: bar.h, bid: bar.h }, false) === 'profit target reached') {
      closeShares(position, position.remaining, Math.max(levels.targetPrice!, bar.o) * (1 - slip))
      return 'target'
    }
    return null
  }

  const stopLevel = position.t1Hit ? position.trailingStop : position.stop
  if (bar.o <= stopLevel) {
    closeShares(position, position.remaining, bar.o * (1 - slip))
    return 'gap'
  }
  if (bar.l <= stopLevel) {
    closeShares(position, position.remaining, stopLevel * (1 - slip))
    return 'stop'
  }
  const target = position.t1Hit ? position.t2 : position.target
  if (target != null && bar.h >= target) {
    const price = Math.max(target, bar.o) * (1 - slip)
    if (position.phase === 'wave3' && !position.t1Hit) {
      const shares = Math.min(position.remaining, Math.max(1, position.t1Shares))
      closeShares(position, shares, price)
      position.t1Hit = true
      const swing = analysisFor(shared, market, position.symbol, minute, 0, 0).latestSwingLow
      position.trailingStop = Math.max(position.entryPrice, swing ?? position.entryPrice)
      return position.remaining <= 0 ? 'target' : null
    }
    closeShares(position, position.remaining, price)
    return 'target'
  }
  if (position.t1Hit) {
    const swing = analysisFor(shared, market, position.symbol, minute, 0, 0).latestSwingLow
    if (swing != null) position.trailingStop = Math.max(position.trailingStop, swing)
  }
  return null
}

export async function simulateDay(state: RunState, market: DayMarket, shared: SharedDayContext) {
  const { spec } = state
  const positions: Position[] = []
  const cooldownUntil = new Map<string, number>()
  const tracked = new Map<string, { candidate: MinuteCandidate; startedAt: number }>()
  const dayStartEquity = state.equity
  let realizedToday = 0

  const markOf = (position: Position, now: number) => {
    const bar = market.lastClosedBar(position.symbol, now)
    return bar && bar.t >= position.entryAt ? bar.c : position.entryPrice
  }

  const closePosition = (position: Position, kind: ExitKind, at: number) => {
    const trade = finalize(state, market, position, kind, at)
    realizedToday += trade.pnl
    state.equity += trade.pnl
    cooldownUntil.set(position.symbol, at + strategyGuardrails.reentryCooldownMinutes * MINUTE)
    positions.splice(positions.indexOf(position), 1)
    bump(state, `exit_${kind}`)
  }

  for (let minute = DECISION_START_MINUTE; minute <= FLATTEN_MINUTE + 1; minute += 1) {
    const now = market.midnight + minute * MINUTE

    for (const position of [...positions]) {
      const bar = market.barStarting(position.symbol, now - MINUTE)
      if (bar && bar.t >= position.entryAt) {
        const kind = evaluateBar(state, market, shared, position, bar, minute)
        if (kind) {
          closePosition(position, kind, bar.t + MINUTE)
          continue
        }
      }
      if (minute === FLATTEN_MINUTE + 1) {
        const flattenBar = market.barStarting(position.symbol, now - MINUTE) ?? market.lastClosedBar(position.symbol, now)
        const price = flattenBar && flattenBar.t >= position.entryAt ? flattenBar.c : position.entryPrice
        closeShares(position, position.remaining, price * (1 - position.slippageFraction))
        closePosition(position, 'flatten', now)
      }
    }
    if (minute >= FLATTEN_MINUTE) continue

    const regime = strategyRegime(new Date(now))
    if (regime.name === 'exits-only') continue
    const candidates = market.candidatesAt(minute)
    const unrealized = positions.reduce((sum, position) => sum + (markOf(position, now) - position.entryPrice) * position.remaining, 0)
    const equity = dayStartEquity + realizedToday + unrealized
    const exposure = positions.reduce((sum, position) => sum + markOf(position, now) * position.remaining, 0)
    const cash = Math.max(0, equity - exposure)
    const dailyLossBlocked = equity - dayStartEquity <= -strategyGuardrails.maxDailyLossFraction * dayStartEquity
    const exposureHeadroom = Math.max(0, equity * strategyGuardrails.maxAggregateExposureFraction - exposure)
    let remainingAllocation = Math.min(exposureHeadroom, simulatedMarginBuyingPower(equity, cash, exposure, strategyGuardrails.minimumMarginEquity))

    const accountBlocks = (symbol: string) => {
      if (positions.some((position) => position.symbol === symbol)) return 'open'
      if ((cooldownUntil.get(symbol) ?? 0) > now) return 'cooldown'
      if (positions.length >= strategyGuardrails.maxOpenPositions) return 'max_positions'
      if (dailyLossBlocked) return 'daily_loss'
      return null
    }

    const openAt = (candidate: MinuteCandidate, mark: Mark, input: { shares: number; stop: number; target: number | null; t2: number | null; riskPerShare: number | null; phase: Position['phase']; reason: string }) => {
      const fillBar = market.barAtOrAfter(candidate.symbol, now)
      if (!fillBar || fillBar.t >= market.midnight + FLATTEN_MINUTE * MINUTE) return bump(state, 'skip_no_fill_bar')
      const slip = slippageFraction(mark, fillBar.o, spec.slippageMultiplier)
      const fill = fillBar.o * (1 + slip)
      const cap = Math.floor(fillBar.v * LIQUIDITY_CAP_FRACTION)
      const allocationCap = Math.floor(remainingAllocation / fill)
      const shares = Math.min(input.shares, cap, allocationCap)
      if (shares < 1) return bump(state, cap < 1 ? 'skip_liquidity' : 'skip_allocation')
      const riskPerShare = input.riskPerShare ?? fill - input.stop
      const stop = input.phase === 'standard' ? Math.max(0.01, fill - riskPerShare) : input.stop
      const target = input.phase === 'standard' ? fill + riskPerShare * 1.5 : input.target
      if (!(fill > stop)) return bump(state, 'skip_fill_below_stop')
      positions.push({
        symbol: candidate.symbol,
        regime: regime.name,
        rank: candidate.rank,
        entryAt: fillBar.t,
        entryPrice: fill,
        shares,
        remaining: shares,
        stop,
        target,
        t2: input.t2,
        riskPerShare,
        initialRisk: (fill - stop) * shares,
        slippageFraction: slip,
        spreadSource: mark ? 'quote' : 'default',
        liquidityCapped: shares === cap && cap < input.shares,
        phase: input.phase,
        t1Hit: false,
        t1Shares: Math.floor(shares * elliottWaveConfig.setup.wave3FirstTargetFraction),
        trailingStop: stop,
        realized: 0,
        exitShares: 0,
        exitNotional: 0,
        catalyst: candidate.catalystSummary ?? '',
        reason: input.reason,
      })
      remainingAllocation = Math.max(0, remainingAllocation - shares * fill)
      bump(state, 'entries')
    }

    if (spec.strategy === 'A' || spec.strategy === 'B') {
      for (const candidate of candidates) {
        if (!candidate.scannerEligible || !candidate.entryEligibleSymbol) continue
        if (accountBlocks(candidate.symbol)) continue
        const preliminary = decideEntry(candidate, equity, new Date(now), remainingAllocation)
        if (preliminary.action !== 'enter') continue
        const mark = await executableQuote(market, candidate, now)
        if (!mark) { bump(state, 'skip_no_quote'); continue }
        if (!scannerSpreadPasses(mark, candidate, now)) { bump(state, 'skip_spread'); continue }
        const decision = decideEntry({ ...candidate, price: mark.ask, bid: mark.bid, ask: mark.ask, spreadPct: mark.spreadPct }, equity, new Date(now), remainingAllocation)
        if (decision.action !== 'enter') { bump(state, 'skip_decide_at_ask'); continue }
        if (spec.strategy === 'B') {
          const uses = getElliottAllowedUses(regime.name as ElliottRegime)
          const analysis = analysisFor(shared, market, candidate.symbol, minute, candidate.relativeVolume ?? 0, regime.rvol)
          if (uses.exhaustionFilter && isWave5FilterActive(analysis)) { bump(state, 'blocked_wave5'); continue }
        }
        openAt(candidate, mark, { shares: decision.suggestedShares, stop: 0, target: null, t2: null, riskPerShare: decision.riskPerShare, phase: 'standard', reason: decision.reason })
      }
      continue
    }

    const cutoff = now - elliottWaveConfig.trackingWindowMinutes * MINUTE
    for (const [symbol, entry] of tracked) if (entry.startedAt <= cutoff) tracked.delete(symbol)
    const eligibleNow = new Set<string>()
    for (const candidate of candidates) {
      const existing = tracked.get(candidate.symbol)
      if (existing) existing.candidate = candidate
      if (!candidate.scannerEligible) continue
      eligibleNow.add(candidate.symbol)
      tracked.set(candidate.symbol, { candidate, startedAt: existing?.startedAt ?? now })
    }
    const rule = spec.strategy === 'C' ? 'ew_wave3' : 'ew_wave4'
    for (const [symbol, entry] of [...tracked]) {
      const last = market.lastClosedBar(symbol, now)
      if (!last) continue
      const analysis = analysisFor(shared, market, symbol, minute, entry.candidate.relativeVolume ?? 0, regime.rvol)
      const drafts = createElliottSignalDrafts({
        analysis,
        regime: regime.name as ElliottRegime,
        equity,
        currentExposure: exposure,
        mark: { bid: last.c, ask: last.c, price: last.c, at: new Date(now).toISOString() },
        now: new Date(now),
        actualEntry: false,
        allowEntries: eligibleNow.has(symbol),
      })
      if (analysis.invalidationReason) tracked.delete(symbol)
      const draft = drafts.find((item) => item.rule === rule && item.wouldBeShares > 0 && item.triggeredAt && item.stop != null)
      if (!draft) continue
      const setupKey = `${market.day}|${symbol}|${rule}|${String(draft.metadata.setupAt)}`
      if (state.usedSetups.has(setupKey)) continue
      bump(state, 'elliott_triggers')
      if (accountBlocks(symbol)) { bump(state, 'skip_account_block'); continue }
      const candidate = { ...entry.candidate, price: last.c }
      const mark = await executableQuote(market, candidate, now)
      if (!mark) { bump(state, 'skip_no_quote'); continue }
      if (!scannerSpreadPasses(mark, candidate, now)) { bump(state, 'skip_spread'); continue }
      state.usedSetups.add(setupKey)
      openAt(candidate, mark, {
        shares: draft.wouldBeShares,
        stop: draft.stop!,
        target: draft.t1,
        t2: draft.t2,
        riskPerShare: null,
        phase: rule === 'ew_wave3' ? 'wave3' : 'wave4',
        reason: `${rule} trigger ${draft.triggerPrice?.toFixed(4)} confidence ${analysis.waveConfidence}`,
      })
    }
  }

  state.equityCurve.push({ date: market.day, equity: state.equity })
}
