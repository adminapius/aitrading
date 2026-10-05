'use client'

import useSWR from 'swr'
import { useEffect, useRef, useState } from 'react'
import { Activity, Search, ShieldCheck, Sparkles } from 'lucide-react'

type Stock = { symbol: string; price: number; changePercent: number | null; volume: number; bid: number; ask: number }
type ScanData = { candidates?: Stock[]; scannedAt?: string; source?: string; error?: string }
type AccountData = { account?: { equity?: number; cash_balance?: number; realized_pnl?: number; unrealized_pnl?: number } | null; degraded?: boolean }
type EventData = { events?: Array<{ id: string; level: string; event_type: string; message: string; created_at: string }>; degraded?: boolean }
type PositionData = { positions?: Array<{ id: string; symbol: string; side: string; quantity: number; entry_price: number; current_price?: number; stop_price?: number; target_price?: number; unrealized_pnl?: number }>; degraded?: boolean }
type IndexData = { indices?: Array<{ symbol: string; name: string; price: number; changePercent: number }> }
type ReadinessData = { supabase?: { connected: boolean }; alpaca?: { connected: boolean }; railway?: { reachable: boolean } }

const fetcher = (url: string) => fetch(url).then((response) => {
  if (!response.ok) throw new Error(`Request failed: ${response.status}`)
  return response.json()
})

const readinessFetcher = async (url: string): Promise<ReadinessData> => {
  const response = await fetch(url)
  return response.json()
}

function formatMoney(value: number | undefined, fallback: string) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : fallback
}

