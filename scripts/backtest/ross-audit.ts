// Ross audit ("Strategy R" research) - READ ONLY. No strategy changes, no locked runs, no live code.
//
//   npx tsx scripts/backtest/ross-audit.ts --csv=backtests/ross-audit/trades.csv --ej=backtests/strategy-ej --out=backtests/ross-audit
//   U1 rerun of Q1/Q2 only (delisted + renamed tickers added): first --prefetch (downloads, writes nothing else), then
//   the same command without it (cache only):
//   npx tsx scripts/backtest/ross-audit.ts --u1 --only=q1q2 --prefetch --out=backtests/ross-audit/u1
//   npx tsx scripts/backtest/ross-audit.ts --u1 --only=q1q2 --out=backtests/ross-audit/u1
//
// Reads (cache only by default; --fetch allows read-only Alpaca GETs for missing quotes/bars, outside 06:45-16:05 ET):
//   - Ross Cameron's own stated trades (backtests/ross-audit/trades.csv, collected from his YouTube recaps)
//   - the E replay's universe, minute bars, 15-min RVOL baselines, news and quotes in .cache/backtest
//   - E-current trades from the locked E-J runs (backtests/strategy-ej/{tuning,holdout}/trades.csv, run = E-current)
// Writes only <out>/q1q2.csv, q3.csv, q4.csv, q5-daily.csv and report.txt. Never runs a strategy window, never
// writes a lock file, never touches Supabase, the worker or any live setting.
//
// Q1 was the ticker in E's scanner at Ross's entry time (and if not, why not)
// Q2 E's filter decision at that scan and the first blocking reason
// Q3 what E traded on Ross's days that Ross did not
// Q4 medians for Ross's trades vs E's trades on the same days (float, % gain at entry, RVOL, price, time,
//    news age, halt-like gaps, first-5-minute volume, premarket-high break)
// Q5 daily count of stocks up >= 50% on >= 10M shares by 10:00 ET, against Ross's hot/cold words and P&L, and E's P&L
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scanConfig } from '../../lib/scan-config'
import { normalizeFloatShares, scoreCandidate, strategyRegime, type ScanCandidate } from '../../lib/strategy'
import { cleanMomentumBlockReason } from '../../lib/strategies/clean-momentum'
import { getDailyBarsAsof, getLatestQuote, getMinuteBarsForDay, setCacheOnly, type RawBar } from './data'
import { closeMaps, edgarFloatOn, sharesRecord } from './edgar-float'
import { secCompany } from './rulebook/edgar-earnings'
import { extendUniverse, resolveTicker, type U1Result } from './u1-delisted'
import { toEasternDay } from './universe'
import { daySymbolSets, easternMidnight, loadDay, MINUTE, setFifteenMinuteWindow, type DayMarket, type MinuteBar } from './market'
import { buildUniverse, dailyIndex, floatOn, type Universe } from './universe'
import { EJW, SCAN_MINUTES } from './strategy-ej'

export const Q5 = { gain: 0.5, volume: 10_000_000, byMinute: 10 * 60 } as const
const OPEN = 9 * 60 + 30
const PRE_START = 4 * 60

// ---------------- pure helpers (tested) ----------------

/** Minimal CSV parser (quoted fields, doubled quotes, commas inside quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field); field = ''
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((x) => x !== '')) rows.push(row)
  const [head, ...body] = rows
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ''])))
}

/** First HH:MM in Ross's entry-time text, as minutes after midnight ET; null when there is none. */
export function parseMinute(text: string): number | null {
  const m = /(\d{1,2}):(\d{2})/.exec(text ?? '')
  if (!m) return null
  const h = Number(m[1]), mm = Number(m[2])
  if (h > 23 || mm > 59) return null
  return h * 60 + mm
}

/** First price in Ross's entry-price text ("~3.00", "12.72; add 13", "5.54 / 5.58"); null when there is none. */
export function parsePrice(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)/.exec((text ?? '').replace(/,/g, ''))
  if (!m) return null
  const v = Number(m[1])
  return v > 0 && v < 10_000 ? v : null
}

/** Stated P&L to a number ("-2400", "~7600", "positive (...)" -> null). */
export function parsePnl(text: string): number | null {
  const m = /^\s*~?(-?\d+(?:\.\d+)?)/.exec((text ?? '').replace(/,/g, ''))
  return m ? Number(m[1]) : null
}

const minuteOf = (t: number, midnight: number) => Math.round((t - midnight) / MINUTE)

