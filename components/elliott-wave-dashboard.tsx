'use client'

import useSWR from 'swr'
import { useState } from 'react'
import { Activity } from 'lucide-react'
import { elliottWaveConfig } from '@/lib/elliott-wave-config'

type Metric = {
  signals: number
  closedTrades: number
  winRate: number | null
  averageR: number | null
  expectancy: number | null
  maxDrawdown: number
  totalPnl: number
}

type DashboardData = {
  from: string
  to: string
  regime: string
  metrics: {
    current: Metric
    currentMinusExhaustion: Metric
    wave3: Metric
    wave4: Metric
    exhaustionFlagged: Metric
  }
  promotions: {
    exhaustionFilter: { eligible: boolean; sampleSize: number; minimum: number }
    wave3: { eligible: boolean; sampleSize: number; minimum: number }
    wave4: { eligible: boolean; sampleSize: number; minimum: number }
  }
  error?: string
}

const fetcher = async (url: string): Promise<DashboardData> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Elliott Wave metrics are unavailable. Apply the shadow migration after review.')
  return response.json()
}

const strategies: Array<{ id: keyof DashboardData['metrics']; title: string; description: string }> = [
  { id: 'current', title: 'Current rule', description: 'Closed paper trades' },
  { id: 'currentMinusExhaustion', title: 'Without flagged', description: 'Current trades minus exhaustion flags' },
  { id: 'wave3', title: 'Elliott Wave 3', description: 'Shadow-only breakout entries' },
  { id: 'wave4', title: 'Elliott Wave 4', description: 'Shadow-only pullback re-entries' },
]

function metric(value: number | null, digits = 2) {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits)
}

function money(value: number) {
  return Number.isFinite(value) ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—'
}

export default function ElliottWaveDashboard() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [regime, setRegime] = useState('all')
  const query = new URLSearchParams({ from, to, regime })
  const { data, error, isLoading } = useSWR<DashboardData>(`/api/elliott/metrics?${query}`, fetcher, { refreshInterval: 30_000, revalidateOnFocus: true })

  const promotions = data?.promotions
  const flagged = data?.metrics.exhaustionFlagged
  return (
    <section className="panel elliott-dashboard" aria-labelledby="elliott-dashboard-title">
      <div className="elliott-dashboard-head">
        <div>
          <div className="elliott-kicker"><Activity aria-hidden="true" /> SHADOW PERFORMANCE</div>
          <h2 id="elliott-dashboard-title">Elliott Wave comparison</h2>
          <p>Separate paper outcomes from simulated shadow signals. Nothing here can place or manage a trade.</p>
        </div>
        <div className="elliott-filters">
          <label>From<input aria-label="From date" type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>To<input aria-label="To date" type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
          <label>Regime<select aria-label="Filter by regime" value={regime} onChange={(event) => setRegime(event.target.value)}>
            <option value="all">All regimes</option>
            <option value="opening-momentum">Opening momentum</option>
            <option value="premarket-continuation">Premarket continuation</option>
            <option value="news-reaction">News reaction</option>
            <option value="midday-selective">Midday selective</option>
            <option value="late-continuation">Late continuation</option>
            <option value="exits-only">Exits only</option>
          </select></label>
        </div>
      </div>

      {error ? <div className="elliott-dashboard-state" role="status">{error.message}</div> : isLoading && !data ? <div className="elliott-dashboard-state" role="status">Loading shadow performance…</div> : null}
      {data && <>
        <div className="elliott-table-scroll">
          <table className="elliott-table">
            <thead><tr><th scope="col">Strategy</th><th scope="col">Signals</th><th scope="col">Win rate</th><th scope="col">Average R</th><th scope="col">Expectancy</th><th scope="col">Max drawdown</th><th scope="col">Total P&amp;L</th></tr></thead>
            <tbody>{strategies.map((strategy) => {
              const values = data.metrics[strategy.id]
              return <tr key={strategy.id}>
                <th scope="row"><strong>{strategy.title}</strong><small>{strategy.description}</small></th>
                <td>{values.signals.toLocaleString()}<small>{values.closedTrades.toLocaleString()} closed</small></td>
                <td>{metric(values.winRate == null ? null : values.winRate * 100, 1)}{values.winRate != null ? '%' : ''}</td>
                <td>{values.averageR == null ? '—' : `${metric(values.averageR)}R`}</td>
                <td>{values.expectancy == null ? '—' : `${metric(values.expectancy)}R`}</td>
                <td>{money(values.maxDrawdown)}</td>
                <td className={values.totalPnl >= 0 ? 'elliott-positive' : 'elliott-negative'}>{money(values.totalPnl)}</td>
              </tr>
            })}</tbody>
          </table>
        </div>
        <div className="elliott-promotion-grid">
          <div className="elliott-promotion-item">
            <span>EXHAUSTION FILTER</span>
            <strong>{flagged?.closedTrades ?? 0} flagged closed trades · {flagged?.averageR == null ? '—' : `${metric(flagged.averageR)}R average`}</strong>
            <small>{promotions?.exhaustionFilter.eligible ? 'Criteria met · awaiting manual approval' : `Requires ${promotions?.exhaustionFilter.minimum ?? 30}+ flagged real trades and average R below 0`}</small>
          </div>
          <div className="elliott-promotion-item">
            <span>WAVE 3 ENTRY</span>
            <strong>{data.metrics.wave3.closedTrades} shadow trades · {data.metrics.wave3.expectancy == null ? '—' : `${metric(data.metrics.wave3.expectancy)}R expectancy`}</strong>
            <small>{promotions?.wave3.eligible ? 'Criteria met · awaiting manual approval' : `Requires ${elliottWaveConfig.promotion.minimumShadowTrades}+ trades, +${elliottWaveConfig.promotion.minimumExpectancyR.toFixed(1)}R expectancy, and a better expectancy than current rule`}</small>
          </div>
          <div className="elliott-promotion-item">
            <span>WAVE 4 RE-ENTRY</span>
            <strong>{data.metrics.wave4.closedTrades} shadow trades · {data.metrics.wave4.expectancy == null ? '—' : `${metric(data.metrics.wave4.expectancy)}R expectancy`}</strong>
            <small>{promotions?.wave4.eligible ? 'Criteria met · awaiting manual approval' : `Judged separately: ${elliottWaveConfig.promotion.minimumShadowTrades}+ trades, +${elliottWaveConfig.promotion.minimumExpectancyR.toFixed(1)}R expectancy, and better than current rule`}</small>
          </div>
        </div>
        <div className="elliott-dashboard-foot">Manual review only · same date range and regime across every column · all shadow outcomes use the paper fill model</div>
      </>}
    </section>
  )
}
