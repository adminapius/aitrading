// Shared backtest windows (moved out of strategy-ej.ts on Oct 25, 2026 so the parked E-J runner can be archived).
// Used by U1 (u1-delisted.ts), the Ross audit (ross-audit.ts) and the archived R and E-J runners. Values unchanged.
export const EJW = {
  start: '2024-10-14',
  end: '2026-10-16',
  windows: { tuning: ['2024-10-14', '2026-07-31'], holdout: ['2026-08-01', '2026-10-16'] } as Record<string, [string, string]>,
  historyLookbackDays: 57,
  entryEnd: 11 * 60, // trading control: entries 07:00-11:00
  flatE: 15 * 60 + 55, // E-current as live (D1)
  flat1530: 15 * 60 + 30,
  equity: 2000,
} as const

/** Scan times: 7:00, 7:15, 7:30, 7:45, then every 5 minutes from 8:00 (only those before 11:00 can enter). */
export const SCAN_MINUTES = [420, 435, 450, 465, ...Array.from({ length: (EJW.entryEnd - 480) / 5 }, (_, k) => 480 + 5 * k)]
