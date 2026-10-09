import { paperExecutionGuardrails } from './paper-trading'
import { paperExitReason, paperExitRequestedPrice } from './paper-exits'
import { elliottWaveConfig } from './elliott-wave-config'
import { strategyGuardrails } from './strategy'

export type ElliottBar = {
  t: string
  h: number
  l: number
  c: number
  v: number
  vw?: number | null
}

export type ElliottPivot = {
  label: number
  kind: 'low' | 'high'
  price: number
  at: string
  index: number
  volume: number
  rsi: number | null
}

export type ElliottAnalysis = {
  currentWave: number
  pivots: ElliottPivot[]
  impulsePivots: ElliottPivot[]
  invalidationLevel: number | null
  invalidationReason: string | null
  valid: boolean
  waveConfidence: number
  wave2Retrace: number | null
  exhaustion: boolean
  wave5InProgress: boolean
  wave5Complete: boolean
  correctionComplete: boolean
  wouldExitTrendComplete: boolean
  latestSwingLow: number | null
  confluence: {
    wave1Rvol: boolean
    wave2Retrace: boolean
    wave2LowerVolume: boolean
    wave2AboveVwap: boolean
    wave3Volume: boolean
    wave3RsiPeak: boolean
    wave5Exhaustion: boolean
  }
}

export type ElliottRegime = keyof typeof elliottWaveConfig.minimumConfidence

export type ShadowSignalDraft = {
  rule: 'ew_wave3' | 'ew_wave4' | 'ew_block_wave5' | 'ew_exit_signal'
  triggerPrice: number | null
  stop: number | null
  t1: number | null
  t2: number | null
  wouldBeShares: number
  triggeredAt: string | null
  outcome: 'stop' | 't1' | 't2' | 'timeout' | 'flatten' | null
  outcomeAt: string | null
  fillPrice: number | null
  rMultiple: number | null
  metadata: Record<string, unknown>
}

export type ShadowOutcomeSignal = {
  stop: number
  t1: number
  t2: number
  triggered_at: string | null
  would_be_shares: number
  metadata: Record<string, unknown>
}

export type ShadowOutcomeUpdate = {
  outcome: 'stop' | 't1' | 't2' | 'timeout' | 'flatten' | null
  outcomeAt: string | null
  fillPrice: number | null
  rMultiple: number | null
  metadata: Record<string, unknown>
}

const MINUTE_MS = 60_000
const FIVE_MINUTE_MS = 5 * MINUTE_MS
const SESSION_OPEN_MINUTES = elliottWaveConfig.pivot.premarketStartMinute
const EASTERN_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

// Intl formatting dominates analysis time; New York offsets are whole hours, so the result depends only on the UTC minute.
const easternMinuteCache = new Map<number, number>()

function easternMinute(value: Date) {
  const key = Math.floor(value.getTime() / 60_000)
  const cached = easternMinuteCache.get(key)
  if (cached !== undefined) return cached
  const parts = EASTERN_FORMAT.formatToParts(value)
  const minute = Number(parts.find((part) => part.type === 'hour')?.value ?? 0) * 60
    + Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  if (easternMinuteCache.size >= 50_000) easternMinuteCache.clear()
  easternMinuteCache.set(key, minute)
  return minute
}

function validBar(bar: ElliottBar) {
  return Number.isFinite(Date.parse(bar.t)) && [bar.h, bar.l, bar.c, bar.v].every(Number.isFinite)
    && bar.h >= bar.l && bar.h > 0 && bar.l > 0 && bar.c > 0 && bar.v >= 0
}

function getClosedBars(bars: ElliottBar[], now: Date) {
  return bars
    .filter(validBar)
    .filter((bar) => Date.parse(bar.t) + MINUTE_MS <= now.getTime())
    .sort((left, right) => Date.parse(left.t) - Date.parse(right.t))
    .filter((bar, index, ordered) => index === 0 || bar.t !== ordered[index - 1].t)
}

