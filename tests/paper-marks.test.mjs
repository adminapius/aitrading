import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPaperMarketMark, isExecutableQuoteMark } from '../lib/paper-marks'

const now = new Date('2026-10-09T14:30:00.000Z')
const secondsAgo = (s) => new Date(now.getTime() - s * 1_000).toISOString()
const MAX_AGE = 120

test('fresh sane quote marks at the mid with source quote', () => {
  const { mark, diagnosis } = buildPaperMarketMark('TEST', {
    latestQuote: { bp: 5.9, ap: 5.92, t: secondsAgo(3) },
    latestTrade: { p: 5.91, t: secondsAgo(2) },
  }, now, MAX_AGE)
  assert.equal(mark.source, 'quote')
  assert.equal(mark.price, (5.9 + 5.92) / 2)
  assert.equal(mark.bid, 5.9)
  assert.equal(diagnosis.reason, null)
})

test('VEEA case: stale quote + fresh trade still marks the position from the trade', () => {
  const { mark } = buildPaperMarketMark('VEEA', {
    latestQuote: { bp: 5.88, ap: 5.95, t: secondsAgo(300) },
    latestTrade: { p: 5.9, t: secondsAgo(4) },
  }, now, MAX_AGE)
  assert.ok(mark, 'a fresh trade must produce a mark')
  assert.equal(mark.source, 'trade')
  assert.equal(mark.price, 5.9)
  assert.equal(mark.bid, 5.88, 'exit bid uses the sane stale bid when it is not above the trade')
  assert.equal(isExecutableQuoteMark(mark), false, 'trade-derived marks must not be used for entries')
})

test('stale quote above the trade never gives an exit bid better than the trade', () => {
  const { mark } = buildPaperMarketMark('TEST', {
    latestQuote: { bp: 6.2, ap: 6.25, t: secondsAgo(400) },
    latestTrade: { p: 5.9, t: secondsAgo(5) },
  }, now, MAX_AGE)
  assert.equal(mark.bid, 5.9)
  assert.ok(mark.ask >= mark.bid)
})

test('fresh quote + stale trade marks from the quote', () => {
  const { mark } = buildPaperMarketMark('TEST', {
    latestQuote: { bp: 2.0, ap: 2.02, t: secondsAgo(10) },
    latestTrade: { p: 2.01, t: secondsAgo(900) },
  }, now, MAX_AGE)
  assert.equal(mark.source, 'quote')
  assert.equal(isExecutableQuoteMark(mark), true)
})

test('both stale produces no mark and a diagnosis', () => {
  const { mark, diagnosis } = buildPaperMarketMark('TEST', {
    latestQuote: { bp: 2.0, ap: 2.02, t: secondsAgo(500) },
    latestTrade: { p: 2.01, t: secondsAgo(600) },
  }, now, MAX_AGE)
  assert.equal(mark, null)
  assert.equal(diagnosis.reason, 'quote_and_trade_stale')
  assert.equal(diagnosis.quoteAgeSeconds, 500)
  assert.equal(diagnosis.tradeAgeSeconds, 600)
})

test('crossed or one-sided quote falls back to a fresh trade', () => {
  const crossed = buildPaperMarketMark('TEST', {
    latestQuote: { bp: 3.1, ap: 3.0, t: secondsAgo(1) },
    latestTrade: { p: 3.05, t: secondsAgo(1) },
  }, now, MAX_AGE)
  assert.equal(crossed.mark.source, 'trade')
  assert.equal(crossed.mark.bid, 3.05)
  const oneSided = buildPaperMarketMark('TEST', {
    latestQuote: { bp: 0, ap: 3.0, t: secondsAgo(1) },
    latestTrade: { p: 2.98, t: secondsAgo(2) },
  }, now, MAX_AGE)
  assert.equal(oneSided.mark.source, 'trade')
})

test('crossed quote with stale trade reports quote_invalid_and_trade_stale', () => {
  const { mark, diagnosis } = buildPaperMarketMark('TEST', {
    latestQuote: { bp: 3.1, ap: 3.0, t: secondsAgo(1) },
    latestTrade: { p: 3.05, t: secondsAgo(500) },
  }, now, MAX_AGE)
  assert.equal(mark, null)
  assert.equal(diagnosis.reason, 'quote_invalid_and_trade_stale')
})

test('timestamps slightly ahead of the worker clock are accepted (clock skew)', () => {
  const ahead = new Date(now.getTime() + 2_000).toISOString()
  const { mark } = buildPaperMarketMark('TEST', {
    latestQuote: { bp: 1.0, ap: 1.01, t: ahead },
    latestTrade: { p: 1.005, t: ahead },
  }, now, MAX_AGE)
  assert.equal(mark.source, 'quote')
  const farAhead = new Date(now.getTime() + 60_000).toISOString()
  const rejected = buildPaperMarketMark('TEST', {
    latestQuote: { bp: 1.0, ap: 1.01, t: farAhead },
    latestTrade: { p: 1.005, t: farAhead },
  }, now, MAX_AGE)
  assert.equal(rejected.mark, null)
})

test('missing snapshot produces no mark', () => {
  const { mark, diagnosis } = buildPaperMarketMark('TEST', undefined, now, MAX_AGE)
  assert.equal(mark, null)
  assert.equal(diagnosis.reason, 'no_snapshot')
})
