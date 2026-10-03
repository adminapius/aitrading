'use client'

import useSWR from 'swr'
import { useMemo, useState } from 'react'
import { Activity, Bell, ChevronDown, CircleHelp, Crosshair, Minus, Moon, Pause, Play, Power, Radio, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, TrendingDown, TrendingUp, Wifi } from 'lucide-react'

type Stock = { symbol: string; name: string; price: string; change: string; score: number; volume: string; catalyst: string; tone: 'green' | 'amber' | 'red' }
type AccountData = { account?: { equity?: number; cash_balance?: number; realized_pnl?: number; unrealized_pnl?: number } | null }
type EventData = { events?: Array<{ id: string; level: string; event_type: string; message: string; created_at: string }> }

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

function Chart({ symbol }: { symbol: string }) {
  const candles = useMemo(() => [38, 45, 43, 51, 48, 58, 54, 62, 59, 68, 66, 74, 70, 78, 76, 83, 80, 88, 84, 91, 87, 96, 92, 100], [])
  return (
    <div className="chart-shell">
      <div className="chart-y-labels"><span>5.00</span><span>4.80</span><span>4.60</span><span>4.40</span><span>4.20</span></div>
      <svg viewBox="0 0 820 330" preserveAspectRatio="none" className="chart-svg" role="img" aria-label={`${symbol} intraday candlestick chart`}>
        <defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2dd4bf" stopOpacity=".18"/><stop offset="1" stopColor="#2dd4bf" stopOpacity="0"/></linearGradient></defs>
        {[50, 115, 180, 245, 310].map((y) => <line key={y} x1="0" x2="820" y1={y} y2={y} className="chart-grid" />)}
        {[100, 220, 340, 460, 580, 700].map((x) => <line key={x} x1={x} x2={x} y1="0" y2="330" className="chart-grid" />)}
        <path d="M0 280 L40 270 L80 276 L120 245 L160 253 L200 220 L240 230 L280 190 L320 202 L360 168 L400 175 L440 142 L480 150 L520 112 L560 130 L600 88 L640 100 L680 72 L720 80 L760 48 L820 55 L820 330 L0 330Z" fill="url(#area)" />
        <path d="M0 280 L40 270 L80 276 L120 245 L160 253 L200 220 L240 230 L280 190 L320 202 L360 168 L400 175 L440 142 L480 150 L520 112 L560 130 L600 88 L640 100 L680 72 L720 80 L760 48 L820 55" fill="none" stroke="#2dd4bf" strokeWidth="2" />
        {candles.map((height, i) => { const x = 16 + i * 34; const top = 285 - height * 2.25; const green = i % 5 !== 2; return <g key={i}><line x1={x + 8} x2={x + 8} y1={top - 13} y2={top + 45} stroke={green ? '#34d399' : '#fb7185'} strokeWidth="1"/><rect x={x} y={top} width="16" height="34" rx="2" fill={green ? '#34d399' : '#fb7185'} opacity=".85"/></g> })}
        <line x1="0" x2="820" y1="118" y2="118" stroke="#fbbf24" strokeDasharray="5 5" opacity=".75" />
        <circle cx="760" cy="48" r="4" fill="#2dd4bf" stroke="#082f2b" strokeWidth="3" />
      </svg>
      <div className="chart-x-labels"><span>09:30</span><span>10:00</span><span>10:30</span><span>11:00</span><span>11:30</span><span>12:00</span></div>
      <div className="chart-legend"><span><i className="legend-dot teal" /> Price</span><span><i className="legend-line yellow" /> VWAP 4.61</span><span><i className="legend-dot violet" /> Entry 4.71</span></div>
    </div>
  )
}