function fiveMinuteAtrByBar(bars: ElliottBar[]) {
  const groups = new Map<number, ElliottBar[]>()
  for (const bar of bars) {
    const bucket = Math.floor(Date.parse(bar.t) / FIVE_MINUTE_MS) * FIVE_MINUTE_MS
    const group = groups.get(bucket) ?? []
    group.push(bar)
    groups.set(bucket, group)
  }
  const completed: Array<{ end: number; high: number; low: number; close: number }> = []
  for (const [start, group] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    if (!group.length) continue
    completed.push({
      end: start + FIVE_MINUTE_MS,
      high: Math.max(...group.map((bar) => bar.h)),
      low: Math.min(...group.map((bar) => bar.l)),
      close: group.at(-1)!.c,
    })
  }
  const output = new Map<number, number>()
  const period = elliottWaveConfig.pivot.fiveMinuteAtrPeriod
  for (const bar of bars) {
    const cutoff = Date.parse(bar.t) + MINUTE_MS
    let low = 0
    let high = completed.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (completed[middle].end <= cutoff) low = middle + 1
      else high = middle
    }
    const completedCount = low
    const firstRecent = Math.max(0, completedCount - period)
    if (completedCount === firstRecent) continue
    let total = 0
    for (let index = firstRecent; index < completedCount; index += 1) {
      const item = completed[index]
      const previousClose = completed[index - 1]?.close ?? item.close
      total += Math.max(item.high - item.low, Math.abs(item.high - previousClose), Math.abs(item.low - previousClose))
    }
    output.set(Date.parse(bar.t), total / (completedCount - firstRecent))
  }
  return output
}

export const elliottInternalsForTest = { easternMinute, fiveMinuteAtrByBar }

function sessionVwapSeries(bars: ElliottBar[]) {
  let totalVolume = 0
  let weightedPrice = 0
  return bars.map((bar) => {
    totalVolume += bar.v
    weightedPrice += ((bar.h + bar.l + bar.c) / 3) * bar.v
    return totalVolume > 0 ? weightedPrice / totalVolume : null
  })
}

function rsiSeries(bars: ElliottBar[]) {
  const period = elliottWaveConfig.pivot.rsiPeriod
  return bars.map((_, index) => {
    if (index < period) return null
    let gains = 0
    let losses = 0
    for (let offset = index - period + 1; offset <= index; offset += 1) {
      const change = bars[offset].c - bars[offset - 1].c
      if (change > 0) gains += change
      else losses -= change
    }
    if (losses === 0) return gains === 0 ? 50 : 100
    const averageGain = gains / period
    const averageLoss = losses / period
    return 100 - 100 / (1 + averageGain / averageLoss)
  })
}

function detectPivots(bars: ElliottBar[], rsi: Array<number | null>, atrByBar: Map<number, number>) {
  const pivots: ElliottPivot[] = []
  if (bars.length < 2) return pivots
  let lowExtreme = { index: 0, price: bars[0].l }
  let highExtreme = { index: 0, price: bars[0].h }
  let direction: 'up' | 'down' | null = null

  const reversalSize = (bar: ElliottBar) => {
    const priceThreshold = bar.c * elliottWaveConfig.pivot.minimumPriceFraction
    const atr = atrByBar.get(Date.parse(bar.t))
    return Math.max(atr ? atr * elliottWaveConfig.pivot.atrMultiplier : 0, priceThreshold)
  }

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]
    const minute = easternMinute(new Date(bar.t))
    if (minute >= SESSION_OPEN_MINUTES && minute < elliottWaveConfig.pivot.premarketEndMinute
      && bar.v < elliottWaveConfig.pivot.premarketMinimumBarVolume) continue

    if (bar.l < lowExtreme.price) lowExtreme = { index, price: bar.l }
    if (bar.h > highExtreme.price) highExtreme = { index, price: bar.h }

    if (direction == null) {
      if (highExtreme.price - lowExtreme.price >= reversalSize(bar)) {
        pivots.push({ label: 0, kind: 'low', price: lowExtreme.price, at: bars[lowExtreme.index].t, index: lowExtreme.index, volume: bars[lowExtreme.index].v, rsi: rsi[lowExtreme.index] })
        direction = 'up'
      }
      continue
    }

    if (direction === 'down') {
      const prior = pivots.at(-1)!
      if (bar.l < lowExtreme.price) lowExtreme = { index, price: bar.l }
      if (index > lowExtreme.index && lowExtreme.index > prior.index && bar.h - lowExtreme.price >= reversalSize(bar)) {
        pivots.push({ label: pivots.length, kind: 'low', price: lowExtreme.price, at: bars[lowExtreme.index].t, index: lowExtreme.index, volume: bars[lowExtreme.index].v, rsi: rsi[lowExtreme.index] })
        direction = 'up'
        highExtreme = { index, price: bar.h }
      }
      continue
    }

    const prior = pivots.at(-1)!
    if (bar.h > highExtreme.price) highExtreme = { index, price: bar.h }
    if (index > highExtreme.index && highExtreme.index > prior.index && highExtreme.price - bar.l >= reversalSize(bar)) {
      pivots.push({ label: pivots.length, kind: 'high', price: highExtreme.price, at: bars[highExtreme.index].t, index: highExtreme.index, volume: bars[highExtreme.index].v, rsi: rsi[highExtreme.index] })
      direction = 'down'
      lowExtreme = { index, price: bar.l }
    }
  }
  return pivots
}

