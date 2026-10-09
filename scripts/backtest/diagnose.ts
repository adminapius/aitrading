import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), process.argv.find((arg) => arg.startsWith('--dir='))?.slice(6) ?? 'backtests/2026-10-diagnosis')
const runId = process.argv.find((arg) => arg.startsWith('--run='))?.slice(6) ?? 'A'
const MIN_RELIABLE = 30

function parseCsv(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index++ }
      else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(cell); cell = '' }
    else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += char
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const [header, ...body] = rows
  return body.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])))
}

type Row = Record<string, string>
const num = (value: string) => (value === '' ? null : Number(value))
const trades = parseCsv(readFileSync(join(dir, 'trades.csv'), 'utf8')).filter((trade) => trade.run === runId)

type Stats = { trades: number; winRate: number; avgR: number; totalPnl: number; zeroSlipPnl: number; reliable: boolean }
function stats(group: Row[]): Stats {
  const pnl = group.reduce((sum, trade) => sum + Number(trade.pnl), 0)
  return {
    trades: group.length,
    winRate: group.length ? group.filter((trade) => Number(trade.pnl) > 0).length / group.length : 0,
    avgR: group.length ? group.reduce((sum, trade) => sum + Number(trade.r), 0) / group.length : 0,
    totalPnl: pnl,
    zeroSlipPnl: group.reduce((sum, trade) => sum + Number(trade.zeroSlipPnl || trade.pnl), 0),
    reliable: group.length >= MIN_RELIABLE,
  }
}

function bucketBy(key: (trade: Row) => string, order?: string[]) {
  const groups = new Map<string, Row[]>()
  for (const trade of trades) groups.set(key(trade), [...(groups.get(key(trade)) ?? []), trade])
  const names = order ? order.filter((name) => groups.has(name)).concat([...groups.keys()].filter((name) => !order.includes(name)).sort()) : [...groups.keys()].sort()
  return names.map((name) => ({ segment: name, ...stats(groups.get(name)!) }))
}

const etClock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const quarterHour = (trade: Row) => {
  const minute = num(trade.entryMinuteOfDay)
  if (minute == null) return 'unknown'
  const start = Math.floor(minute / 15) * 15
  return `${etClock(start)}-${etClock(start + 15)}`
}
const priceBucket = (trade: Row) => {
  const price = Number(trade.entryPrice)
  return price < 1 ? '<$1' : price < 3 ? '$1-3' : price < 10 ? '$3-10' : '>$10'
}
const floatBucket = (trade: Row) => {
  const float = num(trade.float)
  if (float == null) return 'unknown'
  return float < 5e6 ? '<5M' : float < 20e6 ? '5-20M' : float < 50e6 ? '20-50M' : '>50M'
}
const spreadBucket = (trade: Row) => {
  const spread = num(trade.entrySpreadPct)
  if (spread == null) return 'unknown'
  return spread < 0.25 ? '<0.25%' : spread < 0.5 ? '0.25-0.5%' : spread < 1 ? '0.5-1%' : '>=1%'
}
const changeBucket = (trade: Row) => {
  const change = num(trade.changePctAtEntry)
  if (change == null) return 'unknown'
  return change < 20 ? '<20%' : change < 50 ? '20-50%' : change < 100 ? '50-100%' : '>100%'
}
const reentryBucket = (trade: Row) => (Number(trade.entryIndex) <= 1 ? 'first entry' : `re-entry #${Math.min(Number(trade.entryIndex), 4) === 4 ? '4+' : trade.entryIndex}`)
const seenBucket = (trade: Row) => {
  const minutes = num(trade.minutesSinceFirstSeen)
  if (minutes == null) return 'unknown'
  return minutes < 5 ? '<5m' : minutes < 15 ? '5-15m' : minutes < 30 ? '15-30m' : minutes < 60 ? '30-60m' : minutes < 120 ? '60-120m' : '>=120m'
}

const dimensions = {
  exitType: bucketBy((trade) => trade.exitKind),
  timeOfDay: bucketBy(quarterHour),
  regime: bucketBy((trade) => trade.regime),
  price: bucketBy(priceBucket, ['<$1', '$1-3', '$3-10', '>$10']),
  float: bucketBy(floatBucket, ['<5M', '5-20M', '20-50M', '>50M', 'unknown']),
  spreadAtEntry: bucketBy(spreadBucket, ['<0.25%', '0.25-0.5%', '0.5-1%', '>=1%', 'unknown']),
  dayGainAtEntry: bucketBy(changeBucket, ['<20%', '20-50%', '50-100%', '>100%', 'unknown']),
  entryOrdinal: bucketBy(reentryBucket, ['first entry', 're-entry #2', 're-entry #3', 're-entry #4+']),
  minutesSinceFirstSeen: bucketBy(seenBucket, ['<5m', '5-15m', '15-30m', '30-60m', '60-120m', '>=120m', 'unknown']),
}