function formatVolume(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function TradingViewWidget({ symbol }: { symbol: string }) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = container.current
    if (!element) return

    const widget = document.createElement('div')
    widget.className = 'tradingview-widget-container__widget'
    widget.style.height = 'calc(100% - 32px)'
    widget.style.width = '100%'

    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
    script.type = 'text/javascript'
    script.async = true
    script.innerHTML = JSON.stringify({
      allow_symbol_change: true,
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
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const [now, setNow] = useState<Date | null>(null)
  const [filter, setFilter] = useState('')
  const { data: scanData, error: scanError } = useSWR<ScanData>('/api/scan?top=25', fetcher, { refreshInterval: 30000, revalidateOnFocus: true })
  const { data: indexData } = useSWR<IndexData>('/api/indices', fetcher, { refreshInterval: 15000, revalidateOnFocus: true })
  const { data: readinessData } = useSWR<ReadinessData>('/api/health', readinessFetcher, { refreshInterval: 15000, revalidateOnFocus: true })
  const { data: accountData } = useSWR<AccountData>('/api/account', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const { data: eventData } = useSWR<EventData>('/api/events?limit=8', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const { data: positionData } = useSWR<PositionData>('/api/positions', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const liveAccount = accountData?.account
  const livePositions = positionData?.positions ?? []
  const liveEvents = eventData?.events ?? []
  const stocks = scanData?.candidates ?? []
  const selected = stocks.find((stock) => stock.symbol === selectedSymbol) ?? stocks[0] ?? null
  const displayedEvents = liveEvents.map((event) => [new Date(event.created_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }), event.event_type, event.message, event.level.toLowerCase()] as const)

  useEffect(() => {
    const updateClock = () => setNow(new Date())
    updateClock()
    const timer = window.setInterval(updateClock, 1000)
    return () => window.clearInterval(timer)
  }, [])
  const displayNow = now ?? new Date(0)
  const etTime = now ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(now) : '—'
  const etDate = now ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(now) : '—'
  const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(displayNow)
  const etHour = Number(etParts.find((part) => part.type === 'hour')?.value ?? 0)
  const etMinute = Number(etParts.find((part) => part.type === 'minute')?.value ?? 0)
  const etWeekday = now ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now) : ''
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(etWeekday)
  const isMarketOpen = Boolean(now && isWeekday && (etHour > 9 || (etHour === 9 && etMinute >= 30)) && etHour < 16)
  const filteredStocks = stocks.filter((stock) => stock.symbol.toLowerCase().includes(filter.toLowerCase()))
  const scanUpdatedAt = scanData?.scannedAt ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(scanData.scannedAt)) : null
  return (
    <main className="terminal">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Activity /></div><div><strong>AI<span> trading</span></strong><small>FIND.TRADE.WIN.</small></div></div>
        <div className="top-status"><span className="live-pill"><i /> PAPER ONLY · NO ORDERS SUBMITTED</span><span className={`session-pill ${isMarketOpen ? 'market-open' : 'market-closed'}`}><span className="pulse" /> MARKET {isMarketOpen ? 'OPEN' : 'CLOSED'}</span><span className="clock">{etDate} · {etTime} ET</span></div>
        <div className="top-actions"><div className="avatar" aria-label="AI trading terminal">AIt</div></div>
      </header>
      <div className="workspace">
        <aside className="left-rail">
          <section className="panel balance-panel"><div className="section-kicker"><span>ACCOUNT EQUITY</span><ShieldCheck /></div><div className="balance">{formatMoney(liveAccount?.equity, 'Unavailable')}</div><div className="balance-meta"><span className={liveAccount ? 'positive' : 'negative'}>{liveAccount ? formatMoney((liveAccount.realized_pnl ?? 0) + (liveAccount.unrealized_pnl ?? 0), '$0.00') : 'Ledger unavailable'}</span><span>paper account</span></div><div className="metric-row"><span>Cash balance</span><strong>{formatMoney(liveAccount?.cash_balance, 'Unavailable')}</strong></div><div className="metric-row"><span>Realized P&amp;L</span><strong className={liveAccount ? 'positive' : ''}>{formatMoney(liveAccount?.realized_pnl, 'Unavailable')}</strong></div></section>
          <section className="panel"><div className="panel-title"><span>OPEN POSITION</span><span className="count-badge">{positionData?.positions?.length ?? 0}</span></div>{livePositions.length ? <div className="positions-scroll">{livePositions.map((position) => <div className="position-card" key={position.id}><div className="position-head"><div><strong>{position.symbol}</strong><small>{position.side.toUpperCase()} · {Number(position.quantity).toLocaleString()} SHARES</small></div><span className={Number(position.unrealized_pnl ?? 0) >= 0 ? 'positive' : 'negative'}>{formatMoney(position.unrealized_pnl, '—')}</span></div><div className="position-stats"><div><span>Entry</span><b>${Number(position.entry_price).toFixed(2)}</b></div><div><span>Mark</span><b>${Number(position.current_price ?? position.entry_price).toFixed(2)}</b></div><div><span>Stop risk</span><b>{position.stop_price != null && Number(position.entry_price) > 0 ? `${(Math.abs((Number(position.entry_price) - Number(position.stop_price)) / Number(position.entry_price) * 100)).toFixed(1)}%` : '—'}</b></div></div><div className="risk-label"><span>Stop {position.stop_price != null ? `$${Number(position.stop_price).toFixed(2)}` : '—'}</span><span>Target {position.target_price != null ? `$${Number(position.target_price).toFixed(2)}` : '—'}</span></div></div>)}</div> : <div className="empty-position">{positionData?.degraded ? 'Supabase unavailable — positions unverified' : positionData ? 'No open paper positions' : 'Loading positions…'}</div>}</section>
          <section className="panel indices-panel"><div className="panel-title"><span>U.S. MARKET PROXIES</span><span className="live-label">LIVE</span></div><div className="indices-list">{(indexData?.indices ?? []).map((index) => <div className="index-row" key={index.symbol}><span>{index.name}</span><strong>{index.price ? index.price.toFixed(2) : '—'}</strong><em className={index.changePercent >= 0 ? 'positive' : 'negative'}>{index.changePercent >= 0 ? '+' : ''}{index.changePercent.toFixed(2)}%</em></div>)}</div></section>
          <div className="terminal-foot"><span>HEALTH</span><span className="health-values"><strong className={readinessData?.alpaca?.connected ? 'health-good' : 'health-bad'}>A:{readinessData?.alpaca?.connected ? 'OK' : readinessData ? 'OFF' : '…'}</strong><strong className={readinessData?.supabase?.connected ? 'health-good' : 'health-bad'}>DB:{readinessData?.supabase?.connected ? 'OK' : readinessData ? 'OFF' : '…'}</strong><strong className={readinessData?.railway?.reachable ? 'health-good' : 'health-bad'}>W:{readinessData?.railway?.reachable ? 'OK' : readinessData ? 'OFF' : '…'}</strong></span></div>
        </aside>
        <section className="center-workspace">
          <div className="full-chart">{selected ? <Chart symbol={selected.symbol} /> : <div className="empty-chart">{scanError ? 'Live chart unavailable until market data reconnects.' : 'Waiting for live market data…'}</div>}</div>
          <div className="signal-strip"><div className="signal-main"><Sparkles /><div><span>AI SIGNAL · NOT CONNECTED</span><strong>No verified AI analysis is available</strong></div></div><div className="signal-stat signal-context"><span>ENGINE STATUS</span><strong>The worker evaluates rule-based paper entries; this dashboard does not receive or store its proposals.</strong></div><div className="signal-stat"><span>Selected mover</span><strong>{selected?.symbol ?? '—'}</strong></div><div className="signal-stat"><span>Price change</span><strong className={selected?.changePercent != null && selected.changePercent >= 0 ? 'positive' : 'negative'}>{selected?.changePercent == null ? '—' : `${selected.changePercent >= 0 ? '+' : ''}${selected.changePercent.toFixed(2)}%`}</strong></div></div>
        </section>
        <aside className="right-rail">
          <section className="panel watchlist-panel"><div className="panel-title scanner-title"><span>LIVE MARKET MOVERS ({filteredStocks.length})</span><span className="scan-status"><i />{scanUpdatedAt ? `UPDATED ${scanUpdatedAt} ET` : scanError ? 'FEED UNAVAILABLE' : 'LOADING FEED'}</span></div><div className="search-box"><Search /><input placeholder="Filter symbols…" aria-label="Filter symbols" value={filter} onChange={(event) => setFilter(event.target.value)} /></div><div className="watchlist">{filteredStocks.length ? filteredStocks.map((stock) => <button key={stock.symbol} onClick={() => setSelectedSymbol(stock.symbol)} className={`stock-row ${selected?.symbol === stock.symbol ? 'selected' : ''}`}><div className="stock-left"><span className={`stock-mover-change ${stock.changePercent != null && stock.changePercent >= 0 ? 'positive' : 'negative'}`}>{stock.changePercent == null ? '—' : `${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent.toFixed(1)}%`}</span><div><strong>{stock.symbol}</strong><small>Volume {formatVolume(stock.volume)}</small></div></div><div className="stock-price"><strong>${stock.price.toFixed(2)}</strong><span className={stock.changePercent != null && stock.changePercent >= 0 ? 'positive' : 'negative'}>{stock.changePercent == null ? 'Change —' : `${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent.toFixed(2)}%`}</span></div></button>) : <div className="empty-position">{scanError ? 'Alpaca market mover feed is unavailable.' : scanData ? 'No market movers returned.' : 'Loading live market movers…'}</div>}</div></section>
          <section className="panel events-panel"><div className="panel-title"><span>RECORDED EVENT LOG</span></div><div className="events">{displayedEvents.length ? displayedEvents.map(([time, type, message, tone], index) => <div className="event" key={`${time}-${type}-${index}`}><span className="event-time">{time}</span><span className={`event-type ${type.toLowerCase().replace(/\s+/g, '-')}-${tone}`}>{type}</span><p>{message}</p></div>) : <div className="empty-position">{eventData?.degraded ? 'Supabase unavailable — event history cannot be verified.' : eventData ? 'No events have been recorded.' : 'Loading event history…'}</div>}</div><div className="sleep-line"><i /> Paper order submission is <strong>disabled</strong></div></section>
        </aside>
      </div>
    </main>
  )
}
