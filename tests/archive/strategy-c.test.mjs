import assert from 'node:assert/strict'
import test from 'node:test'
import { C, closerTo, closingPrint, dividendFactor, isHalfDay } from '../../scripts/backtest/archive/strategy-c'

test('closingPrint: primary-exchange official close (M) first, else the largest closing print (6); other exchanges ignored', () => {
  const trades = [
    { t: '1', x: 'D', p: 450.1, s: 5000, c: ['6'] }, // off-exchange: ignored
    { t: '2', x: 'P', p: 450.02, s: 300, c: ['6'] },
    { t: '3', x: 'P', p: 450.0, s: 900_000, c: ['6'] },
    { t: '4', x: 'P', p: 450.0, s: 0, c: ['M'] },
  ]
  assert.deepEqual(closingPrint(trades, 'P'), { price: 450.0, kind: 'M' })
  assert.deepEqual(closingPrint(trades.filter((t) => !t.c.includes('M')), 'P'), { price: 450.0, kind: '6' })
  assert.equal(closingPrint(trades, 'Q'), null)
  assert.equal(closingPrint([], 'P'), null)
})

test('dividendFactor: 1 - dividend / prior close on an ex-dividend day, 1 otherwise', () => {
  // prior close 400, dividend 1.60 -> Alpaca dividend-adjusted prior close 398.40; on the ex-date adj = raw
  const f = dividendFactor(400, 398.4, 401, 401)
  assert.ok(Math.abs(f - (1 - 1.6 / 400)) < 1e-12)
  assert.ok(Math.abs(400 * f - 398.4) < 1e-9) // adjusted prior close = prior close - dividend
  // an ordinary day years before a later dividend: both days carry the same later factor -> 1
  assert.equal(dividendFactor(300, 297, 303, 299.97), 1)
  assert.equal(dividendFactor(NaN, 1, 1, 1), 1) // missing data -> no adjustment
})

test('isHalfDay and the locked windows', () => {
  assert.equal(isHalfDay({ close: '16:00' }), false)
  assert.equal(isHalfDay({ close: '13:00' }), true)
  assert.deepEqual(C.passFail, ['2020-06-01', '2026-10-16'])
  assert.deepEqual(C.consistency, ['2016-01-04', '2020-05-29'])
  assert.equal(C.signalMinute, 929)
  assert.equal(C.entryMinute, 930)
  assert.deepEqual(C.primary, { SPY: 'P', QQQ: 'Q', IWM: 'P', DIA: 'P' })
})

test('closerTo: the price nearer the 15:59 reference wins; equal distance is a tie', () => {
  assert.equal(closerTo(450, 450.02, 452), 'print')
  assert.equal(closerTo(450, 457.13, 450.01), 'daily')
  assert.equal(closerTo(450, 450.05, 449.95), 'tie')
})

test('dividendFactor: rounding noise in the adjusted closes is not a dividend', () => {
  assert.equal(dividendFactor(450, 449.9991, 451, 451), 1, 'implied 0.09 cents: rounding')
  assert.ok(dividendFactor(450, 448.2, 451, 451) < 1, 'implied $1.80: dividend')
})

// ---------------- run: pure simulation ----------------
import { BASE, FEES, holdLine, lineStats, maxDrawdown, passRule, runLine, sellFees, sharpe, tenMonthFilter, tStat } from '../../scripts/backtest/archive/strategy-c'

const day = (date, x = {}) => ({ date, half: false, c1529: 101, o1530: 101.05, o1531: 101.1, prevClose: 100, close: 102, closeSrc: 'print', prevSrc: 'print', divFactor: 1, ...x })

test('runLine: long when r > 0, whole shares at the 15:30 open + $0.01, sold at the official close - $0.01, fees on the sell', () => {
  const res = runLine([day('2021-01-04')], BASE, 2000)
  const t = res.trades[0]
  assert.equal(t.shares, Math.floor(2000 / 101.06))
  assert.ok(Math.abs(t.entry - 101.06) < 1e-9 && Math.abs(t.exit - 101.99) < 1e-9)
  assert.ok(Math.abs(t.pnl - (19 * (101.99 - 101.06) - sellFees(19, 101.99))) < 1e-9)
  assert.ok(Math.abs(t.idleCash - (2000 - 19 * 101.06) / 2000) < 1e-12)
  assert.ok(Math.abs(res.daily[0].equity - (2000 + t.pnl)) < 1e-9)
})

test('runLine: r <= 0 is flat; long/short shorts it at the 15:30 open - $0.01 and covers at the close + $0.01', () => {
  const down = day('2021-01-05', { c1529: 99.5, close: 99 })
  assert.equal(runLine([down], BASE).trades.length, 0)
  assert.equal(runLine([down], BASE).flatDays, 1)
  const t = runLine([down], { ...BASE, longShort: true }).trades[0]
  assert.equal(t.side, 'short')
  assert.ok(Math.abs(t.pnl - (t.shares * ((101.05 - 0.01) - 99.01) - sellFees(t.shares, 101.04))) < 1e-9)
})

