'use client'

import useSWR from 'swr'
import { useEffect, useRef, useState } from 'react'
import { Activity, Search, Sparkles } from 'lucide-react'

type Stock = { symbol: string; price: number; changePercent: number | null; volume: number; bid: number; ask: number }
type ScanData = { candidates?: Stock[]; scannedAt?: string; source?: string; error?: string; persistenceWarning?: string }
type InsightData = { symbol?: string; price?: number; changePercent?: number | null; signal?: string; rationale?: string; headline?: { title: string; source?: string; publishedAt?: string; url?: string } | null; error?: string }
type PnlHistoryData = { points?: number[]; degraded?: boolean }
type AccountData = { account?: { equity?: number; cash_balance?: number; realized_pnl?: number; unrealized_pnl?: number } | null; degraded?: boolean; degradedReason?: string }
type EventData = { events?: Array<{ id: string; level: string; event_type: string; message: string; created_at: string }>; degraded?: boolean; degradedReason?: string }
type PositionData = { positions?: Array<{ id: string; symbol: string; side: string; quantity: number; entry_price: number; current_price?: number; stop_price?: number; target_price?: number; unrealized_pnl?: number }>; degraded?: boolean; degradedReason?: string }
type IndexData = { indices?: Array<{ symbol: string; name: string; price: number; changePercent: number }> }
type LatencyData = { providers?: Array<{ name: string; ok: boolean; ms: number; error?: string }> }

const fetcher = (url: string) => fetch(url).then((response) => {
  if (!response.ok) throw new Error(`Request failed: ${response.status}`)
  return response.json()
})

function formatMoney(value: number | undefined, fallback: string) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : fallback
}

function formatVolume(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function isScanWindow(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const weekday = parts.find((part) => part.type === 'weekday')?.value
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday ?? '') && (hour > 7 || (hour === 7 && minute >= 0)) && (hour < 15 || (hour === 15 && minute < 55))
}

function PnlSparkline({ values }: { values: number[] }) {
  const points = values.length > 1 ? values.slice(-80) : [values[0] ?? 0, values[0] ?? 0]
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = Math.max(max - min, 1)
  const coordinates = points.map((value, index) => {
    const x = points.length === 1 ? 0 : (index / (points.length - 1)) * 200
    const y = 36 - ((value - min) / range) * 30
    return `${x},${y}`
  }).join(' ')
  const direction = (points.at(-1) ?? 0) >= (points[0] ?? 0) ? 'pnl-positive' : 'pnl-negative'

  return <svg className={`sparkline-chart ${direction}`} viewBox="0 0 200 40" preserveAspectRatio="none" role="img" aria-label={`Recent paper account P&L trend, ${formatMoney(points.at(-1), '$0.00')}`}><line x1="0" y1="38" x2="200" y2="38" className="sparkline-baseline" /><polyline points={coordinates} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>
}

function TradingViewWidget({ symbol }: { symbol: string }) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = container.current
    if (!element) return

    const widget = document.createElement('div')
    widget.className = 'tradingview-widget-container__widget'
    widget.style.height = 'calc(100%)'
    widget.style.width = '100%'

    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
    script.type = 'text/javascript'
    script.async = true
    script.innerHTML = JSON.stringify({
      allow_symbol_change: false,
      calendar: false,
      details: false,
      hide_side_toolbar: true,
      hide_top_toolbar: false,
      hide_legend: false,
      hide_volume: true,
      hotlist: false,
      interval: '5',
      locale: 'en',
      save_image: true,
      style: '1',
      symbol,
      theme: 'dark',
      timezone: 'America/New_York',
      backgroundColor: '#0F0F0F',
      gridColor: 'rgba(242, 242, 242, 0.2)',
      watchlist: [],
      withdateranges: false,
      compareSymbols: [],
      support_host: 'https://www.tradingview.com',
      studies: ['STD;VWAP', 'STD;EMA'],
      autosize: true,
    })

    element.replaceChildren(widget)
    widget.appendChild(script)
    return () => element.replaceChildren()
  }, [symbol])

  return <div className="tradingview-widget-container" ref={container} style={{ height: '100%', width: '100%' }} />
}