/** Ross's entry minute: his stated time, else the first bar from 04:00 to 11:00 whose range contains his stated price. */
export function entryMinute(bars: MinuteBar[], midnight: number, timeText: string, priceText: string): { minute: number | null; how: string } {
  const stated = parseMinute(timeText)
  if (stated != null) return { minute: stated, how: 'stated time' }
  const price = parsePrice(priceText)
  if (price == null) return { minute: null, how: 'no time or price stated' }
  for (const b of bars) {
    const m = minuteOf(b.t, midnight)
    if (m < PRE_START || m >= 11 * 60) continue
    if (b.l <= price && price <= b.h) return { minute: m, how: 'first touch of stated price' }
  }
  return { minute: null, how: 'stated price never traded 04:00-11:00' }
}

/** Last scan minute at or before `minute` (E scans 07:00-11:00); entries before 07:00 map to 07:00. */
export function scanMinuteFor(minute: number): { scan: number | null; note: string } {
  if (minute < SCAN_MINUTES[0]) return { scan: SCAN_MINUTES[0], note: 'Ross entered before 07:00 (E does not scan yet); checked at 07:00' }
  if (minute >= EJW.entryEnd) return { scan: null, note: 'Ross entered at/after 11:00 (E entry window closed)' }
  let best: number | null = null
  for (const s of SCAN_MINUTES) if (s <= minute) best = s
  return { scan: best, note: 'last E scan at or before his entry' }
}

/** Day features at a minute (bars closed before `minute`), for Q4. */
export function featuresAt(bars: MinuteBar[], midnight: number, prevClose: number, minute: number) {
  const before = bars.filter((b) => minuteOf(b.t, midnight) < minute)
  const last = before.at(-1)
  const price = last ? last.c : null
  const pre = bars.filter((b) => { const m = minuteOf(b.t, midnight); return m >= PRE_START && m < Math.min(minute, OPEN) })
  const preHighBefore = pre.length > 1 ? Math.max(...pre.slice(0, -1).map((b) => b.h)) : null
  const first5 = bars.filter((b) => { const m = minuteOf(b.t, midnight); return m >= OPEN && m < OPEN + 5 }).reduce((s, b) => s + b.v, 0)
  // halt-like gaps: >= 5 minutes with no bar during regular hours, before the entry minute
  let gaps = 0
  const rth = bars.filter((b) => { const m = minuteOf(b.t, midnight); return m >= OPEN && m < minute })
  for (let k = 1; k < rth.length; k += 1) if (rth[k].t - rth[k - 1].t >= 6 * MINUTE) gaps += 1
  return {
    price,
    gainPct: price != null && prevClose > 0 ? (price / prevClose - 1) * 100 : null,
    volumeSoFar: before.reduce((s, b) => s + b.v, 0),
    first5Volume: first5,
    haltGaps: gaps,
    // premarket-high break: before the open, the price at entry is above every earlier premarket high
    pmHighBreak: minute < OPEN && price != null && preHighBefore != null ? price > preHighBefore : null,
  }
}

/** Q5: by 10:00 ET the day high is >= +50% over the prior close and volume since 04:00 is >= 10M shares. */
export function q5Qualifies(bars: Array<{ t: number; h: number; v: number }>, midnight: number, prevClose: number) {
  if (!(prevClose > 0)) return false
  let high = 0, volume = 0
  for (const b of bars) {
    const m = minuteOf(b.t, midnight)
    if (m < PRE_START || m >= Q5.byMinute) continue
    high = Math.max(high, b.h)
    volume += b.v
  }
  return high >= prevClose * (1 + Q5.gain) && volume >= Q5.volume
}