test('runLine: D1 dividend factor turns an ex-dividend "down" day into an up day; the raw line stays flat', () => {
  // prior close 100, dividend 1.20 -> factor 0.988; 15:29 at 99.5 is +0.7% against 98.80
  const d = day('2021-03-19', { c1529: 99.5, divFactor: 0.988 })
  assert.equal(runLine([d], BASE).trades.length, 1)
  assert.equal(runLine([d], { ...BASE, adjustDividend: false }).trades.length, 0)
})

test('runLine: skips half days and missing data by reason (D7), with 0 return; 15:31 line uses the 15:31 open', () => {
  const res = runLine([day('a', { half: true }), day('b', { c1529: undefined }), day('c', { o1530: undefined }), day('d', { prevClose: undefined }), day('e', { close: undefined })], BASE)
  assert.deepEqual(res.skips, { 'half day': 1, 'no 15:29 bar': 1, 'no 15:30 bar': 1, 'no prior close': 1, 'no closing price': 1 })
  assert.equal(res.daily.length, 5)
  assert.ok(res.daily.every((p) => p.ret === 0))
  assert.ok(Math.abs(runLine([day('f')], { ...BASE, late: true }).trades[0].entry - 101.11) < 1e-9)
  assert.equal(runLine([day('g', { o1530: undefined })], { ...BASE, late: true }).trades.length, 1)
})

test('runLine: fractional line invests all equity; stress line pays $0.03 each way', () => {
  const f = runLine([day('h')], { ...BASE, fractional: true }).trades[0]
  assert.ok(Math.abs(f.shares * f.entry - 2000) < 1e-9 && Math.abs(f.idleCash) < 1e-12)
  const s = runLine([day('i')], { ...BASE, slip: 0.03 }).trades[0]
  assert.ok(Math.abs(s.entry - 101.08) < 1e-9 && Math.abs(s.exit - 101.97) < 1e-9)
})

test('fees: SEC per dollar sold, TAF per share capped at $9.79', () => {
  assert.ok(Math.abs(sellFees(10, 500) - (5000 * 20.6e-6 + 10 * 0.000195)) < 1e-12)
  assert.ok(Math.abs(sellFees(1e6, 1) - (1e6 * FEES.secPerDollar + 9.79)) < 1e-9)
})

test('sharpe, tStat, maxDrawdown', () => {
  assert.equal(sharpe([0, 0, 0]), 0)
  const r = [0.01, -0.005, 0.002, 0]
  const m = r.reduce((a, b) => a + b) / 4, s = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / 3)
  assert.ok(Math.abs(sharpe(r) - (m / s) * Math.sqrt(252)) < 1e-12)
  assert.ok(Math.abs(tStat(r) - m / (s / 2)) < 1e-12)
  assert.ok(Math.abs(maxDrawdown([100, 120, 90, 130, 117]) - 0.25) < 1e-12)
})

test('holdLine: invested at the first close (0 that day), then close-to-close; held() can switch it off', () => {
  const close = new Map([['d1', 100], ['d2', 110], ['d3', 99]])
  const h = holdLine(['d1', 'd2', 'd3'], close)
  assert.deepEqual(h.daily.map((p) => Number(p.ret.toFixed(6))), [0, 0.1, -0.1])
  assert.ok(Math.abs(h.daily[2].equity - 2000 * 1.1 * 0.9) < 1e-9)
  const off = holdLine(['d1', 'd2', 'd3'], close, 2000, (d) => d !== 'd3')
  assert.equal(off.daily[2].ret, 0)
})

test('tenMonthFilter: holds month m+1 only when month m closes above its 10-month average', () => {
  const m = new Map()
  for (let i = 1; i <= 12; i += 1) m.set(`2015-${String(i).padStart(2, '0')}`, i === 11 ? 1 : 100 + i)
  const f = tenMonthFilter(m)
  assert.equal(f.firstSignalMonth, '2015-10')
  assert.equal(f.held('2015-11-03'), true) // Oct 110 > avg
  assert.equal(f.held('2015-12-01'), false) // Nov 1 < avg
  assert.equal(f.held('2016-01-04'), true) // Dec 112 > avg
  assert.equal(f.held('2015-10-01'), false) // no signal before 10 month-ends
})

test('lineStats + passRule: years, PF, streak, and every rule must hold', () => {
  const days = []
  for (const y of ['2021', '2022', '2023', '2024', '2025', '2026']) for (let k = 0; k < 10; k += 1) days.push(day(`${y}-02-${String(k + 1).padStart(2, '0')}`, { close: k === 9 ? 100.5 : 102.5 }))
  const s = lineStats(runLine(days, BASE))
  assert.equal(s.trades, 60)
  assert.equal(s.longestLosingStreak, 1)
  assert.ok(s.pf > 1 && s.totalNet > 0 && s.tStat > 2)
  assert.equal(Object.keys(s.byYear).length, 6)
  const loss = { ...s, totalNet: -0.01 }
  const ok = passRule({ spy: s, buyHold: { ...s, sharpe: s.sharpe - 1 }, spyStress: s, robustness: { QQQ: s, IWM: s, DIA: loss }, spyConsistency: s })
  assert.equal(ok.pass, true)
  const bad = passRule({ spy: s, buyHold: { ...s, sharpe: s.sharpe + 1 }, spyStress: s, robustness: { QQQ: s, IWM: loss, DIA: loss }, spyConsistency: loss })
  assert.deepEqual(bad.rules.filter((r) => !r.pass).map((r) => r.rule), [1, 5])
})