function barsBetween(bars: ElliottBar[], start: number, end: number) {
  return bars.filter((bar) => Date.parse(bar.t) >= start && Date.parse(bar.t) <= end)
}

function segmentVolume(bars: ElliottBar[], left: ElliottPivot, right: ElliottPivot) {
  return barsBetween(bars, Date.parse(left.at), Date.parse(right.at)).reduce((sum, bar) => sum + bar.v, 0)
}

function segmentRsiPeak(bars: ElliottBar[], rsi: Array<number | null>, left: ElliottPivot, right: ElliottPivot) {
  const values = barsBetween(bars, Date.parse(left.at), Date.parse(right.at))
    .map((bar) => rsi[bars.indexOf(bar)])
    .filter((value): value is number => value != null)
  return values.length ? Math.max(...values) : null
}

function getImpulse(pivots: ElliottPivot[]) {
  for (let start = 0; start <= pivots.length - 6; start += 1) {
    const slice = pivots.slice(start, start + 6)
    if (slice.every((pivot, index) => pivot.kind === (index % 2 === 0 ? 'low' : 'high'))) return slice
  }
  return pivots.slice(0, Math.min(pivots.length, 6))
}

export function validateImpulsePivots(pivots: ElliottPivot[]) {
  if (pivots.length < 3) return { valid: true, invalidationLevel: null as number | null, reason: null as string | null }
  const wave0 = pivots[0]
  const wave1 = pivots[1]
  const wave2 = pivots[2]
  if (wave2.price < wave0.price) return { valid: false, invalidationLevel: wave0.price, reason: 'wave2_broke_wave0' }
  if (pivots.length >= 5 && pivots[4].price < wave1.price) return { valid: false, invalidationLevel: wave1.price, reason: 'wave4_overlapped_wave1' }
  if (pivots.length >= 6) {
    const wave1Length = wave1.price - wave0.price
    const wave3Length = pivots[3].price - wave2.price
    const wave5Length = pivots[5].price - pivots[4].price
    if (wave3Length < Math.min(wave1Length, wave5Length)) return { valid: false, invalidationLevel: wave2.price, reason: 'wave3_shortest' }
  }
  return { valid: true, invalidationLevel: null, reason: null }
}

