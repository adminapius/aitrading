// Strategy S & SP rulebook backtest: EVERY rule parameter lives here. Change values here, never in the logic.
// Items tagged [adapted] are intraday translations (tunable on the Apr 14 - Jul 31 window only, one at a time).
// Untagged items are course rules and stay fixed.
// Source: "Strategy S & SP - Day Trading Rulebook" (Oct 14, 2026) + Jose's approved decisions of Oct 14, 2026.
// Lesson 3.3 (breakouts) is still pending: Setup 1 (SP) and Setup B (S) may change when it arrives.

export type VariantConfig = {
  rTrailOnFiveMinCloses?: boolean
  timeStopOnlyIfBelowEntry?: boolean
  spStopMinWidthAtr?: number
  widenTightStop?: boolean
  sConfirmBullishAboveEmaAndPriorHigh?: boolean
  breakoutVolumeMult?: number
  stopAfterTuningWindow?: boolean
}

export const RULEBOOK = {
  period: {
    start: '2024-10-14', // 24 months (Jose, Oct 15): 6 months could not produce enough trades
    end: '2026-10-13',
    tuningEnd: '2026-07-31', // tuning window = start..tuningEnd
    holdoutStart: '2026-08-01', // holdout = holdoutStart..end, run once with frozen settings
    rulebookMonthStartDay: 14, // full-period months run 14th-to-13th ("≥4 of 6" scales to ≥16 of 24)
  },

  account: {
    startingEquity: 2_000,
    smallAccountThreshold: 10_000, // below this: small-account mode
    small: { maxOpenPositions: 1, positionValueCapPct: 1.0 }, // [adapted] no leverage: position value ≤ 100% of equity
    normal: { maxOpenPositions: 3, positionValueCapPct: 0.25, maxOpenRiskR: 3, maxPositionsPerSector: 2 },
    minRiskFractionAfterCaps: 0.5, // [adapted] skip if caps leave < 0.5R of risk
    maxShareOfDayVolume: 0.01, // [adapted] shares ≤ 1% of the stock's volume so far that day
    dailyLossStopR: -3, // sum of today's closed-trade R ≤ -3 → no new trades today
    losingStreak: { lossesToHalve: 5, winsToRestore: 2, sizeMultiplier: 0.5 },
    drawdownMultiplier: 2, // 2:1 rule: down X% from peak → size as if down 2X%
    lossThresholdR: 0, // a "loss" is a trade with R below this (after costs)
  },

  costs: {
    commission: 0,
    secFeePerDollar: 20.6 / 1_000_000, // SEC Section 31, effective Apr 4, 2026 (sells only)
    finraTafPerShare: 0.000195, // FINRA TAF on covered equity sales, 2026
    finraTafMaxPerTrade: 9.79,
    rejectFillAboveBarVolumeShare: 0.1, // a fill larger than 10% of that 1-min bar's volume is rejected
  },

  // Fill model (approved Oct 14, 2026):
  //  - entry: trigger = signal level; a later 1-min bar trading through it fills at max(trigger, bar open) + slippage;
  //           if that price is above the limit (trigger + limitOffset) → no fill on that bar. Order valid entryValidMinutes.
  //  - stop: 1-min low touches the stop → fill at stop - slippage; bar OPENS beyond the stop → fill at open - slippage.
  //  - targets: resting limits fill at the target (or the open if it gapped above) when the bar trades through by 1 tick.
  //  - close-based exits (time stop, MA/VWAP closes, exhaustion, failed breakout): next 1-min bar open - slippage.
  fills: {
    entryValidMinutes: 5,
    targetThroughTicks: 0.01,
    // On the bar an entry fills, the order of high/low is unknown: the stop counts as hit only if that bar CLOSES
    // at or below it; targets are not checked on the entry bar.
    entryBarStopUsesClose: true,
  },

  management: {
    rTrailStepR: 1, // each +1R of open profit raises the stop 1R (at +1R → breakeven)
    flattenMinute: 15 * 60 + 30,
  },

  S: {
    enabled: true,
    longOnly: true, // approved: S shorts OFF for this backtest
    riskPerTrade: 0.01,
    entryStartMinute: 9 * 60 + 45,
    entryEndMinute: 14 * 60 + 30,
    sessionStartMinute: 9 * 60 + 30, // S indicators use regular-hours bars; VWAP anchored 9:30
    warmupSessions: 3, // prior sessions loaded so 15m/5m EMA/SMA/MACD carry over
    slippage: 0.0005,
    entryLimitOffset: 0.002, // [adapted] marketable limit = trigger + 0.2%
    timeStopMinutes: 30, // [adapted]
    maxEntriesPerTickerPerDay: null as number | null, // rulebook sets none for S
    universe: {
      exchanges: ['NYSE', 'NASDAQ'],
      minPrice: 10,
      avgVolumeDays: 20,
      minAvgVolume: 1_000_000,
      atrDays: 14,
      minAtrPct: 0.02,
      dailyFast: 20, // 20 EMA (course: EMA for short MAs)
      dailyMid: 50, // 50 SMA
      dailySlow: 200, // 200 SMA
      inPlayMinGap: 0.02, // [adapted]
      inPlayMinPremarketRvol: 2, // [adapted]
      premarketEndMinute: 9 * 60, // list built at 9:00 ET
      rvolSessions: 20,
      rankLookbackDays: 252, // 52-week high
      keepTop: 10,
      newsScanTop: 40, // candidates checked for news per day (in rank order)
    },
    gate15m: { emaFast: 20, smaSlow: 50, macd: [12, 26, 9] as const, rsiPeriod: 14, rsiMin: 45 },
    setupA: {
      emaFast: 20,
      smaSlow: 50,
      priorBouncesRequired: 2,
      minRoomR: 2, // pullback
    },
    setupB: {
      orEndMinute: 9 * 60 + 45, // opening range 9:30-9:45
      consolidationMinBars: 3,
      consolidationAtr: 1, // within 1 ATR(5m) below the level
      breakoutVolumeMult: 2,
      volumeAvgBars: 20,
      retestMaxBars: 6, // [adapted] retest must come within 6 five-minute bars of the breakout
      minRoomR: 3, // breakout (also used for the retest entry)
      failedBreakoutBars: 2,
    },
    stop: { bufferAtr: 0.25, minAtr: 1, maxAtr: 3 },
    exits: { scale1R: 3, scale1Fraction: 0.5, runnerSmaPeriod: 50, runnerClosesBelow: 2, hodToleranceAtr: 0.1 },
    atrPeriod: 14,
    rsiPeriod: 14,
  },

  SP: {
    enabled: true,
    riskPerTrade: 0.005,
    entryStartMinute: 7 * 60,
    entryEndMinute: 15 * 60,
    sessionAnchorMinute: 4 * 60, // VWAP anchored 4:00 AM
    regularOpenMinute: 9 * 60 + 30,
    slippage: 0.005,
    slippagePremarket: 0.01, // before 9:30
    entryLimitOffset: 0.005, // [adapted] trigger + 0.5%
    timeStopMinutes: 15, // [adapted]
    scanner: {
      minPrice: 1,
      maxPrice: 10,
      maxFloat: 10_000_000,
      minGap: 0.2,
      standardGapMax: 0.3,
      maxGap: 0.5, // > 50% → no new entries
      clearSetupMinRoomR: 3, // 30-50% gap needs ≥ 3R room
      minVolumeEarly: 300_000, // entries before 9:45
      minVolumeLate: 1_000_000, // entries from 9:45
      lateVolumeMinute: 9 * 60 + 45,
      minRvol: 5,
      rvolSessions: 20,
      topN: 3,
      haltHoleMinutes: 5, // [adapted] RTH: a 5+ minute hole in bars = halt
      haltLookbackMinutes: 5,
    },
    gate5m: { smas: [5, 8, 13] as const, macd: [12, 26, 9] as const, rsiPeriod: 14, rsiMin: 50, rsiMax: 90 },
    setup1: { volumeMult: 2, volumeAvgBars: 10, maxChaseAtr: 0.5, minRoomR: 3 },
    setup2: {
      impulseMinAtr: 1.5, // [adapted] impulse leg ≥ 1.5 × ATR(5m) to a new high
      pullbackMinBars: 2,
      pullbackMaxRangeRatio: 0.6, // [adapted] pullback candles ≤ 60% of impulse candle range
      supportToleranceAtr: 0.25, // [adapted]
      ema1mPeriod: 9, // [adapted]
      minRoomR: 2,
    },
    retrade: { maxEntriesPerTicker: 3, maxLossesPerTicker: 2 },
    pyramid: { maxUnits: 3, minOpenProfitR: 1 },
    stop: { bufferAtr: 0.25, maxAtrFromEntry: 2, minWidthAtr: 0.5, maxWidthAtr: 2, maxWidthPct: 0.1 },
    exits: {
      scale1R: 3,
      scale2R: 5,
      scaleFraction: 1 / 3,
      runnerSmaPeriod: 8,
      runnerClosesBelow: 2,
      keltner: { emaPeriod: 20, atrPeriod: 20, mult: 2, outsideBars: 3, outOf: 5 },
      hodToleranceAtr: 0.1,
    },
    atrPeriod: 14,
    rsiPeriod: 14,
  },

  resistance: { dailyPivotLookbackDays: 60 }, // PDH, PMH, HOD, 5m pivots (today+yesterday), daily pivots; round numbers excluded

  candles: {
    hammerLowerToBody: 2,
    hammerUpperToBody: 0.3,
    starUpperToBody: 2,
    starLowerToBody: 0.3,
    minBodyFractionOfRange: 0.05, // a doji's body is floored at 5% of its range so ratios stay meaningful
    morningStarLongBodyFraction: 0.6, // bars 1 and 3: body ≥ 60% of range
    morningStarSmallBodyRatio: 0.3, // bar 2 body ≤ 30% of bar 1 body
  },

  passCriteria: {
    minTrades: 100, // full period; each window needs the same rate, prorated by its share of trading days
    minExpectancyR: 0.2,
    minProfitFactor: 1.5,
    maxDrawdownR: 15,
    maxSingleLossR: 3,
    profitableMonthsFraction: 4 / 6, // "≥4 of 6 months": full period uses 14th-13th months, windows use calendar months
  },

  // Variant runs: [adapted] changes only, each tested against the frozen rules (Jose, Oct 15, 2026).
  variants: {
    // Run F = run C plus two [adapted] changes (Jose, Oct 15): judged on the tuning window only; it does not
    // simulate the holdout at all, so the holdout stays untouched.
    F: {
      sConfirmBullishAboveEmaAndPriorHigh: true, // S Setup A: also accept any bullish bar closing above the 20 EMA and the prior bar's high
      breakoutVolumeMult: 1.5, // S Setup B and SP Setup 1 breakout volume ≥ 1.5× average (base: 2×)
      stopAfterTuningWindow: true,
    },
    E: {
      rTrailOnFiveMinCloses: true, // R-trail / breakeven moves only on 5-min closes, not 1-min intrabar highs
      timeStopOnlyIfBelowEntry: true, // at 15 min, exit only if the last close is below entry
      spStopMinWidthAtr: 1.0, // smart stop at least 1.0 × ATR(5m) from entry (base: 0.5)
      widenTightStop: true, // a tighter stop is widened to the minimum (sized off the wider stop), not skipped
    },
  } as Record<'E' | 'F', VariantConfig>,
}

export type RulebookConfig = typeof RULEBOOK