const losers = trades.filter((trade) => Number(trade.pnl) <= 0)
const winners = trades.filter((trade) => Number(trade.pnl) > 0)
const mfe = (trade: Row) => Number(trade.mfeR || 0)
const excursion = {
  losers: losers.length,
  losersReachedHalfR: losers.filter((trade) => mfe(trade) >= 0.5).length,
  losersReachedOneR: losers.filter((trade) => mfe(trade) >= 1).length,
  losersNeverPositive: losers.filter((trade) => mfe(trade) <= 0).length,
  avgLoserMfeR: losers.length ? losers.reduce((sum, trade) => sum + mfe(trade), 0) / losers.length : 0,
  avgLoserMaeR: losers.length ? losers.reduce((sum, trade) => sum + Number(trade.maeR || 0), 0) / losers.length : 0,
  winners: winners.length,
  avgWinnerMfeR: winners.length ? winners.reduce((sum, trade) => sum + mfe(trade), 0) / winners.length : 0,
  avgWinnerMaeR: winners.length ? winners.reduce((sum, trade) => sum + Number(trade.maeR || 0), 0) / winners.length : 0,
  mfeDistribution: bucketBy((trade) => { const value = mfe(trade); return value <= 0 ? 'MFE<=0' : value < 0.5 ? '0-0.5R' : value < 1 ? '0.5-1R' : value < 2 ? '1-2R' : '>=2R' }, ['MFE<=0', '0-0.5R', '0.5-1R', '1-2R', '>=2R']),
}

const total = stats(trades)
const slippage = { modeledPnl: total.totalPnl, zeroSlipPnl: total.zeroSlipPnl, slippageCost: total.zeroSlipPnl - total.totalPnl }

const segments = Object.entries(dimensions).flatMap(([dimension, rows]) => (dimension === 'exitType' ? [] : rows.map((row) => ({ dimension, ...row }))))
const worst = [...segments].sort((left, right) => left.totalPnl - right.totalPnl).slice(0, 5)
const best = segments.filter((row) => row.totalPnl > 0).sort((left, right) => right.totalPnl - left.totalPnl).slice(0, 5)

const result = { run: runId, period: { from: trades[0]?.date, to: trades.at(-1)?.date }, total, slippage, excursion, dimensions, worstSegments: worst, bestSegments: best, minReliableTrades: MIN_RELIABLE }
writeFileSync(join(dir, `diagnosis-${runId}.json`), JSON.stringify(result, null, 2) + '\n')

const money = (value: number) => `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(0)}`
const table = (rows: Array<{ segment: string; dimension?: string } & Stats>, withDimension = false) => [
  `| ${withDimension ? 'Dimension | ' : ''}Segment | Trades | Win % | Avg R | P&L | Zero-slip P&L | Note |`,
  `|${withDimension ? '---|' : ''}---|---:|---:|---:|---:|---:|---|`,
  ...rows.map((row) => `| ${withDimension ? `${row.dimension} | ` : ''}${row.segment} | ${row.trades} | ${(row.winRate * 100).toFixed(0)}% | ${row.avgR.toFixed(2)} | ${money(row.totalPnl)} | ${money(row.zeroSlipPnl)} | ${row.reliable ? '' : 'unreliable (<30)'} |`),
].join('\n')

const markdown = [
  `# Strategy ${runId} diagnosis (${result.period.from} to ${result.period.to})`,
  '',
  `Trades ${total.trades}, win rate ${(total.winRate * 100).toFixed(1)}%, avg R ${total.avgR.toFixed(3)}, P&L ${money(total.totalPnl)}; zero-slippage P&L ${money(slippage.zeroSlipPnl)} (slippage cost ${money(slippage.slippageCost)}).`,
  '',
  '## MFE/MAE',
  `Losers ${excursion.losers}: reached +0.5R first ${excursion.losersReachedHalfR}, reached +1R first ${excursion.losersReachedOneR}, never positive ${excursion.losersNeverPositive}. Avg loser MFE ${excursion.avgLoserMfeR.toFixed(2)}R / MAE ${excursion.avgLoserMaeR.toFixed(2)}R. Avg winner MFE ${excursion.avgWinnerMfeR.toFixed(2)}R / MAE ${excursion.avgWinnerMaeR.toFixed(2)}R.`,
  '',
  table(excursion.mfeDistribution),
  ...Object.entries(dimensions).flatMap(([name, rows]) => ['', `## ${name}`, table(rows)]),
  '',
  '## Top 5 losing segments',
  table(worst, true),
  '',
  '## Top 5 profitable segments',
  best.length ? table(best, true) : 'None.',
  '',
].join('\n')
writeFileSync(join(dir, `diagnosis-${runId}.md`), markdown)
console.log(markdown)
