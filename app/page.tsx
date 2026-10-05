'use client'

import useSWR from 'swr'
import { useEffect, useRef, useState } from 'react'
import { Activity, Bell, Search, Settings2, ShieldCheck, Sparkles, TrendingUp } from 'lucide-react'

type Stock = { symbol: string; name: string; price: string; change: string; score: number; volume: string; catalyst: string; tone: 'green' | 'amber' | 'red' }
type AccountData = { account?: { equity?: number; cash_balance?: number; realized_pnl?: number; unrealized_pnl?: number } | null }
type EventData = { events?: Array<{ id: string; level: string; event_type: string; message: string; created_at: string }> }
type PositionData = { positions?: Array<{ id: string; symbol: string; side: string; quantity: number; entry_price: number; current_price?: number; stop_price?: number; target_price?: number; unrealized_pnl?: number }> }
type IndexData = { indices?: Array<{ symbol: string; name: string; price: number; changePercent: number }> }
type LatencyData = { providers?: Array<{ name: string; ok: boolean; ms: number }> }

const fetcher = (url: string) => fetch(url).then((response) => {
  if (!response.ok) throw new Error(`Request failed: ${response.status}`)
  return response.json()
})

function formatMoney(value: number | undefined, fallback: string) {
  return typeof value === 'number' ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : fallback
}

const stocks: Stock[] = [
  { symbol: 'MIRA', name: 'Mirasol Resources', price: '4.82', change: '+18.24%', score: 94, volume: '3.8M', catalyst: 'News + RVOL', tone: 'green' },
  { symbol: 'CETX', name: 'Cemtrex Inc.', price: '2.17', change: '+11.28%', score: 88, volume: '1.2M', catalyst: 'Social + VWAP', tone: 'green' },
  { symbol: 'KAVL', name: 'Kaival Brands', price: '1.06', change: '+8.16%', score: 79, volume: '890K', catalyst: 'Volume spike', tone: 'amber' },
  { symbol: 'SINT', name: 'SiNtx Technologies', price: '0.74', change: '+6.03%', score: 71, volume: '540K', catalyst: 'FVG reclaim', tone: 'amber' },
  { symbol: 'HUBC', name: 'Hub Cyber Security', price: '0.42', change: '-2.41%', score: 38, volume: '312K', catalyst: 'Below VWAP', tone: 'red' },
]

