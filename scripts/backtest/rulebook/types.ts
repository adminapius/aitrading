import type { Bar } from './indicators'

export type Version = 'S' | 'SP'
export type SetupName = 'A' | 'B' | 'B-retest' | '1' | '2'

// A setup detected at the close of a bar. `time` is when it becomes known (bar end); the entry order is
// active on 1-min bars starting at `time` for RULEBOOK.fills.entryValidMinutes.
export type Signal = {
  version: Version
  symbol: string
  setup: SetupName
  time: number
  trigger: number
  limit: number
  stop: number
  atr5: number
  basisLow: number // swing / pullback low behind the stop (higher-low checks)
  level: number | null // S Setup B: the broken level (failed-breakout exit)
  levelKey: string | null // S Setup B: one entry per level per day
  roomR: number // room to next resistance in R (Infinity when nothing above)
  minRoomR: number
  entryEligible: boolean // passes every new-entry rule that depends only on market data
  addEligible: boolean // SP: may be used as a pyramid add (Setup 1 breakout with the trend gate)
  gapPct: number | null
  rvol: number | null
  note: string
  blockers?: string[] // why entryEligible is false (diagnostics)
}

// Facts known at the close of a 5-minute bar, used by exits.
export type FiveEvent = {
  end: number
  close: number
  runnerBelow: boolean // S: close < 50 SMA; SP: close < 8 SMA
  belowVwap: boolean // SP structure exit
  exhaustion: boolean // S: engulfing/shooting star at HOD + RSI divergence; SP: Keltner parabolic then red bar < prior low
  structureBreakAt: number | null // S: lower high + lower low; time the latest pivot was confirmed
  tightenTo: number | null // SP: divergence + bearish candle at HOD → stop to last 1-min swing low
}

export type SymbolDay = {
  version: Version
  symbol: string
  day: string
  midnight: number
  bars: Bar[] // today 4:00-16:00 ET, 1-minute, raw SIP
  byMinute: Array<Bar | undefined> // minute of day → bar
  cumVolume: number[] // minute of day → volume from 4:00 through that minute (inclusive)
  signals: Signal[]
  events: FiveEvent[]
  pdh: number | null
  prevClose: number
  float: number | null
}
