import type { StrategyRegimeName } from './strategy.ts'

export const elliottWaveConfig = {
  enabled: true,
  uses: {
    exhaustionFilter: true,
    wave3Entry: true,
    wave4Reentry: true,
  },
  pivot: {
    atrMultiplier: 0.5,
    minimumPriceFraction: 0.015,
    premarketStartMinute: 4 * 60,
    premarketEndMinute: 9 * 60 + 30,
    premarketMinimumBarVolume: 100,
    fiveMinuteAtrPeriod: 14,
    rsiPeriod: 14,
  },
  confluence: {
    wave2RetraceMinimum: 0.382,
    wave2RetraceMaximum: 0.618,
    wave4RetraceMinimum: 0.236,
    wave4RetraceMaximum: 0.382,
    confidencePoints: 20,
  },
  setup: {
    wave3TimeoutMinutes: 20,
    wave5FlagMinutes: 30,
    stopBufferFraction: 0.001,
    wave3TargetOneMultiple: 1,
    wave3TargetTwoMultiple: 1.618,
    wave4RiskSizeFraction: 0.5,
    wave3FirstTargetFraction: 0.5,
  },
  promotion: {
    exhaustionFlaggedTrades: 30,
    minimumShadowTrades: 50,
    minimumExpectancyR: 0.3,
  },
  minimumConfidence: {
    'opening-momentum': 0,
    'premarket-continuation': 70,
    'news-reaction': 70,
    'midday-selective': 80,
    'late-continuation': 80,
    'exits-only': 101,
  } satisfies Record<StrategyRegimeName, number>,
  regimes: {
    'opening-momentum': { exhaustionFilter: true, wave3Entry: true, wave4Reentry: true },
    'premarket-continuation': { exhaustionFilter: true, wave3Entry: true, wave4Reentry: false },
    'news-reaction': { exhaustionFilter: true, wave3Entry: true, wave4Reentry: false },
    'midday-selective': { exhaustionFilter: true, wave3Entry: true, wave4Reentry: false },
    'late-continuation': { exhaustionFilter: true, wave3Entry: true, wave4Reentry: false },
    'exits-only': { exhaustionFilter: false, wave3Entry: false, wave4Reentry: false },
  } satisfies Record<StrategyRegimeName, { exhaustionFilter: boolean; wave3Entry: boolean; wave4Reentry: boolean }>,
} as const

export type ElliottWaveUse = keyof typeof elliottWaveConfig.uses
