function positiveNumber(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function finiteNumber(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

export const scanConfig = {
  minPrice: positiveNumber('SCAN_MIN_PRICE', 1),
  minVolume: positiveNumber('SCAN_MIN_VOLUME', 100_000),
  minChangePercent: finiteNumber('SCAN_MIN_CHANGE_PERCENT', 0),
  maxSpreadPercent: positiveNumber('SCAN_MAX_SPREAD_PERCENT', 1),
  maxTradeAgeSeconds: positiveNumber('SCAN_MAX_TRADE_AGE_SECONDS', 120),
  maxQuoteAgeSeconds: positiveNumber('SCAN_MAX_QUOTE_AGE_SECONDS', 120),
  relativeVolumeBarMinutes: 15,
  relativeVolumeLookbackSessions: 10,
  minimumRelativeVolumeBaselineVolume: positiveNumber('SCAN_MIN_RVOL_BASELINE_VOLUME', 10_000),
  atrPeriod: 14,
  leaseSeconds: 90,
} as const

export function expectedScanIntervalSeconds(now: Date) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now))
  return hour < 11 ? 15 : 30
}

export function minimumScanLeaseIntervalSeconds(now: Date) {
  return Math.max(1, expectedScanIntervalSeconds(now) - 3)
}