export function median(values: Array<number | null | undefined>) {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/** Which of E's entry gates fail for a scan candidate (same terms as decideEntry in lib/strategy.ts). */
export function failingGates(c: ScanCandidate, now: Date, equity: number) {
  const regime = strategyRegime(now)
  const out: string[] = []
  const rvol = c.relativeVolume ?? (c.averageVolume ? (c.volume ?? 0) / c.averageVolume : 0)
  const float = normalizeFloatShares(c.float, c.floatSource)
  const spread = c.bid && c.ask && c.price > 0 ? (c.ask - c.bid) / c.price : Infinity
  if (c.relativeVolumeReliable === false) out.push('RVOL baseline unreliable')
  if (!((c.changePercent ?? 0) > 2)) out.push('gain <= 2%')
  if (!(c.price > (c.vwap ?? Infinity))) out.push('price not above VWAP')
  if (!(rvol >= regime.rvol)) out.push(`RVOL ${rvol.toFixed(1)} < ${regime.rvol}`)
  if (!((c.volume ?? 0) >= regime.volume)) out.push(`volume < ${regime.volume}`)
  if (!((c.volume ?? 0) * c.price >= regime.dollarVolume)) out.push(`dollar volume < ${regime.dollarVolume}`)
  if (!(spread <= regime.spread)) out.push(`spread > ${(regime.spread * 100).toFixed(2)}%`)
  if (!(Number.isFinite(float) && Number(float) <= 10_000_000)) out.push(float == null ? 'float unknown' : 'float > 10M')
  if (!c.hasNews) out.push('no news in the last 24h')
  if (!(Number.isFinite(c.atr) && Number(c.atr) > 0)) out.push('no ATR')
  const score = scoreCandidate(c, now)
  if (score < regime.score) out.push(`score ${score} < ${regime.score}`)
  const atr = Number(c.atr)
  if (atr > 0) {
    const shares = Math.floor(Math.min((equity * 0.01 * regime.sizeFraction) / atr, (equity * 0.25 * regime.sizeFraction) / c.price))
    if (shares < 1) out.push('size < 1 share (ATR too large for $ risk)')
  }
  return out
}

// ---------------- I/O ----------------

type EjTrade = { day: string; symbol: string; minute: number; fill: number; pnl: number; r: number; exit: string }

function readEj(dir: string): EjTrade[] {
  const out: EjTrade[] = []
  for (const w of ['tuning', 'holdout']) {
    const p = join(dir, w, 'trades.csv')
    if (!existsSync(p)) continue
    for (const r of parseCsv(readFileSync(p, 'utf8'))) {
      if (r.run !== 'E-current') continue
      out.push({ day: r.day, symbol: r.symbol, minute: Number(r.scan_minute), fill: Number(r.fill), pnl: Number(r.pnl), r: Number(r.r), exit: r.exit_reason })
    }
  }
  return out
}

const hhmm = (m: number | null) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
const q = (s: unknown) => { const t = s == null ? '' : String(s); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
const f = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '' : x.toFixed(d))

function dailyReason(universe: Universe, symbol: string, day: string) {
  const rows = universe.daily.get(symbol)
  if (!rows) return 'not in the universe (not a listed US common stock in Alpaca assets, or renamed ticker)'
  const i = dailyIndex(rows).get(day)
  if (i == null || i < 1) return 'no daily bar that day (or no prior close)'
  const row = rows[i], prev = rows[i - 1].c
  if (row.v < scanConfig.minVolume) return `daily volume ${row.v} < ${scanConfig.minVolume}`
  const peak = Math.max(row.o, row.h)
  if (peak < scanConfig.minPrice) return `day high ${peak} < $${scanConfig.minPrice}`
  const gain = peak / prev - 1
  const fl = normalizeFloatShares(floatOn(universe, symbol, day), 'fmp')
  if (gain < 0.1 && !(gain > 0.02 && fl != null && fl <= 10_000_000)) return `day gain ${(gain * 100).toFixed(0)}% < 10% and float ${fl == null ? 'unknown' : `${(fl / 1e6).toFixed(1)}M`}`
  return null
}

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true'] as const }))
  const csvPath = join(process.cwd(), args.get('csv') ?? 'backtests/ross-audit/trades.csv')
  const ejDir = join(process.cwd(), args.get('ej') ?? 'backtests/strategy-ej')
  const out = join(process.cwd(), args.get('out') ?? 'backtests/ross-audit')
  const prefetch = args.get('prefetch') === 'true'
  const fetch = args.get('fetch') === 'true' || prefetch
  const useU1 = args.get('u1') === 'true'
  const onlyQ1 = args.get('only') === 'q1q2'
  setCacheOnly(!fetch)
  const log: string[] = []
  const say = (s: string) => { console.log(s); log.push(s) }
  say(`[ross] read-only audit; ${fetch ? 'missing data may be fetched (read-only GETs)' : 'cache only'}`)

  const rows = parseCsv(readFileSync(csvPath, 'utf8'))
  const sampled = rows.filter((r) => r.row_type === 'traded' && !/MENTIONED/.test(r.notes))
  const passed = rows.filter((r) => r.row_type === 'passed')
  const ej = readEj(ejDir)
  if (!ej.length) throw new Error(`No E-current trades found under ${ejDir}/{tuning,holdout}/trades.csv`)
  say(`[ross] ${sampled.length} sampled Ross ticker-days (${rows.filter((r) => r.row_type === 'traded').length - sampled.length} mentioned-only rows ignored), ${passed.length} passes; ${ej.length} E-current trades`)

  const historyStart = new Date(Date.parse(`${EJW.start}T00:00:00Z`) - EJW.historyLookbackDays * 86_400_000).toISOString().slice(0, 10)
  setFifteenMinuteWindow(historyStart, EJW.end)
  const universe = await buildUniverse({ historyStart, end: EJW.end, periodStart: EJW.start, simFrom: EJW.start, simTo: EJW.end })
  const baseSymbols = new Set(universe.daily.keys())
  let u1: U1Result | null = null
  const resolved = new Map<string, { key: string | null; how: string }>()
  if (useU1) {
    u1 = await extendUniverse(universe, { historyStart, end: EJW.end }, { edgar: true })
    say(`[ross] U1: ${u1.entities.filter((e) => e.bars > 0).length} delisted entities added, ${u1.renames.length} renames; universe now ${universe.symbols.length} symbols`)
    const daysOf = new Map<string, Set<string>>()
    const hasBar = (key: string, day: string) => { let set = daysOf.get(key); if (!set) { set = new Set((universe.daily.get(key) ?? []).map((r) => r.day)); daysOf.set(key, set) } return set.has(day) }
    const added = u1.entities.filter((e) => e.bars > 0)
    for (const r of sampled) {
      const t = r.ticker.replace(/\?$/, '')
      if (/^[A-Z]{1,5}$/.test(t)) resolved.set(`${r.trading_date}|${r.ticker}`, resolveTicker(t, r.trading_date, hasBar, added, u1.renames))
    }
    // EDGAR point-in-time float (shares outstanding, D1 method) for the delisted entities Ross traded
    const keys = [...new Set([...resolved.values()].filter((x) => x.how === 'delisted' || x.key?.includes('@')).map((x) => x.key!))]
    const floats = new Map<string, (day: string) => number | undefined>()
    for (const key of keys) {
      const e = added.find((x) => x.key === key)!
      if (!e.cik) { floats.set(key, () => undefined); continue }
      try {
        const [record, company] = [await sharesRecord(e.cik), await secCompany(e.cik)]
        const [rawB, splitB] = [await getDailyBarsAsof([e.ticker], historyStart, EJW.end, e.asof), await getDailyBarsAsof([e.ticker], historyStart, EJW.end, e.asof, 'split')]
        const ratios = closeMaps(rawB[e.ticker], splitB[e.ticker], toEasternDay)
        const data = { cik: e.cik, record, nameOk: true, annual: company.annual }
        floats.set(key, (day) => { const f = edgarFloatOn(data, day, ratios); return 'shares' in f ? f.shares : undefined })
      } catch (error) { say(`[ross] U1 EDGAR float for ${key} failed: ${(error as Error).message.slice(0, 120)}`); floats.set(key, () => undefined) }
    }
    universe.u1Float = (key, day) => floats.get(key)?.(day)
  }
  const days = universe.tradingDays.filter((d) => d >= EJW.start && d <= EJW.end)
  const ejByDay = new Map<string, EjTrade[]>()
  for (const t of ej) ejByDay.set(t.day, [...(ejByDay.get(t.day) ?? []), t])
  // E equity before each day (compounding from $2,000, as in the replay)
  const eqBefore = new Map<string, number>()
  let eq = EJW.equity
  for (const d of days) { eqBefore.set(d, eq); eq += (ejByDay.get(d) ?? []).reduce((s, t) => s + t.pnl, 0) }

  const rossDays = [...new Set(sampled.map((r) => r.trading_date))].filter((d) => days.includes(d)).sort()
  const q1: string[] = ['day,ticker,small_account,ross_entry_et,entry_how,scan_et,scan_note,in_day_set,day_set_reason,e_rank,scanner_eligible,float_ok_symbol,ever_e_eligible_0700_1100,first_eligible_et,gates_failing,quote,spread_pct,clean_filter,e_decision,e_traded_it,e_pnl,base_universe_has_ticker,u1_resolved_as,u1_key']
  const q4: string[] = ['who,day,ticker,entry_et,float_m,gain_pct,rvol,price,news_age_min,halt_gaps,first5_volume,pm_high_break']
  const q3: string[] = ['day,symbol,e_entry_et,e_fill,e_pnl,e_r,e_exit,ross_traded,ross_passed_reason']
  const blockCount = new Map<string, number>()
  const bump = (k: string) => blockCount.set(k, (blockCount.get(k) ?? 0) + 1)
  const rossFeat: Array<Record<string, number | null | boolean>> = []
  const eFeat: Array<Record<string, number | null | boolean>> = []

  for (const day of rossDays) {
    let market: DayMarket
    try { market = await loadDay(universe, day) } catch (e) { say(`[ross] ${day}: could not load the day from cache (${(e as Error).message})`); continue }
    const midnight = market.midnight
    const eTrades = ejByDay.get(day) ?? []
    const rossTickers = new Set(sampled.filter((r) => r.trading_date === day).map((r) => resolved.get(`${day}|${r.ticker}`)?.key ?? r.ticker.replace(/\?$/, '')))
    for (const r of sampled.filter((x) => x.trading_date === day)) {
      const ticker = r.ticker.replace(/\?$/, '')
      const res = resolved.get(`${day}|${r.ticker}`)
      const sym = res?.key ?? ticker
      const small = /SMALL/.test(r.notes)
      if (!/^[A-Z]{1,5}$/.test(ticker)) {
        bump('ticker not named')
        q1.push([day, r.ticker, small, '', '', '', '', 'no', 'ticker not named / not a symbol', '', '', '', '', '', '', '', '', '', 'ticker not named', '', '', '', '', ''].map(q).join(','))
        continue
      }
      const data = market.symbols.get(sym)
      const reason = data ? null : dailyReason(universe, sym, day) ?? 'in the day set but no minute bars'
      const em = data ? entryMinute(data.bars, midnight, r.entry_time_et, r.entry_price) : { minute: parseMinute(r.entry_time_et), how: parseMinute(r.entry_time_et) != null ? 'stated time' : 'no bars' }
      const sm = em.minute != null ? scanMinuteFor(em.minute) : { scan: null, note: 'Ross entry time unknown' }
      let rank = '', scannerEligible = '', floatOk = '', gates = '', quote = '', spread = '', clean = '', decision = ''
      let everEligible = 'no', firstEligible = ''
      for (const s of SCAN_MINUTES) {
        const c = market.candidatesAt(s).find((x) => x.symbol === sym)
        if (c && c.scannerEligible && c.entryEligibleSymbol) { everEligible = 'yes'; firstEligible = hhmm(s); break }
      }
      if (!data) { decision = `not in E's day set: ${reason}`; bump(`not in day set: ${reason!.split(' (')[0].replace(/[0-9.]+/g, 'N')}`) }
      else if (sm.scan == null) { decision = sm.note; bump(sm.note.split(' (')[0]) }
      else {
        const now = midnight + sm.scan * MINUTE
        const c = market.candidatesAt(sm.scan).find((x) => x.symbol === sym)
        if (!c) {
          const bars = data.bars.filter((b) => b.t + MINUTE <= now)
          decision = bars.length ? `not in E's top ${market.candidatesAt(sm.scan).length} gainers at ${hhmm(sm.scan)}` : `no trades yet at ${hhmm(sm.scan)}`
          bump(bars.length ? 'not in top-25 gainers at that scan' : 'no trades yet at that scan')
        } else {
          rank = String(c.rank); scannerEligible = String(c.scannerEligible); floatOk = String(c.entryEligibleSymbol)
          const g = failingGates(c, new Date(now), eqBefore.get(day) ?? EJW.equity)
          gates = g.join('; ')
          if (!c.scannerEligible) { decision = 'scanner: price/volume/dollar-volume below the scan minimum'; bump('scanner minimum') }
          else if (!c.entryEligibleSymbol) { decision = 'float > 10M or unknown (E entry list)'; bump('float > 10M or unknown') }
          else if (g.length) { decision = `E gates: ${g[0]}`; bump(`gate: ${g[0].replace(/[0-9.]+/g, 'N')}`) }
          else {
            let mark: { bp: number; ap: number } | null = null
            try { mark = await getLatestQuote(day, sym, new Date(now), scanConfig.maxQuoteAgeSeconds) } catch { quote = 'not cached'; decision = 'quote not in cache (E never asked for one here)'; bump('quote not cached') }
            if (mark) {
              const mid = (mark.bp + mark.ap) / 2
              const sp = ((mark.ap - mark.bp) / mid) * 100
              quote = `${mark.bp}/${mark.ap}`; spread = sp.toFixed(2)
              const blocked = cleanMomentumBlockReason({ changePercent: c.changePercent, price: c.price, spreadPct: sp, regime: strategyRegime(new Date(now)).name, entryIndex: 1, firstEntryHitTarget: false })
              clean = blocked ?? 'pass'
              decision = blocked ? `E filter: ${blocked}` : 'E would enter (if a slot and the daily loss limit allow)'
              bump(blocked ? `E filter: ${blocked}` : 'E would enter')
            } else if (!quote) { quote = 'none'; decision = 'no executable quote'; bump('no executable quote') }
          }
        }
      }
      const eT = eTrades.filter((t) => t.symbol === sym)
      q1.push([day, r.ticker, small, hhmm(em.minute), em.how, hhmm(sm.scan), sm.note, data ? 'yes' : 'no', reason ?? '', rank, scannerEligible, floatOk, everEligible, firstEligible, gates, quote, spread, clean, decision,
        eT.length ? 'yes' : 'no', eT.length ? f(eT.reduce((s, t) => s + t.pnl, 0)) : '', baseSymbols.has(ticker) ? 'yes' : 'no', res?.how ?? '', res?.key ?? ''].map(q).join(','))
      if (data && em.minute != null) {
        const ft = featuresAt(data.bars, midnight, data.prevClose, em.minute)
        const c = market.candidatesAt(Math.max(SCAN_MINUTES[0], Math.min(em.minute, 15 * 60 + 54))).find((x) => x.symbol === sym)
        const news = data.news.find((n) => n.at <= midnight + em.minute! * MINUTE)
        const feat = { float: data.float ?? null, gain: ft.gainPct, rvol: em.minute >= SCAN_MINUTES[0] ? c?.relativeVolume ?? null : null, price: ft.price, minute: em.minute,
          newsAge: news ? (midnight + em.minute * MINUTE - news.at) / MINUTE : null, halts: ft.haltGaps, first5: ft.first5Volume, pm: ft.pmHighBreak }
        if (!small) rossFeat.push(feat)
        q4.push(['Ross' + (small ? ' (small acct)' : ''), day, r.ticker, hhmm(em.minute), f(feat.float != null ? feat.float / 1e6 : null, 2), f(feat.gain, 1), f(feat.rvol, 1), f(feat.price), f(feat.newsAge, 0), feat.halts, feat.first5, feat.pm ?? ''].map(q).join(','))
      }
    }
    for (const t of onlyQ1 ? [] : eTrades) {
      const data = market.symbols.get(t.symbol)
      if (data) {
        const ft = featuresAt(data.bars, midnight, data.prevClose, t.minute)
        const c = market.candidatesAt(t.minute).find((x) => x.symbol === t.symbol)
        const news = data.news.find((n) => n.at <= midnight + t.minute * MINUTE)
        const feat = { float: data.float ?? null, gain: ft.gainPct, rvol: c?.relativeVolume ?? null, price: ft.price, minute: t.minute,
          newsAge: news ? (midnight + t.minute * MINUTE - news.at) / MINUTE : null, halts: ft.haltGaps, first5: ft.first5Volume, pm: ft.pmHighBreak }
        eFeat.push(feat)
        q4.push(['E', day, t.symbol, hhmm(t.minute), f(feat.float != null ? feat.float / 1e6 : null, 2), f(feat.gain, 1), f(feat.rvol, 1), f(feat.price), f(feat.newsAge, 0), feat.halts, feat.first5, feat.pm ?? ''].map(q).join(','))
      }
      if (!rossTickers.has(t.symbol)) {
        const p = passed.find((x) => x.trading_date === day && x.ticker.replace(/\?$/, '') === t.symbol)
        q3.push([day, t.symbol, hhmm(t.minute), f(t.fill, 3), f(t.pnl), f(t.r, 2), t.exit, 'no', p ? p.pass_reason : ''].map(q).join(','))
      } else q3.push([day, t.symbol, hhmm(t.minute), f(t.fill, 3), f(t.pnl), f(t.r, 2), t.exit, 'yes', ''].map(q).join(','))
    }
  }

  // ---------------- Q5 ----------------
  if (!onlyQ1) say(`[ross] Q5: counting stocks up >= ${Q5.gain * 100}% on >= ${Q5.volume / 1e6}M shares by ${hhmm(Q5.byMinute)} ET on ${days.length} days...`)
  const rossDayPnl = new Map<string, { pnl: number | null; temp: string }>()
  for (const d of rossDays) {
    const list = sampled.filter((r) => r.trading_date === d && !/SMALL/.test(r.notes))
    const stated = list.map((r) => parsePnl(r.day_pnl)).find((x) => x != null)
    const sum = list.map((r) => parsePnl(r.stated_pnl))
    rossDayPnl.set(d, { pnl: stated ?? (sum.every((x) => x != null) && sum.length ? sum.reduce((a, b) => a! + b!, 0) : null), temp: list.find((r) => r.temperature)?.temperature ?? '' })
  }
  for (const r of rows.filter((x) => x.row_type === 'day')) if (!rossDayPnl.has(r.trading_date) && days.includes(r.trading_date) && /NO TRADES/.test(r.notes)) rossDayPnl.set(r.trading_date, { pnl: 0, temp: r.temperature })
  const q5: string[] = ['day,count,symbols,ross_day_pnl,ross_temperature,e_trades,e_pnl']
  const daily: Array<{ day: string; n: number; ross: number | null; temp: string; eN: number; eP: number }> = []
  let missing = 0
  for (const d of onlyQ1 ? [] : days) {
    const { pool, entryCandidates } = daySymbolSets(universe, d)
    const midnight = easternMidnight(d)
    let raw: Record<string, RawBar[]>
    try { raw = await getMinuteBarsForDay(d, [...pool, ...entryCandidates], new Date(midnight + 4 * 60 * MINUTE).toISOString(), new Date(midnight + 16 * 60 * MINUTE).toISOString()) } catch { missing += 1; continue }
    const hits: string[] = []
    for (const s of pool) {
      const rowsD = universe.daily.get(s)!, i = dailyIndex(rowsD).get(d)!
      const prev = rowsD[i - 1].c
      if (Math.max(rowsD[i].o, rowsD[i].h) < prev * (1 + Q5.gain)) continue
      const bars = (raw[s] ?? []).map((b) => ({ t: Date.parse(b.t), h: b.h, v: b.v }))
      if (q5Qualifies(bars, midnight, prev)) hits.push(s)
    }
    const eT = ejByDay.get(d) ?? []
    const rp = rossDayPnl.get(d)
    daily.push({ day: d, n: hits.length, ross: rp?.pnl ?? null, temp: rp?.temp ?? '', eN: eT.length, eP: eT.reduce((s, t) => s + t.pnl, 0) })
    q5.push([d, hits.length, hits.join(' '), rp ? f(rp.pnl) : '', rp?.temp ?? '', eT.length, f(eT.reduce((s, t) => s + t.pnl, 0))].map(q).join(','))
  }

  // ---------------- report ----------------
  if (prefetch) { say(`[ross] prefetch done: data for the ${rossDays.length} days is cached; rerun without --prefetch for the report (cache only)`); return }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'q1q2.csv'), q1.join('\n') + '\n')
  if (!onlyQ1) {
    writeFileSync(join(out, 'q3.csv'), q3.join('\n') + '\n')
    writeFileSync(join(out, 'q4.csv'), q4.join('\n') + '\n')
    writeFileSync(join(out, 'q5-daily.csv'), q5.join('\n') + '\n')
  }

  say(`\n[ross] ===== Q1/Q2: Ross's ${sampled.length} sampled ticker-days on ${rossDays.length} days in the E window =====`)
  for (const [k, v] of [...blockCount].sort((a, b) => b[1] - a[1])) say(`      ${String(v).padStart(4)}  ${k}`)
  const q1rows = parseCsv(q1.join('\n'))
  say(`      ever scanner+float eligible at an E scan 07:00-11:00: ${q1rows.filter((r) => r.ever_e_eligible_0700_1100 === 'yes').length} of ${q1rows.length}; E traded the same ticker that day: ${q1rows.filter((r) => r.e_traded_it === 'yes').length}`)
  if (u1) {
    const missingBefore = q1rows.filter((r) => r.base_universe_has_ticker === 'no' && /^[A-Z]{1,5}\??$/.test(r.ticker))
    const by = (how: string) => missingBefore.filter((r) => r.u1_resolved_as === how)
    say(`\n[ross] ===== U1: tickers missing from today's universe (${missingBefore.length}) =====`)
    say(`      now found as a delisted entity: ${by('delisted').length} (${by('delisted').map((r) => r.u1_key).join(', ')})`)
    say(`      now found through a rename:     ${by('rename').length} (${by('rename').map((r) => `${r.ticker}->${r.u1_key}`).join(', ')})`)
    say(`      still missing:                  ${by('missing').length} (${by('missing').map((r) => `${r.ticker} ${r.day}`).join(', ')})`)
    const found = missingBefore.filter((r) => r.u1_resolved_as === 'delisted' || r.u1_resolved_as === 'rename')
    const decisions = new Map<string, number>()
    for (const r of found) { const k = r.e_decision.replace(/[0-9.]+/g, 'N').split(':').slice(0, 2).join(':'); decisions.set(k, (decisions.get(k) ?? 0) + 1) }
    say(`      E decision for the newly found: ${[...decisions].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join('; ') || 'none'}`)
    for (const [k, v] of Object.entries(u1.stats)) say(`      U1 ${String(v).padStart(6)}  ${k}`)
  }
  if (onlyQ1) { say(`\n[ross] wrote ${out}: q1q2.csv, report.txt (Q1/Q2 only)`); writeFileSync(join(out, 'report.txt'), log.join('\n') + '\n'); return }
  const q3rows = parseCsv(q3.join('\n'))
  say(`\n[ross] ===== Q3: E-current trades on Ross's days =====`)
  say(`      ${q3rows.length} E trades; ${q3rows.filter((r) => r.ross_traded === 'yes').length} in tickers Ross traded, ${q3rows.filter((r) => r.ross_traded === 'no').length} not (${q3rows.filter((r) => r.ross_passed_reason).length} of those he named and passed on)`)
  const sumP = (l: Record<string, string>[]) => l.reduce((s, r) => s + Number(r.e_pnl || 0), 0)
  say(`      E P&L on Ross's tickers $${sumP(q3rows.filter((r) => r.ross_traded === 'yes')).toFixed(2)}, on others $${sumP(q3rows.filter((r) => r.ross_traded === 'no')).toFixed(2)}`)
  say(`\n[ross] ===== Q4: medians at entry (Ross main account n=${rossFeat.length}, E n=${eFeat.length}) =====`)
  const share = (l: typeof rossFeat, k: string) => { const v = l.map((x) => x[k]).filter((x) => x != null); return v.length ? `${((v.filter(Boolean).length / v.length) * 100).toFixed(0)}% of ${v.length}` : 'n/a' }
  for (const [label, k, scale, d] of [['float (M shares)', 'float', 1e-6, 2], ['% gain at entry', 'gain', 1, 1], ['RVOL (E scan baseline)', 'rvol', 1, 1], ['price', 'price', 1, 2], ['entry time (min after midnight ET)', 'minute', 1, 0],
    ['news age (min, Alpaca news only)', 'newsAge', 1, 0], ['halt-like gaps before entry', 'halts', 1, 0], ['first-5-minute volume (09:30-09:35)', 'first5', 1, 0]] as Array<[string, string, number, number]>) {
    const a = median(rossFeat.map((x) => (x[k] as number | null) == null ? null : (x[k] as number) * scale)), b = median(eFeat.map((x) => (x[k] as number | null) == null ? null : (x[k] as number) * scale))
    const cov = (l: typeof rossFeat) => l.filter((x) => x[k] != null).length
    say(`      ${label.padEnd(38)} Ross ${f(a, d).padStart(10)} (n ${cov(rossFeat)})   E ${f(b, d).padStart(10)} (n ${cov(eFeat)})${k === 'minute' ? `   = Ross ${hhmm(a == null ? null : Math.round(a))}, E ${hhmm(b == null ? null : Math.round(b))}` : ''}`)
  }
  say(`      premarket-high break at entry (premarket entries only): Ross ${share(rossFeat, 'pm')}, E ${share(eFeat, 'pm')}`)
  say(`\n[ross] ===== Q5: stocks up >= 50% on >= 10M shares by 10:00 ET (${daily.length} days${missing ? `, ${missing} days missing from cache` : ''}) =====`)
  const buckets: Array<[string, (n: number) => boolean]> = [['0', (n) => n === 0], ['1', (n) => n === 1], ['2', (n) => n === 2], ['3-4', (n) => n >= 3 && n <= 4], ['5+', (n) => n >= 5]]
  for (const [label, test] of buckets) {
    const l = daily.filter((x) => test(x.n))
    const rd = l.filter((x) => x.ross != null)
    const hot = rd.filter((x) => x.temp === 'hot').length, cold = rd.filter((x) => x.temp === 'cold').length
    say(`      count ${label.padEnd(4)} ${String(l.length).padStart(4)} days | E: ${l.reduce((s, x) => s + x.eN, 0)} trades, $${l.reduce((s, x) => s + x.eP, 0).toFixed(0)} total, $${(l.length ? l.reduce((s, x) => s + x.eP, 0) / l.length : 0).toFixed(2)}/day | Ross sampled days ${rd.length}: median day $${f(median(rd.map((x) => x.ross)), 0)}, hot ${hot} / cold ${cold}`)
  }
  const corr = (xs: number[], ys: number[]) => { const n = xs.length; if (n < 3) return null; const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2 } return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null }
  const rd = daily.filter((x) => x.ross != null)
  say(`      correlation count vs Ross day P&L (n ${rd.length}): ${f(corr(rd.map((x) => x.n), rd.map((x) => x.ross!)))}; count vs E day P&L (n ${daily.length}): ${f(corr(daily.map((x) => x.n), daily.map((x) => x.eP)))}`)
  for (const t of ['hot', 'neutral', 'cold']) { const l = rd.filter((x) => x.temp === t); say(`      Ross said ${t.padEnd(7)}: ${l.length} days, median count ${f(median(l.map((x) => x.n)), 1)}, median Ross day $${f(median(l.map((x) => x.ross)), 0)}`) }
  say(`\n[ross] wrote ${out}: q1q2.csv, q3.csv, q4.csv, q5-daily.csv, report.txt`)
  writeFileSync(join(out, 'report.txt'), log.join('\n') + '\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('[ross] failed', error)
    process.exitCode = 1
  })
}