export function analyzeElliottWave(input: { bars: ElliottBar[]; now: Date; rvol: number; regimeRvol: number }) {
  const bars = getClosedBars(input.bars, input.now)
  const rsi = rsiSeries(bars)
  const sessionVwap = sessionVwapSeries(bars)
  const atrByBar = fiveMinuteAtrByBar(bars)
  const pivots = detectPivots(bars, rsi, atrByBar)
  const impulsePivots = getImpulse(pivots)
  const validation = validateImpulsePivots(impulsePivots)
  const [wave0, wave1, wave2, wave3, wave4, wave5] = impulsePivots
  const wave1Length = wave0 && wave1 ? wave1.price - wave0.price : 0
  const wave2Retrace = wave1Length > 0 && wave1 && wave2 ? (wave1.price - wave2.price) / wave1Length : null
  const wave1Rvol = Boolean(wave1 && input.rvol >= input.regimeRvol)
  const wave2RetracePass = wave2Retrace != null && wave2Retrace >= elliottWaveConfig.confluence.wave2RetraceMinimum
    && wave2Retrace <= elliottWaveConfig.confluence.wave2RetraceMaximum
  const wave1Volume = wave0 && wave1 ? segmentVolume(bars, wave0, wave1) : 0
  const wave2Volume = wave1 && wave2 ? segmentVolume(bars, wave1, wave2) : Number.POSITIVE_INFINITY
  const wave3Volume = wave2 && wave3 ? segmentVolume(bars, wave2, wave3) : 0
  const wave2Bars = wave1 && wave2 ? barsBetween(bars, Date.parse(wave1.at), Date.parse(wave2.at)) : []
  const wave2AboveVwap = Boolean(wave2Bars.length && wave2Bars.every((bar) => {
    const index = bars.indexOf(bar)
    const vwap = sessionVwap[index]
    return vwap != null && bar.l >= vwap
  }))
  const wave3RsiPeak = Boolean(wave1 && wave2 && wave3 && segmentRsiPeak(bars, rsi, wave2, wave3) != null
    && segmentRsiPeak(bars, rsi, wave2, wave3)! > (segmentRsiPeak(bars, rsi, wave0!, wave1) ?? 0))
  const wave5Exhaustion = Boolean(wave3 && wave5 && ((wave5.rsi != null && wave3.rsi != null && wave5.rsi < wave3.rsi)
    || segmentVolume(bars, wave4!, wave5) < wave3Volume))
  const confluence = {
    wave1Rvol,
    wave2Retrace: wave2RetracePass,
    wave2LowerVolume: Boolean(wave0 && wave1 && wave2 && wave2Volume < wave1Volume),
    wave2AboveVwap,
    wave3Volume: Boolean(wave2 && wave3 && wave3Volume > wave1Volume),
    wave3RsiPeak,
    wave5Exhaustion,
  }
  const wave2Pass = confluence.wave2Retrace && confluence.wave2LowerVolume && confluence.wave2AboveVwap
  const confidenceChecks = [confluence.wave1Rvol, wave2Pass, confluence.wave3Volume, confluence.wave3RsiPeak, confluence.wave5Exhaustion]
  const waveConfidence = confidenceChecks.filter(Boolean).length * elliottWaveConfig.confluence.confidencePoints
  const wave5InProgress = validation.valid && impulsePivots.length === 5
  const wave5Complete = validation.valid && impulsePivots.length >= 6
  const correctionPivots = pivots.slice((pivots.indexOf(wave5 ?? impulsePivots.at(-1)!) + 1))
  const correctionComplete = correctionPivots.length >= 3
    && correctionPivots.slice(0, 3).every((pivot, index) => pivot.kind === (index % 2 === 0 ? 'low' : 'high'))
  const wave5At = wave5?.at ? Date.parse(wave5.at) : Number.NaN
  const wave5Age = Number.isFinite(wave5At) ? input.now.getTime() - wave5At : 0
  const latest = bars.at(-1)
  const wouldExitTrendComplete = Boolean(wave5Complete && wave4 && latest && latest.l < wave4.price)
  return {
    closedBars: bars,
    currentWave: !impulsePivots.length ? 0 : impulsePivots.length === 1 ? 0 : Math.min(5, impulsePivots.length),
    pivots,
    impulsePivots,
    invalidationLevel: validation.invalidationLevel ?? (wave0?.price ?? null),
    invalidationReason: validation.reason,
    valid: validation.valid,
    waveConfidence,
    wave2Retrace,
    exhaustion: (wave5InProgress || wave5Complete) && wave5Exhaustion,
    wave5InProgress,
    wave5Complete,
    correctionComplete,
    wave5Age,
    wouldExitTrendComplete,
    latestSwingLow: [...pivots].reverse().find((pivot) => pivot.kind === 'low')?.price ?? null,
    confluence,
  }
}

export type ElliottAnalysisResult = ReturnType<typeof analyzeElliottWave>

export function isWave5FilterActive(analysis: ElliottAnalysisResult) {
  return analysis.valid && (analysis.wave5InProgress || (analysis.wave5Complete && analysis.exhaustion))
    && !analysis.correctionComplete && (!analysis.wave5Complete || analysis.wave5Age < elliottWaveConfig.setup.wave5FlagMinutes * 60_000)
}

export function getElliottAllowedUses(regime: ElliottRegime) {
  const toggles = elliottWaveConfig.regimes[regime]
  return {
    exhaustionFilter: elliottWaveConfig.enabled && elliottWaveConfig.uses.exhaustionFilter && toggles.exhaustionFilter,
    wave3Entry: elliottWaveConfig.enabled && elliottWaveConfig.uses.wave3Entry && toggles.wave3Entry,
    wave4Reentry: elliottWaveConfig.enabled && elliottWaveConfig.uses.wave4Reentry && toggles.wave4Reentry,
    minimumConfidence: elliottWaveConfig.minimumConfidence[regime],
  }
}