const events = [
  ['09:42:18', 'SCAN', 'MIRA passed momentum gate', 'green'],
  ['09:41:52', 'DATA', 'RVOL 4.2x · Float 8.4M', 'blue'],
  ['09:40:07', 'AI', 'Gemini: high-conviction setup', 'purple'],
  ['09:39:44', 'ORDER', 'BUY 180 MIRA @ $4.71 filled', 'green'],
  ['09:35:01', 'RISK', 'Position risk 1.2% · within limit', 'amber'],
  ['09:30:00', 'SESSION', 'Market open · scanner active', 'blue'],
  ['09:00:00', 'SCAN', 'Pre-market scan complete · 23 found', 'blue'],
  ['07:00:00', 'SYSTEM', 'AItrading App is awake, let’s make this GREEN DAY', 'purple'],
]

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
      symbol: `NASDAQ:${symbol}`,
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
  const [selected, setSelected] = useState(stocks[0])
  const [now, setNow] = useState<Date | null>(null)
  const [filter, setFilter] = useState('')
  const { data: indexData } = useSWR<IndexData>('/api/indices', fetcher, { refreshInterval: 1000, revalidateOnFocus: true })
  const { data: latencyData } = useSWR<LatencyData>('/api/latency', fetcher, { refreshInterval: 1000, revalidateOnFocus: true })
  const { data: accountData } = useSWR<AccountData>('/api/account', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const { data: eventData } = useSWR<EventData>('/api/events?limit=8', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const { data: positionData } = useSWR<PositionData>('/api/positions', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const liveAccount = accountData?.account
  const livePositions = positionData?.positions ?? []
  const liveEvents = eventData?.events
  const displayedEvents = liveEvents?.length ? liveEvents.map((event) => [new Date(event.created_at).toLocaleTimeString('en-US', { hour12: false }), event.event_type, event.message, event.level.toLowerCase()] as const) : events

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const displayNow = now ?? new Date(0)
  const etTime = now ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(now) : '—'
  const etDate = now ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(now) : '—'
  const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(displayNow)
  const etHour = Number(etParts.find((part) => part.type === 'hour')?.value ?? 0)
  const isMarketOpen = Boolean(now && now.getDay() > 0 && now.getDay() < 6 && etHour >= 9 && (etHour < 16 || (etHour === 16 && now?.getMinutes() === 0)))
  const filteredStocks = stocks.filter((stock) => `${stock.symbol} ${stock.name}`.toLowerCase().includes(filter.toLowerCase()))
  const scannerActive = Boolean(now && isMarketOpen && now.getSeconds() < 15)
  const nextScanMinutes = 28 - ((now?.getMinutes() ?? 0) % 29)
  return (
    <main className="terminal">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Activity /></div><div><strong>AI<span> trading</span></strong><small>FIND.TRADE.WIN.</small></div></div>
        <div className="top-status"><span className="live-pill"><i /> PAPER MODE</span><span className={`session-pill ${isMarketOpen ? 'market-open' : 'market-closed'}`}><span className="pulse" /> MARKET {isMarketOpen ? 'OPEN' : 'CLOSED'}</span><span className="clock">{etDate} · {etTime} ET</span></div>
        <div className="top-actions"><button className="icon-button" aria-label="Notifications"><Bell /></button><button className="icon-button" aria-label="Settings"><Settings2 /></button><div className="avatar">TR</div></div>
      </header>
      <div className="workspace">
        <aside className="left-rail">
          <section className="panel balance-panel"><div className="section-kicker"><span>ACCOUNT EQUITY</span><ShieldCheck /></div><div className="balance">{formatMoney(liveAccount?.equity, '$2,000.00')}</div><div className="balance-meta"><span className="positive">{formatMoney((liveAccount?.realized_pnl ?? 0) + (liveAccount?.unrealized_pnl ?? 0), '+$0.00')}</span><span>paper account</span></div><div className="sparkline"><svg viewBox="0 0 220 42" preserveAspectRatio="none"><path d="M0 35 L20 32 L40 34 L60 25 L80 29 L100 20 L120 24 L140 15 L160 18 L180 8 L220 4" fill="none" stroke="#2dd4bf" strokeWidth="2"/></svg></div><div className="metric-row"><span>Cash balance</span><strong>{formatMoney(liveAccount?.cash_balance, '$2,000.00')}</strong></div><div className="metric-row"><span>Realized P&amp;L</span><strong className="positive">{formatMoney(liveAccount?.realized_pnl, '+$0.00')}</strong></div></section>
          <section className="panel"><div className="panel-title"><span>OPEN POSITION</span><span className="count-badge">{positionData?.positions?.length ?? 0}</span></div>{livePositions.length ? <div className="positions-scroll">{livePositions.map((position) => <div className="position-card" key={position.id}><div className="position-head"><div><strong>{position.symbol}</strong><small>{position.side.toUpperCase()} · {Number(position.quantity).toLocaleString()} SHARES</small></div><span className={Number(position.unrealized_pnl ?? 0) >= 0 ? 'positive' : 'negative'}>{formatMoney(position.unrealized_pnl, '$0.00')}</span></div><div className="position-stats"><div><span>Entry</span><b>${Number(position.entry_price).toFixed(2)}</b></div><div><span>Mark</span><b>${Number(position.current_price ?? position.entry_price).toFixed(2)}</b></div><div><span>Risk</span><b>guarded</b></div></div><div className="risk-bar"><span /></div><div className="risk-label"><span>Stop ${Number(position.stop_price ?? 0).toFixed(2)}</span><span>Target ${Number(position.target_price ?? 0).toFixed(2)}</span></div></div>)}</div> : <div className="empty-position">No open paper positions</div>}</section>
          <section className="panel indices-panel"><div className="panel-title"><span>U.S. MARKET INDICES</span><span className="live-label">LIVE</span></div><div className="indices-list">{(indexData?.indices ?? []).map((index) => <div className="index-row" key={index.symbol}><span>{index.name}</span><strong>{index.price ? index.price.toFixed(2) : '—'}</strong><em className={index.changePercent >= 0 ? 'positive' : 'negative'}>{index.changePercent >= 0 ? '+' : ''}{index.changePercent.toFixed(2)}%</em></div>)}</div></section>
          <div className="terminal-foot"><span>App Health:</span><span className="health-values">{(latencyData?.providers ?? []).map((provider) => <strong key={provider.name} className={provider.ok ? 'health-good' : 'health-bad'}>{provider.name[0]}:{provider.ok ? `${provider.ms}ms` : 'ERR'}</strong>)}</span></div>
        </aside>
        <section className="center-workspace">
          <div className="full-chart"><Chart symbol={selected.symbol} /></div>
          <div className="signal-strip"><div className="signal-main"><Sparkles /><div><span>AI SIGNAL · HIGH CONVICTION</span><strong>Momentum continuation setup</strong></div></div><div className="signal-stat signal-context"><span>HEADLINES</span><strong>{selected.catalyst} · {selected.volume} volume · technical momentum confirmed</strong></div><div className="signal-stat"><span>Score</span><strong className="positive">{selected.score} / 100</strong></div><div className="signal-stat"><span>RVOL</span><strong>4.2x</strong></div><div className="signal-stat"><span>Float</span><strong>8.4M</strong></div><div className="signal-stat"><span>VWAP</span><strong className="positive">Above</strong></div></div>
        </section>
        <aside className="right-rail">
          <section className="panel watchlist-panel"><div className="panel-title scanner-title"><span>SCANNED STOCKS({filteredStocks.length})</span><span className="scan-status"><i /> {scannerActive ? 'SCANNING' : `${nextScanMinutes}min NEXT SCAN`}</span></div><div className="search-box"><Search /><input placeholder="Filter Symbols..." aria-label="Filter symbols" value={filter} onChange={(event) => setFilter(event.target.value)} /></div><div className="watchlist">{filteredStocks.map((stock) => <button key={stock.symbol} onClick={() => setSelected(stock)} className={`stock-row ${selected.symbol === stock.symbol ? 'selected' : ''}`}><div className="stock-left"><span className={`score ${stock.tone}`}>{stock.score}</span><div><strong>{stock.symbol}</strong><small>{stock.catalyst} · {stock.volume}</small></div></div><div className="stock-price"><strong>${stock.price}</strong><span className={stock.tone === 'red' ? 'negative' : 'positive'}>{stock.change}</span></div></button>)}</div></section>
          <section className="panel events-panel"><div className="panel-title"><span>LIVE EVENT LOG</span></div><div className="event-filters"><button className="active">ALL</button><button>TRADES</button><button>SYSTEM</button><button>AI</button></div><div className="events">{displayedEvents.map(([time, type, message, tone], index) => <div className="event" key={`${time}-${type}-${index}`}><span className="event-time">{time}</span><span className={`event-type ${type.toLowerCase().replace(/\s+/g, '-')}-${message.toLowerCase().includes('buy') ? 'buy' : message.toLowerCase().includes('sell') ? (message.toLowerCase().includes('loss') ? 'loss' : 'win') : tone}`}>{type}</span><p>{message}</p></div>)}</div><div className="sleep-line"><i /> Scheduled sleep at <strong>16:00 ET</strong></div></section>
        </aside>
      </div>
    </main>
  )
}