export default function Home() {
  const [selected, setSelected] = useState(stocks[0])
  const [timeframe, setTimeframe] = useState('1m')
  const { data: accountData } = useSWR<AccountData>('/api/account', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const { data: eventData } = useSWR<EventData>('/api/events?limit=8', fetcher, { refreshInterval: 5000, revalidateOnFocus: true })
  const liveAccount = accountData?.account
  const liveEvents = eventData?.events
  const displayedEvents = liveEvents?.length ? liveEvents.map((event) => [new Date(event.created_at).toLocaleTimeString('en-US', { hour12: false }), event.event_type, event.message, event.level.toLowerCase()] as const) : events

  const [paused, setPaused] = useState(false)
  return (
    <main className="terminal">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Activity /></div><div><strong>AI<span>trading</span></strong><small>INTELLIGENT EXECUTION TERMINAL</small></div></div>
        <div className="top-status"><span className="live-pill"><i /> PAPER MODE</span><span className="session-pill"><span className="pulse" /> MARKET OPEN</span><span className="clock">10:42:18 AM ET</span></div>
        <div className="top-actions"><button className="icon-button" aria-label="Notifications"><Bell /></button><button className="icon-button" aria-label="Settings"><Settings2 /></button><button className="flatten"><Power /> FLATTEN ALL</button><div className="avatar">TR</div></div>
      </header>
      <div className="workspace">
        <aside className="left-rail">
          <section className="panel balance-panel"><div className="section-kicker"><span>ACCOUNT EQUITY</span><ShieldCheck /></div><div className="balance">{formatMoney(liveAccount?.equity, '$2,000.00')}</div><div className="balance-meta"><span className="positive">{formatMoney((liveAccount?.realized_pnl ?? 0) + (liveAccount?.unrealized_pnl ?? 0), '+$0.00')}</span><span>paper account</span></div><div className="sparkline"><svg viewBox="0 0 220 42" preserveAspectRatio="none"><path d="M0 35 L20 32 L40 34 L60 25 L80 29 L100 20 L120 24 L140 15 L160 18 L180 8 L220 4" fill="none" stroke="#2dd4bf" strokeWidth="2"/></svg></div><div className="metric-row"><span>Cash balance</span><strong>{formatMoney(liveAccount?.cash_balance, '$2,000.00')}</strong></div><div className="metric-row"><span>Realized P&amp;L</span><strong className="positive">{formatMoney(liveAccount?.realized_pnl, '+$0.00')}</strong></div></section>
          <section className="panel"><div className="panel-title"><span>OPEN POSITION</span><span className="count-badge">1</span></div><div className="position-card"><div className="position-head"><div><strong>MIRA</strong><small>LONG · 180 SHARES</small></div><span className="positive">+$19.80</span></div><div className="position-stats"><div><span>Entry</span><b>$4.71</b></div><div><span>Mark</span><b>$4.82</b></div><div><span>Risk</span><b>1.2%</b></div></div><div className="risk-bar"><span /></div><div className="risk-label"><span>Stop $4.53</span><span>Target $5.14</span></div></div></section>
          <section className="panel controls"><div className="panel-title"><span>SESSION CONTROLS</span><CircleHelp /></div><div className="control-row"><span><Radio /> Auto-execution</span><button className="toggle on"><i /></button></div><div className="control-row"><span><Wifi /> Live data stream</span><button className="toggle on"><i /></button></div><div className="control-row"><span><SlidersHorizontal /> Strategy</span><strong className="control-value">Momentum v1.2 <ChevronDown /></strong></div><button className="pause-button" onClick={() => setPaused(!paused)}>{paused ? <Play /> : <Pause />}{paused ? 'RESUME STREAM' : 'PAUSE STREAM'}</button></section>
          <div className="terminal-foot"><span><i className="green-dot" /> WORKER HEALTHY</span><span>v0.1.0-paper</span></div>
        </aside>
        <section className="center-workspace">
          <div className="center-header"><div><div className="symbol-heading"><h1>{selected.symbol}</h1><span className="company-name">{selected.name}</span><span className="market-tag">NASDAQ</span></div><div className="quote"><strong>${selected.price}</strong><span className="positive"><TrendingUp /> {selected.change}</span><span className="quote-muted">+$0.11 today</span></div></div><div className="chart-actions"><button className="tool-button"><Crosshair /> Crosshair</button><button className="tool-button"><Minus /> Compare</button></div></div>
          <div className="timeframes">{['10s', '1m', '5m', '1h', '4h', 'D', '1Y'].map((item) => <button key={item} className={timeframe === item ? 'active' : ''} onClick={() => setTimeframe(item)}>{item}</button>)}<span className="timeframe-spacer" /><button className="tool-button"><SlidersHorizontal /> Indicators</button></div>
          <div className="chart-card"><div className="chart-topline"><div><span className="chart-label">{selected.symbol} · {timeframe} · NASDAQ</span><span className="ohlc">O 4.71&nbsp;&nbsp; H 4.89&nbsp;&nbsp; L 4.68&nbsp;&nbsp; C 4.82</span></div><span className="streaming"><i /> {paused ? 'STREAM PAUSED' : 'LIVE STREAMING'}</span></div><Chart symbol={selected.symbol} /><div className="volume"><span className="volume-title">VOLUME</span>{[24, 34, 20, 40, 27, 38, 51, 35, 48, 58, 45, 68, 55, 80, 63, 74, 68, 92, 77, 100, 86, 95, 82, 100].map((h, i) => <i key={i} style={{ height: `${h}%`, background: i % 5 === 2 ? '#fb7185' : '#2dd4bf' }} />)}</div></div>
          <div className="signal-strip"><div className="signal-main"><Sparkles /><div><span>AI SIGNAL · HIGH CONVICTION</span><strong>Momentum continuation setup</strong></div></div><div className="signal-stat"><span>Score</span><strong className="positive">94 / 100</strong></div><div className="signal-stat"><span>RVOL</span><strong>4.2x</strong></div><div className="signal-stat"><span>Float</span><strong>8.4M</strong></div><div className="signal-stat"><span>VWAP</span><strong className="positive">Above</strong></div></div>
        </section>
        <aside className="right-rail">
          <section className="panel watchlist-panel"><div className="panel-title"><span>SCANNED STOCKS</span><span className="scan-status"><i /> SCANNING</span></div><div className="search-box"><Search /><input placeholder="Filter symbols..." aria-label="Filter symbols" /></div><div className="watchlist">{stocks.map((stock) => <button key={stock.symbol} onClick={() => setSelected(stock)} className={`stock-row ${selected.symbol === stock.symbol ? 'selected' : ''}`}><div className="stock-left"><span className={`score ${stock.tone}`}>{stock.score}</span><div><strong>{stock.symbol}</strong><small>{stock.catalyst} · {stock.volume}</small></div></div><div className="stock-price"><strong>${stock.price}</strong><span className={stock.tone === 'red' ? 'negative' : 'positive'}>{stock.change}</span></div></button>)}</div><button className="view-all">VIEW ALL 23 SCANNED <ChevronDown /></button></section>
          <section className="panel events-panel"><div className="panel-title"><span>LIVE EVENT LOG</span><span className="event-count">{events.length} EVENTS</span></div><div className="event-filters"><button className="active">ALL</button><button>TRADES</button><button>SYSTEM</button><button>AI</button></div><div className="events">{displayedEvents.map(([time, type, message, tone], index) => <div className="event" key={`${time}-${type}-${index}`}><span className="event-time">{time}</span><span className={`event-type ${tone}`}>{type}</span><p>{message}</p></div>)}</div><div className="sleep-line"><i /> Scheduled sleep at <strong>16:00 ET</strong></div></section>
        </aside>
      </div>
    </main>
  )
}
