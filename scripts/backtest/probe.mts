import { apiStats } from './data'
import { buildUniverse, dailyIndex } from './universe'

const started = Date.now()
const universe = await buildUniverse({ historyStart: '2026-02-10', end: '2026-10-07', periodStart: '2026-04-08' })
console.log('symbols', universe.symbols.length, 'delisted', universe.delisted.size, 'withDaily', universe.daily.size, 'floats', Object.keys(universe.floats).length, 'days', universe.tradingDays.length, universe.tradingDays[0], universe.tradingDays.at(-1))
const indexes = new Map([...universe.daily].map(([s, rows]) => [s, dailyIndex(rows)]))
let poolTotal = 0, candTotal = 0
const sample: string[] = []
for (const day of universe.tradingDays) {
  let pool = 0, cand = 0
  for (const [symbol, rows] of universe.daily) {
    const i = indexes.get(symbol)!.get(day)
    if (i == null || i === 0) continue
    const row = rows[i], prev = rows[i - 1].c
    const up = Math.max(row.h, row.o) / prev - 1
    if (up >= 0.10) pool++
    const f = universe.floats[symbol]
    if (up > 0.02 && row.h >= 1 && row.v >= 100_000 && row.v * row.h >= 500_000 && f != null && f <= 10_000_000) cand++
  }
  poolTotal += pool; candTotal += cand
  if (sample.length < 8) sample.push(`${day}:pool=${pool},cand=${cand}`)
}
console.log(sample.join(' '))
console.log('poolTotal', poolTotal, 'candTotal', candTotal, 'avgPool', (poolTotal / universe.tradingDays.length).toFixed(1), 'avgCand', (candTotal / universe.tradingDays.length).toFixed(1))
console.log('api', JSON.stringify(apiStats), 'sec', ((Date.now() - started) / 1000).toFixed(0))