function calculateShares(input: { equity: number; price: number; stop: number; exposure: number; sizeFraction?: number }) {
  const riskPerShare = input.price - input.stop
  if (![input.equity, input.price, input.stop, input.exposure, riskPerShare].every(Number.isFinite) || riskPerShare <= 0) return 0
  const riskBudget = input.equity * strategyGuardrails.riskPerTradeFraction * (input.sizeFraction ?? 1)
  const positionCap = input.equity * strategyGuardrails.maxPositionFraction
  const exposureRoom = Math.max(0, input.equity * strategyGuardrails.maxAggregateExposureFraction - input.exposure)
  return Math.max(0, Math.floor(Math.min(riskBudget / riskPerShare, positionCap / input.price, exposureRoom / input.price)))
}

export function createElliottSignalDrafts(input: {
  analysis: ElliottAnalysisResult
  regime: ElliottRegime
  equity: number
  currentExposure: number
  mark: { bid: number; ask: number; price: number; at: string }
  now: Date
  actualEntry: boolean
  allowEntries?: boolean
  linkedTradeId?: string | null
}) {
  const { analysis, regime, mark, now } = input
  const uses = getElliottAllowedUses(regime)
  const minConfidencePassed = analysis.waveConfidence >= uses.minimumConfidence
  const drafts: ShadowSignalDraft[] = []
  const pivots = analysis.impulsePivots
  const [wave0, wave1, wave2, wave3, wave4, wave5] = pivots
  const common = { waveConfidence: analysis.waveConfidence, pivots: analysis.impulsePivots }
  if (uses.exhaustionFilter && input.actualEntry && isWave5FilterActive(analysis)) {
    drafts.push({ rule: 'ew_block_wave5', triggerPrice: mark.ask, stop: null, t1: null, t2: null, wouldBeShares: 0, triggeredAt: mark.at, outcome: null, outcomeAt: null, fillPrice: null, rMultiple: null, metadata: { ...common, linkedTradeId: input.linkedTradeId ?? null, blockReason: analysis.wave5InProgress ? 'wave5_in_progress' : 'wave5_exhaustion', realEntryObserved: true } })
  }
  const bars = analysis.closedBars
  const latest = bars.at(-1)
  const previous = bars.at(-2)
  const barVolumeRising = Boolean(latest && previous && latest.v > previous.v)
  const wave1Length = wave0 && wave1 ? wave1.price - wave0.price : 0
  if (input.allowEntries !== false && uses.wave3Entry && minConfidencePassed && analysis.valid && analysis.currentWave === 3 && !analysis.wave5Complete && wave0 && wave1 && wave2 && latest && previous) {
    const setupStart = Date.parse(wave2.at)
    const timedOut = now.getTime() > setupStart + elliottWaveConfig.setup.wave3TimeoutMinutes * 60_000
    const trigger = latest.h > wave1.price && barVolumeRising
    if (!timedOut && trigger && wave1Length > 0) {
      const stop = wave2.price * (1 - elliottWaveConfig.setup.stopBufferFraction)
      const fillPrice = mark.ask * (1 + paperExecutionGuardrails().slippageFraction)
      const shares = calculateShares({ equity: input.equity, price: fillPrice, stop, exposure: input.currentExposure })
      if (shares > 0) drafts.push({
        rule: 'ew_wave3', triggerPrice: wave1.price, stop, t1: wave2.price + wave1Length * elliottWaveConfig.setup.wave3TargetOneMultiple,
        t2: wave2.price + wave1Length * elliottWaveConfig.setup.wave3TargetTwoMultiple, wouldBeShares: shares, triggeredAt: mark.at,
        outcome: null, outcomeAt: null, fillPrice, rMultiple: null,
        metadata: { ...common, setupAt: wave2.at, observedAsk: mark.ask, entryFill: fillPrice, entrySlippage: fillPrice - mark.ask, initialRiskDollars: (fillPrice - stop) * shares, t1Shares: Math.floor(shares * elliottWaveConfig.setup.wave3FirstTargetFraction), t1Hit: false, partialRealizedPnl: 0, remainingShares: shares, trailingStop: stop, triggerBar: latest.t, triggerVolume: latest.v, priorBarVolume: previous.v },
      })
    } else if (timedOut) {
      drafts.push({ rule: 'ew_wave3', triggerPrice: wave1.price, stop: wave2.price, t1: null, t2: null, wouldBeShares: 0, triggeredAt: null, outcome: 'timeout', outcomeAt: now.toISOString(), fillPrice: null, rMultiple: null, metadata: { ...common, setupAt: wave2.at, reason: 'wave3_setup_expired_without_breakout' } })
    }
  }
  if (input.allowEntries !== false && uses.wave4Reentry && minConfidencePassed && analysis.valid && analysis.currentWave === 5 && pivots.length === 5 && wave0 && wave1 && wave2 && wave3 && wave4 && latest && previous && !analysis.wave5Complete) {
    const wave3Length = wave3.price - wave2.price
    const retracement = wave3Length > 0 ? (wave3.price - wave4.price) / wave3Length : null
    const pullbackValid = retracement != null && retracement >= elliottWaveConfig.confluence.wave4RetraceMinimum
      && retracement <= elliottWaveConfig.confluence.wave4RetraceMaximum && wave4.price > wave1.price
    const wave4High = Math.max(...barsBetween(bars, Date.parse(wave3.at), Date.parse(wave4.at)).map((bar) => bar.h), 0)
    if (pullbackValid && latest.h > wave4High && barVolumeRising) {
      const stop = wave1.price * (1 - elliottWaveConfig.setup.stopBufferFraction)
      const fillPrice = mark.ask * (1 + paperExecutionGuardrails().slippageFraction)
      const shares = calculateShares({ equity: input.equity, price: fillPrice, stop, exposure: input.currentExposure, sizeFraction: elliottWaveConfig.setup.wave4RiskSizeFraction })
      if (shares > 0) drafts.push({
        rule: 'ew_wave4', triggerPrice: wave4High, stop, t1: wave4.price + wave1Length, t2: null, wouldBeShares: shares,
        triggeredAt: mark.at, outcome: null, outcomeAt: null, fillPrice,
        rMultiple: null, metadata: { ...common, setupAt: wave4.at, pullbackFraction: retracement, observedAsk: mark.ask, entryFill: fillPrice, entrySlippage: fillPrice - mark.ask, initialRiskDollars: (fillPrice - stop) * shares, t1Hit: false, partialRealizedPnl: 0, remainingShares: shares, trailingStop: stop, triggerBar: latest.t, phase: 'wave4_reentry' },
      })
    }
  }
  if (analysis.exhaustion || analysis.wouldExitTrendComplete) {
    const action = analysis.wouldExitTrendComplete ? 'would_exit_trend_complete' : 'would_tighten_stop'
    drafts.push({ rule: 'ew_exit_signal', triggerPrice: latest?.c ?? null, stop: analysis.latestSwingLow, t1: null, t2: null, wouldBeShares: 0, triggeredAt: latest ? new Date(Date.parse(latest.t) + MINUTE_MS).toISOString() : null, outcome: null, outcomeAt: null, fillPrice: null, rMultiple: null, metadata: { ...common, action, proposedStop: analysis.latestSwingLow, realExit: null, realExitDid: null, signalAt: now.toISOString() } })
  }
  return drafts
}