function Chart({ symbol }: { symbol: string }) {
  return <div className="chart-shell tradingview-widget-container" aria-label={`${symbol} TradingView advanced chart`}><TradingViewWidget symbol={symbol} /></div>
}

export default function Home() {
  const [selectedSymbol, setSelectedSymbol] = useState('AMZN')
  const [now, setNow] = useState<Date | null>(null)
  const [filter, setFilter] = useState('')
  const { data: scanData, error: scanError } = useSWR<ScanData>('/api/scan?top=25', fetcher, { refreshInterval: () => isScanWindow(new Date()) ? 30000 : 0, revalidateOnFocus: true })
  const { data: insightData, isLoading: insightLoading } = useSWR<InsightData>(selectedSymbol ? `/api/insight?symbol=${encodeURIComponent(selectedSymbol)}` : null, fetcher, { refreshInterval: () => isScanWindow(new Date()) ? 300000 : 0, revalidateOnFocus: true })
  const { data: pnlHistory } = useSWR<PnlHistoryData>('/api/pnl-history', fetcher, { refreshInterval: 30000, revalidateOnFocus: true })
  const { data: indexData } = useSWR<IndexData>('/api/indices', fetcher, { refreshInterval: 15000, revalidateOnFocus: true })
  const { data: latencyData } = useSWR<LatencyData>('/api/latency', fetcher, { refreshInterval: 15000, revalidateOnFocus: true })
  const { data: accountData } = useSWR<AccountData>('/api/account', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const { data: eventData } = useSWR<EventData>('/api/events?limit=8', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const { data: positionData } = useSWR<PositionData>('/api/positions', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const liveAccount = accountData?.account
  const livePositions = positionData?.positions ?? []
  const liveEvents = eventData?.events ?? []
  const clockNow = now ?? new Date()
  const scanWindowOpen = isScanWindow(clockNow)
  const stocks = scanWindowOpen ? scanData?.candidates ?? [] : []
  const selected = stocks.find((stock) => stock.symbol === selectedSymbol) ?? null
  const accountPnl = (liveAccount?.realized_pnl ?? 0) + (liveAccount?.unrealized_pnl ?? 0)
  const pnlPoints = [...(pnlHistory?.points?.length ? pnlHistory.points : [0]), accountPnl]
  const displayedEvents = liveEvents.map((event) => [new Date(event.created_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }), event.event_type, event.message, event.level.toLowerCase()] as const)

  useEffect(() => {
    const updateClock = () => setNow(new Date())
    updateClock()
    const timer = window.setInterval(updateClock, 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (now && !isScanWindow(now) && selectedSymbol !== 'AMZN') setSelectedSymbol('AMZN')
  }, [now, selectedSymbol])
  const displayNow = now ?? new Date(0)
  const etTime = now ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(now) : '—'
  const etDate = now ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(now) : '—'
  const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(displayNow)
  const etHour = Number(etParts.find((part) => part.type === 'hour')?.value ?? 0)
  const etMinute = Number(etParts.find((part) => part.type === 'minute')?.value ?? 0)
  const etWeekday = now ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now) : ''
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(etWeekday)
  const isMarketOpen = Boolean(now && isWeekday && (etHour > 9 || (etHour === 9 && etMinute >= 30)) && etHour < 16)
  const isFlattening = Boolean(now && isWeekday && (etHour > 15 || (etHour === 15 && etMinute >= 55)))
  const filteredStocks = stocks.filter((stock) => stock.symbol.toLowerCase().includes(filter.toLowerCase()))
  const secondsUntilNextScan = scanData?.scannedAt && now && scanWindowOpen
    ? Math.min(30, Math.max(0, Math.ceil(30 - (now.getTime() - new Date(scanData.scannedAt).getTime()) / 1000)))
    : null
  const nextScanLabel = isFlattening ? 'FLATTEN' : scanWindowOpen && secondsUntilNextScan != null ? `NEXT SCAN ${secondsUntilNextScan}s` : 'SLEEPING'
  return (
    <main className="terminal">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Activity /></div><div><strong>AI<span> trading</span></strong><small>FIND.TRADE.WIN.</small></div></div>
        <div className="top-status"><span className="live-pill"><i /> PAPER ONLY · NO ORDERS SUBMITTED</span><span className={`session-pill ${isMarketOpen ? 'market-open' : 'market-closed'}`}><span className="pulse" /> MARKET {isMarketOpen ? 'OPEN' : 'CLOSED'}</span><span className="clock">{etDate} · {etTime} ET</span></div>
        <div className="top-actions"><div className="avatar" aria-label="AI trading terminal">AIt</div></div>
      </header>
      <div className="workspace">
        <aside className="left-rail">
          <section className="panel balance-panel"><div className="section-kicker"><span>ACCOUNT EQUITY</span><div className="balance">{formatMoney(liveAccount?.equity, 'Unavailable')}</div></div><div className="sparkline" aria-label="Paper account P&L trend"><PnlSparkline values={pnlPoints} /><div className="balance-meta"><span className={liveAccount ? 'positive' : 'negative'}>{liveAccount ? formatMoney((liveAccount.realized_pnl ?? 0) + (liveAccount.unrealized_pnl ?? 0), '$0.00') : accountData?.degradedReason?.includes('URL') ? 'Supabase URL missing' : accountData?.degradedReason ?? 'Ledger unavailable'}</span><span>paper account</span></div></div><div className="metric-row"><span>Cash balance</span><strong>{formatMoney(liveAccount?.cash_balance, 'Unavailable')}</strong></div><div className="metric-row"><span>Realized P&amp;L</span><strong className={liveAccount ? 'positive' : ''}>{formatMoney(liveAccount?.realized_pnl, 'Unavailable')}</strong></div></section>
          <section className="panel"><div className="panel-title"><span>OPEN POSITION</span><span className="count-badge">{positionData?.degraded ? '—' : positionData?.positions?.length ?? 0}</span></div>{livePositions.length ? <div className="positions-scroll">{livePositions.map((position) => <div className="position-card" key={position.id}><div className="position-head"><div><strong>{position.symbol}</strong><small>{position.side.toUpperCase()} · {Number(position.quantity).toLocaleString()} SHARES</small></div><span className={Number(position.unrealized_pnl ?? 0) >= 0 ? 'positive' : 'negative'}>{formatMoney(position.unrealized_pnl, '—')}</span></div><div className="position-stats"><div><span>Entry</span><b>${Number(position.entry_price).toFixed(2)}</b></div><div><span>Mark</span><b>${Number(position.current_price ?? position.entry_price).toFixed(2)}</b></div><div><span>Stop risk</span><b>{position.stop_price != null && Number(position.entry_price) > 0 ? `${(Math.abs((Number(position.entry_price) - Number(position.stop_price)) / Number(position.entry_price) * 100)).toFixed(1)}%` : '—'}</b></div></div><div className="risk-label"><span>Stop {position.stop_price != null ? `$${Number(position.stop_price).toFixed(2)}` : '—'}</span><span>Target {position.target_price != null ? `$${Number(position.target_price).toFixed(2)}` : '—'}</span></div></div>)}</div> : <div className="empty-position">{positionData?.degraded ? positionData.degradedReason ?? 'Positions unavailable' : positionData ? 'No open paper positions' : 'Loading positions…'}</div>}</section>
          <section className="panel indices-panel"><div className="panel-title"><span>U.S. MARKET INDICES</span><span className="live-label">LIVE</span></div><div className="indices-list">{(indexData?.indices ?? []).map((index) => <div className="index-row" key={index.symbol}><span>{index.name}</span><strong>{index.price ? index.price.toFixed(2) : '—'}</strong><em className={index.changePercent >= 0 ? 'positive' : 'negative'}>{index.changePercent >= 0 ? '+' : ''}{index.changePercent.toFixed(2)}%</em></div>)}</div></section>
          <div className="terminal-foot"><strong>APP HEALTH:</strong><span className="health-values">{(['Alpaca', 'FMP', 'Supabase'] as const).map((name) => { const provider = latencyData?.providers?.find((item) => item.name === name); const abbreviation = name === 'Alpaca' ? 'A' : name === 'FMP' ? 'F' : 'S'; return <strong key={name} className={provider?.ok ? 'health-good' : provider ? 'health-bad' : ''} title={provider?.error ?? `${name} latency`}>{abbreviation}:{provider ? provider.ok ? `${provider.ms}ms` : 'OFF' : '…'}</strong> })}</span></div>
        </aside>
        <section className="center-workspace">
          <div className="full-chart"><Chart symbol={selectedSymbol} /></div>
          <div className="signal-strip"><div className="signal-main"><Sparkles /><div><span>AI SIGNAL · {insightData?.symbol ?? selectedSymbol}</span><strong>{insightLoading ? 'Analyzing selected symbol…' : insightData?.signal ?? 'AI analysis unavailable'}</strong><small>{insightData?.rationale ?? insightData?.error ?? 'Analysis only · no paper orders are submitted.'}</small></div></div><div className="signal-stat signal-context"><span>HEADLINE · {insightData?.symbol ?? selectedSymbol}</span>{insightData?.headline?.url ? <a href={insightData.headline.url} target="_blank" rel="noreferrer" title={insightData.headline.title}>{insightData.headline.title}</a> : <strong>{insightLoading ? 'Checking current headlines…' : insightData?.headline?.title ?? 'No recent headline for this symbol.'}</strong>}</div><div className="signal-stat"><span>Selected mover</span><strong>{selectedSymbol}</strong></div><div className="signal-stat"><span>Price change</span><strong className={(insightData?.changePercent ?? selected?.changePercent ?? 0) >= 0 ? 'positive' : 'negative'}>{(insightData?.changePercent ?? selected?.changePercent) == null ? '—' : `${(insightData?.changePercent ?? selected?.changePercent ?? 0) >= 0 ? '+' : ''}${(insightData?.changePercent ?? selected?.changePercent ?? 0).toFixed(2)}%`}</strong></div></div>
        </section>
        <aside className="right-rail">
          <section className="panel watchlist-panel"><div className="panel-title scanner-title"><span>SCANNED STOCKS ({stocks.length})</span><span className="scan-status"><i />{isFlattening ? 'FLATTEN' : scanError && scanWindowOpen ? 'FEED OFF · NEXT SCAN —' : nextScanLabel}</span></div><div className="search-box"><Search /><input placeholder="Filter symbols…" aria-label="Filter symbols" value={filter} onChange={(event) => setFilter(event.target.value)} /></div><div className="watchlist">{filteredStocks.length ? filteredStocks.map((stock) => <button key={stock.symbol} onClick={() => setSelectedSymbol(stock.symbol)} className={`stock-row ${selected?.symbol === stock.symbol ? 'selected' : ''}`}><div className="stock-left"><span className={`stock-mover-change ${stock.changePercent != null && stock.changePercent >= 0 ? 'positive' : 'negative'}`}>{stock.changePercent == null ? '—' : `${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent.toFixed(1)}%`}</span><div><strong>{stock.symbol}</strong><small>Volume {formatVolume(stock.volume)}</small></div></div><div className="stock-price"><strong>${stock.price.toFixed(2)}</strong></div></button>) : <div className="empty-position">{!scanWindowOpen ? 'Scanner sleeps until 7:00 AM ET.' : scanError ? 'Alpaca market mover feed is unavailable.' : scanData ? 'No market movers returned.' : 'Loading live market movers…'}</div>}</div></section>
          <section className="panel events-panel"><div className="panel-title"><span>LIVE EVENT LOG</span></div><div className="events">{displayedEvents.length ? displayedEvents.map(([time, type, message, tone], index) => <div className="event" key={`${time}-${type}-${index}`}><span className="event-time">{time}</span><span className={`event-type ${type.toLowerCase().replace(/\s+/g, '-')}-${tone}`}>{type}</span><p>{message}</p></div>) : <div className="empty-position">{eventData?.degraded ? eventData.degradedReason ?? 'Event history unavailable' : eventData ? 'No events have been recorded.' : 'Loading event history…'}</div>}</div></section>
        </aside>
      </div>
    </main>
  )
}
