import assert from 'node:assert/strict'
import test from 'node:test'
import { riskPlan } from '../lib/assistant/risk'
import { dailyLimits, edgeReadout, groupStats, journalTrades, matchPlan, priceBand, rOf, roundTrips, sellFees, stats, timeBucket } from '../lib/assistant/journal'
import { alertText, DEFAULT_FILTERS, failedFilters, haltStatus, inferHalt, shouldAlert } from '../lib/assistant/scanner'
import { dilutionFilings, filerType, parseSubmissions, pointBefore, sharePoints, splitFactor } from '../lib/assistant/edgar'
import { signSession, verifySession } from '../lib/assistant/store'

const close = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`)

test('riskPlan: shares for 1% risk, dollar risk, 1R/2R, caps and warnings', () => {
  const p = riskPlan({ entry: 5, stop: 4.8, equity: 2000 })
  assert.equal(p.shares, 100) // 20 / 0.20
  close(p.dollarRisk, 20); close(p.target1R, 5.2); close(p.target2R, 5.4)
  assert.deepEqual(p.warnings, [])
  assert.equal(riskPlan({ entry: 5, stop: 4.8, equity: 2000, buyingPower: 300 }).shares, 60)
  assert.equal(riskPlan({ entry: 5, stop: 4.8, equity: 2000, buyingPower: 300 }).capped, 'buying power')
  assert.equal(riskPlan({ entry: 5, stop: 5, equity: 2000 }).ok, false)
  assert.match(riskPlan({ entry: 5, stop: 4.99, equity: 2000 }).warnings.join(), /under \$0.02/)
  assert.match(riskPlan({ entry: 5, stop: 4, equity: 2000 }).warnings.join(), /more than 10%/)
  assert.match(riskPlan({ entry: 5, stop: 4.8, equity: 2000, limitHit: true, dilution: true, halted: true }).warnings.join(), /limit.*|dilution/i)
})

const f = (id, side, qty, price, at, symbol = 'ABC', mode = 'paper') => ({ id, symbol, side, qty, price, at, mode })
test('roundTrips: open at 0, adds and scale-outs belong to the trade, P&L from cash flows, fees on sells', () => {
  const t = roundTrips([f('1', 'buy', 100, 5, '2026-11-02T13:00:00Z'), f('2', 'buy', 100, 5.2, '2026-11-02T13:01:00Z'), f('3', 'sell', 150, 5.5, '2026-11-02T13:10:00Z'), f('4', 'sell', 50, 5.0, '2026-11-02T13:20:00Z')])
  assert.equal(t.length, 1)
  const x = t[0]
  assert.equal(x.open, false); assert.equal(x.shares, 200); close(x.avgEntry, 5.1); close(x.avgExit, 5.375)
  close(x.gross, 150 * 5.5 + 50 * 5 - 100 * 5 - 100 * 5.2)
  close(x.fees, sellFees(150, 5.5) + sellFees(50, 5))
  assert.equal(x.exitAt, '2026-11-02T13:20:00Z')
  assert.equal(x.day, '2026-11-02')
})

test('roundTrips: a fill crossing zero closes and opens; shorts; open trades stay open; modes kept apart', () => {
  const t = roundTrips([f('1', 'buy', 100, 5, '2026-11-02T13:00:00Z'), f('2', 'sell', 150, 6, '2026-11-02T13:05:00Z'), f('3', 'buy', 50, 5.5, '2026-11-02T13:30:00Z'), f('4', 'buy', 10, 3, '2026-11-02T14:00:00Z', 'XYZ', 'live')])
  assert.equal(t.length, 3)
  assert.equal(t[0].side, 'long'); close(t[0].gross, 100); assert.equal(t[0].open, false)
  assert.equal(t[1].side, 'short'); close(t[1].gross, 50 * 6 - 50 * 5.5); assert.equal(t[1].open, false)
  assert.equal(t[2].mode, 'live'); assert.equal(t[2].open, true)
})

test('plans, R and the journal join', () => {
  const [trip] = roundTrips([f('1', 'buy', 100, 5, '2026-11-02T13:00:00Z'), f('2', 'sell', 100, 5.4, '2026-11-02T13:10:00Z')])
  const plans = [{ id: 'p1', symbol: 'ABC', entry: 5, stop: 4.8, setup: 'first pullback', createdAt: '2026-11-02T12:55:00Z' }, { id: 'p0', symbol: 'ABC', entry: 5, stop: 4.5, createdAt: '2026-11-02T12:40:00Z' }]
  assert.equal(matchPlan(trip, plans).id, 'p1')
  assert.equal(matchPlan(trip, plans.slice(1)), null, 'older than 10 minutes')
  close(rOf(trip, 4.8), trip.net / 20)
  assert.equal(rOf({ ...trip, open: true }, 4.8), null)
  const [j] = journalTrades([trip], plans, new Map())
  assert.equal(j.stopFrom, 'plan'); assert.equal(j.setup, 'first pullback'); close(j.r, trip.net / 20)
  const [m] = journalTrades([trip], plans, new Map([[trip.key, { stop: 4.9, setup: 'other', notes: 'x' }]]))
  assert.equal(m.stopFrom, 'manual'); assert.equal(m.setup, 'other'); close(m.r, trip.net / 10)
})

test('buckets, stats, groups and the paper-only yardstick', () => {
  assert.equal(timeBucket('2026-11-02T14:44:00Z'), 'before 09:45') // 09:44 EST
  assert.equal(timeBucket('2026-11-02T14:45:00Z'), '09:45-11:00')
  assert.equal(timeBucket('2026-11-02T16:00:00Z'), 'after 11:00')
  assert.equal(priceBand(1.5), 'under $2'); assert.equal(priceBand(4.99), '$2-5'); assert.equal(priceBand(20), 'over $20')
  const mk = (r, mode = 'paper') => ({ key: String(Math.random()), mode, open: false, r, net: r * 10, setup: 's', entryAt: '2026-11-02T15:00:00Z', avgEntry: 5 })
  const paper = [...Array(20).fill(0).map(() => mk(1)), ...Array(10).fill(0).map(() => mk(-1))]
  const s = stats(paper)
  assert.equal(s.withR, 30); close(s.expectancyR, 1 / 3); close(s.pf, 2)
  assert.equal(edgeReadout(paper).status, 'meets')
  assert.equal(edgeReadout([...paper.slice(0, 29), ...Array(40).fill(0).map(() => mk(2, 'live'))]).status, 'collecting', 'live trades never count toward the 30')
  assert.equal(edgeReadout([...Array(15).fill(0).map(() => mk(1)), ...Array(15).fill(0).map(() => mk(-1))]).status, 'does-not-meet')
  assert.equal(stats([{ ...mk(1), r: null }]).noStop, 1)
  const g = groupStats(paper, (t) => t.setup)
  assert.equal(g[0].key, 's'); assert.equal(g[0].enough, true)
})

test('daily limits: -3% of the starting equity and 4 trades; trades after a limit are marked', () => {
  const day = '2026-11-02'
  const trades = []
  for (let i = 0; i < 5; i += 1) trades.push(f(`b${i}`, 'buy', 100, 5, `2026-11-02T15:0${i}:00Z`, `S${i}`), f(`s${i}`, 'sell', 100, 4.8, `2026-11-02T15:0${i}:30Z`, `S${i}`))
  const { limits, afterLimit } = dailyLimits(roundTrips(trades), day, 2000)
  assert.equal(limits.tradesOpened, 5); assert.equal(limits.tradesHit, true)
  close(limits.maxLoss, 60)
  assert.equal(limits.lossHit, true) // 3 x about -20.0 = about -60.1 after fees
  assert.ok(afterLimit.size >= 1)
  assert.equal(dailyLimits(roundTrips(trades.slice(0, 2)), day, 2000).limits.lossHit, false)
})

const row = (x = {}) => ({ symbol: 'ABC', name: null, price: 5, gainPct: 40, volume: 1e6, relativeVolume: 5, relativeVolumeReliable: true, spreadPct: 0.4, float: 3e6, floatSource: 'edgar', floatMiss: null, floatAsOf: null, fmpFloat: null, filer: 'domestic', headline: 'News', headlineAt: null, headlineAgeMin: 30, halt: { status: 'none', at: null, reason: null }, dilution: { flagged: false, forms: [], links: [] }, lastTradeAt: null, ...x })
test('filters, halts and alerts', () => {
  assert.deepEqual(failedFilters(row(), DEFAULT_FILTERS, 8 * 60), [])
  assert.deepEqual(failedFilters(row(), DEFAULT_FILTERS, 12 * 60), ['outside the time window'])
  assert.ok(failedFilters(row({ float: null }), DEFAULT_FILTERS, 480).includes('no EDGAR float'))
  assert.ok(failedFilters(row({ headlineAgeMin: 200 }), DEFAULT_FILTERS, 480).includes('no news in the window'))
  assert.ok(failedFilters(row({ halt: { status: 'halted', at: 'x', reason: null } }), DEFAULT_FILTERS, 600).includes('halted'))
  const now = new Date('2026-11-02T15:00:00Z')
  assert.equal(inferHalt('2026-11-02T14:54:00Z', now, 600).status, 'inferred')
  assert.equal(inferHalt('2026-11-02T14:58:00Z', now, 600).status, 'none')
  assert.equal(inferHalt('2026-11-02T12:00:00Z', now, 8 * 60).status, 'none', 'not in pre-market')
  assert.equal(haltStatus({ status: 'halted', at: 'x', reason: 'LUDP' }, { status: 'none', at: null, reason: null }).status, 'halted')
  assert.equal(shouldAlert(null, row(), DEFAULT_FILTERS), true)
  assert.equal(shouldAlert({ price: 4 }, row(), DEFAULT_FILTERS), false)
  assert.equal(shouldAlert({ price: 4 }, row(), { ...DEFAULT_FILTERS, reAlertNewHigh: true }), true)
  assert.match(alertText(row()).body, /no order was sent/)
})

test('EDGAR: counts filed before the day, dilution forms, filer type, split factor', () => {
  const pts = sharePoints([{ end: '2026-06-30', val: 2e6, accn: 'a', form: '10-Q', filed: '2026-08-10' }, { end: '2026-09-30', val: 3e6, accn: 'b', form: '10-Q', filed: '2026-11-05' }])
  assert.equal(pointBefore(pts, '2026-11-05').shares, 2e6, 'filed that day is not used')
  assert.equal(pointBefore(pts, '2026-11-06').shares, 3e6)
  const filings = parseSubmissions({ filings: { recent: { form: ['424B5', '10-Q', 'S-3', '20-F', '8-K'], filingDate: ['2026-10-20', '2026-08-10', '2026-03-01', '2026-04-01', '2026-10-01'], accessionNumber: ['0001-26-1', '0001-26-2', '0001-26-3', '0001-26-4', '0001-26-5'], primaryDocument: ['a.htm', 'b.htm', 'c.htm', 'd.htm', 'e.htm'] } } }, '0000123456')
  assert.match(filings[0].url, /data\/123456\/000126/)
  assert.deepEqual(dilutionFilings(filings, '2026-11-02').map((x) => x.form), ['424B5'])
  assert.equal(filerType(filings, '2026-11-02'), 'foreign')
  close(splitFactor(1, 10), 0.1) // a 1-for-10 reverse split after the count
  assert.equal(splitFactor(null, 2), 1)
})

test('session tokens: signed, expiring, tamper-proof', () => {
  const secret = 'x'.repeat(40)
  const t = signSession(Date.now() + 60_000, secret)
  assert.equal(verifySession(t, secret), true)
  assert.equal(verifySession(t, 'y'.repeat(40)), false)
  assert.equal(verifySession(t.replace(/\.(.)/, '.Z'), secret), false)
  assert.equal(verifySession(signSession(Date.now() - 1, secret), secret), false)
  assert.equal(verifySession(undefined, secret), false)
})