export function advanceShadowOutcome(input: {
  signal: ShadowOutcomeSignal
  mark: { price: number; bid: number; ask: number }
  now: Date
  flatten: boolean
  latestSwingLow?: number | null
}) : ShadowOutcomeUpdate {
  const { signal, mark, now, flatten, latestSwingLow } = input
  const metadata = { ...signal.metadata }
  if (!signal.triggered_at) {
    const setupAt = typeof metadata.setupAt === 'string' ? Date.parse(metadata.setupAt) : Number.NaN
    if (Number.isFinite(setupAt) && now.getTime() > setupAt + elliottWaveConfig.setup.wave3TimeoutMinutes * 60_000) {
      return { outcome: 'timeout', outcomeAt: now.toISOString(), fillPrice: null, rMultiple: null, metadata: { ...metadata, reason: 'untriggered_setup_timeout' } }
    }
    if (flatten) return { outcome: 'flatten', outcomeAt: now.toISOString(), fillPrice: null, rMultiple: null, metadata: { ...metadata, reason: 'session_flatten_before_trigger' } }
    return { outcome: null, outcomeAt: null, fillPrice: null, rMultiple: null, metadata }
  }
  const entryPrice = Number(metadata.entryFill)
  const initialRiskDollars = Number(metadata.initialRiskDollars)
  const remainingShares = Math.max(0, Number(metadata.remainingShares ?? signal.would_be_shares))
  if (![entryPrice, initialRiskDollars, remainingShares].every(Number.isFinite) || entryPrice <= 0 || initialRiskDollars <= 0) {
    return { outcome: null, outcomeAt: null, fillPrice: null, rMultiple: null, metadata }
  }
  if (!Number.isFinite(mark.price) || mark.price <= 0 || !Number.isFinite(mark.bid) || mark.bid <= 0) {
    return { outcome: null, outcomeAt: null, fillPrice: null, rMultiple: null, metadata }
  }

  const slippage = paperExecutionGuardrails().slippageFraction
  const t1Hit = metadata.t1Hit === true
  const stopPrice = t1Hit ? Number(metadata.trailingStop ?? entryPrice) : signal.stop
  const activeTarget = t1Hit ? signal.t2 : signal.t1
  const position = { entry_price: entryPrice, stop_price: stopPrice, target_price: activeTarget, metadata: { riskPerShare: Math.max(entryPrice - signal.stop, Number.EPSILON) } }
  const exitReason = flatten ? 'scheduled session flatten' : paperExitReason(position, { price: mark.price, bid: mark.bid }, false)
  const targetHit = !flatten && activeTarget != null && exitReason === 'profit target reached'
  if (targetHit && !t1Hit && signal.t1 != null && metadata.phase !== 'wave4_reentry') {
    const sharesToClose = Math.min(remainingShares, Math.max(1, Math.floor(Number(metadata.t1Shares ?? remainingShares / 2))))
    const requestedPrice = paperExitRequestedPrice(position, { price: mark.price, bid: mark.bid }, 'profit target reached')
    const fillPrice = mark.bid * (1 - slippage)
    const realized = (fillPrice - entryPrice) * sharesToClose
    const nextShares = remainingShares - sharesToClose
    return { outcome: null, outcomeAt: null, fillPrice, rMultiple: null, metadata: {
      ...metadata,
      t1Hit: true,
      t1RequestedPrice: requestedPrice,
      t1FillPrice: fillPrice,
      t1Slippage: requestedPrice - fillPrice,
      partialRealizedPnl: Number(metadata.partialRealizedPnl ?? 0) + realized,
      remainingShares: nextShares,
      trailingStop: Math.max(entryPrice, latestSwingLow ?? entryPrice),
    } }
  }
  if (!exitReason && !flatten) {
    const nextTrailingStop = t1Hit && latestSwingLow != null ? Math.max(Number(metadata.trailingStop ?? entryPrice), latestSwingLow) : Number(metadata.trailingStop ?? signal.stop)
    return { outcome: null, outcomeAt: null, fillPrice: null, rMultiple: null, metadata: { ...metadata, trailingStop: nextTrailingStop } }
  }
  const finalReason = flatten ? 'scheduled session flatten' : exitReason!
  const requestedPrice = paperExitRequestedPrice(position, { price: mark.price, bid: mark.bid }, finalReason)
  const fillPrice = mark.bid * (1 - slippage)
  const finalPnl = (fillPrice - entryPrice) * remainingShares
  const totalPnl = Number(metadata.partialRealizedPnl ?? 0) + finalPnl
  const rMultiple = totalPnl / initialRiskDollars
  const outcome = flatten ? 'flatten' : targetHit ? metadata.phase === 'wave4_reentry' ? 't1' : 't2' : 'stop'
  return { outcome, outcomeAt: now.toISOString(), fillPrice, rMultiple, metadata: {
    ...metadata,
    exitReason: finalReason,
    requestedPrice,
    observedBid: mark.bid,
    observedAsk: mark.ask,
    slippage: requestedPrice - fillPrice,
    gapPastStop: !targetHit && !flatten ? Math.max(0, stopPrice - fillPrice) : 0,
    haltBlocked: false,
    flatten,
    remainingShares: 0,
    partialRealizedPnl: Number(metadata.partialRealizedPnl ?? 0),
    totalRealizedPnl: totalPnl,
    exitFillPrice: fillPrice,
    closedUnderPaperExitRules: true,
  } }
}

export function createWaveState(analysis: ElliottAnalysisResult) {
  return {
    current_wave: analysis.currentWave,
    pivots: analysis.impulsePivots,
    invalidation_level: analysis.invalidationLevel,
    invalidation_reason: analysis.invalidationReason,
    wave_confidence: analysis.waveConfidence,
    updated_at: new Date().toISOString(),
  }
}
