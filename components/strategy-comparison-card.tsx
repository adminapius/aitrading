'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { GitCompareArrows } from 'lucide-react'

type Metric = { strategy: string; trades: number; winRate: number | null; averageR: number | null; totalPnl: number }
type ComparisonData = { live: Metric; shadow: Metric | null }

const fetcher = async (url: string): Promise<ComparisonData> => {
  const response = await fetch(url)
  const body = await response.json()
  if (!response.ok) throw new Error(body?.error ?? 'Strategy comparison unavailable')
  return body as ComparisonData
}

const easternToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
const money = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

function Row({ label, note, metric }: { label: string; note: string; metric: Metric }) {
  return (
    <tr>
      <th scope="row"><strong>{label}</strong><small>{note}</small></th>
      <td>{metric.trades.toLocaleString()}</td>
      <td>{metric.winRate == null ? '—' : `${(metric.winRate * 100).toFixed(1)}%`}</td>
      <td>{metric.averageR == null ? '—' : `${metric.averageR.toFixed(2)}R`}</td>
      <td className={metric.totalPnl >= 0 ? 'elliott-positive' : 'elliott-negative'}>{money(metric.totalPnl)}</td>
    </tr>
  )
}

export default function StrategyComparisonCard() {
  const today = easternToday()
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const { data, error, isLoading } = useSWR<ComparisonData>(`/api/strategy/comparison?${new URLSearchParams({ from, to })}`, fetcher, { refreshInterval: 30_000 })

  return (
    <section className="panel elliott-dashboard" aria-labelledby="strategy-comparison-title">
      <div className="elliott-dashboard-head">
        <div>
          <div className="elliott-kicker"><GitCompareArrows aria-hidden="true" /> LIVE VS SHADOW</div>
          <h2 id="strategy-comparison-title">Strategy {data?.live.strategy ?? 'E'} vs shadow {data?.shadow?.strategy ?? 'A'}</h2>
          <p>Closed paper trades from the live strategy next to simulated outcomes of the shadow strategy on the same scans.</p>
        </div>
        <div className="elliott-filters">
          <label>From<input aria-label="Comparison from date" type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>To<input aria-label="Comparison to date" type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
        </div>
      </div>
      {error ? <div className="elliott-dashboard-state" role="status">{error.message}</div> : isLoading && !data ? <div className="elliott-dashboard-state" role="status">Loading comparison…</div> : null}
      {data && (
        <div className="elliott-table-scroll">
          <table className="elliott-table">
            <thead><tr><th scope="col">Strategy</th><th scope="col">Trades</th><th scope="col">Win rate</th><th scope="col">Average R</th><th scope="col">Total P&amp;L</th></tr></thead>
            <tbody>
              <Row label={`Live ${data.live.strategy}`} note="Paper orders placed" metric={data.live} />
              {data.shadow ? <Row label={`Shadow ${data.shadow.strategy}`} note="Simulated, no orders" metric={data.shadow} /> : <tr><th scope="row">Shadow</th><td colSpan={4}>STRATEGY_SHADOW not set</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
