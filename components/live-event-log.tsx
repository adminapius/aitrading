'use client'

import { useMemo, useState } from 'react'
import { Activity, Search, X } from 'lucide-react'

type EventRecord = {
  id: string
  level: string
  event_type: string
  message: string
  created_at: string
  symbol?: string | null
}

type EventFilter = 'all' | 'scan' | 'ai' | 'execution' | 'system' | 'alerts'
type EventCategory = Exclude<EventFilter, 'all'>

const filters: { id: EventFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'scan', label: 'Scan' },
  { id: 'ai', label: 'AI' },
  { id: 'execution', label: 'Orders' },
  { id: 'system', label: 'System' },
  { id: 'alerts', label: 'Alerts' },
]

function getEventCategory(event: EventRecord): EventCategory {
  const type = event.event_type.toLowerCase()
  const level = event.level.toLowerCase()

  if (level === 'error' || level === 'warning' || /risk|error/.test(type)) return 'alerts'
  if (/scan|watchlist/.test(type)) return 'scan'
  if (/ai/.test(type)) return 'ai'
  if (/order|trade|position|flatten|execution/.test(type)) return 'execution'
  return 'system'
}

function formatEventTime(value: string) {
  const date = new Date(value)
  return {
    display: new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(date),
    title: new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    }).format(date),
  }
}

function formatEventType(value: string) {
  return value.replace(/[_-]+/g, ' ').toUpperCase()
}

export function LiveEventLog({
  events,
  isAwake,
  degraded,
  connectionError,
  loading,
}: {
  events: EventRecord[]
  isAwake: boolean
  degraded: boolean
  connectionError: boolean
  loading: boolean
}) {
  const [activeFilter, setActiveFilter] = useState<EventFilter>('all')
  const [query, setQuery] = useState('')
  const eventCounts = useMemo(() => events.reduce<Record<EventCategory, number>>((counts, event) => {
    counts[getEventCategory(event)] += 1
    return counts
  }, { scan: 0, ai: 0, execution: 0, system: 0, alerts: 0 }), [events])
  const sortedEvents = useMemo(() => [...events].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)), [events])
  const visibleEvents = sortedEvents.filter((event) => {
    const matchesFilter = activeFilter === 'all' || getEventCategory(event) === activeFilter
    const normalizedQuery = query.trim().toLowerCase()
    const matchesQuery = !normalizedQuery || [event.symbol, event.event_type, event.level, event.message]
      .some((value) => value?.toLowerCase().includes(normalizedQuery))
    return matchesFilter && matchesQuery
  })
  const feedOffline = degraded || connectionError

  return (
    <section className="panel events-panel event-log-panel" aria-labelledby="event-log-title">
      <div className="event-log-heading">
        <div className="event-log-title-row">
          <h2 id="event-log-title">LIVE EVENT LOG</h2>
          <span className="event-log-total">{events.length} / 100</span>
        </div>
        <span className={`event-log-status ${feedOffline ? 'is-offline' : isAwake ? 'is-active' : 'is-idle'}`}>
          <i aria-hidden="true" />{feedOffline ? 'OFFLINE' : isAwake ? 'LIVE' : 'IDLE'}
        </span>
      </div>
      <div className="event-log-subhead">
        <span>SESSION · ET</span>
        <span><Activity aria-hidden="true" /> POLL 5S</span>
      </div>
      <nav className="event-log-filters" aria-label="Filter event log">
        {filters.map((filter) => {
          const count = filter.id === 'all' ? events.length : eventCounts[filter.id]
          return (
            <button
              aria-pressed={activeFilter === filter.id}
              className={activeFilter === filter.id ? 'is-selected' : ''}
              key={filter.id}
              onClick={() => setActiveFilter(filter.id)}
              type="button"
            >
              {filter.label}<span>{count}</span>
            </button>
          )
        })}
      </nav>
      <div className="event-log-search">
        <Search aria-hidden="true" />
        <label className="sr-only" htmlFor="event-log-search">Search event messages, symbols, or types</label>
        <input
          autoComplete="off"
          id="event-log-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search messages or symbols"
          type="search"
          value={query}
        />
        {query && <button aria-label="Clear search" onClick={() => setQuery('')} type="button"><X aria-hidden="true" /></button>}
      </div>
      <div className="event-log-feed" aria-label="Events, newest first">
        {visibleEvents.map((event) => {
          const category = getEventCategory(event)
          const time = formatEventTime(event.created_at)
          return (
            <article className={`event-log-entry event-${category} level-${event.level.toLowerCase()}`} key={event.id}>
              <div className="event-log-entry-head">
                <time dateTime={event.created_at} title={time.title}>{time.display}</time>
                <span className={`event-log-category category-${category}`}>{category}</span>
                {event.symbol && <span className="event-log-symbol">{event.symbol}</span>}
              </div>
              <p>{event.message}</p>
              <div className="event-log-entry-foot">
                <span>{formatEventType(event.event_type)}</span>
                <span>{event.level.toUpperCase()}</span>
              </div>
            </article>
          )
        })}
        {!visibleEvents.length && (
          <div className="event-log-empty" role="status">
            {feedOffline
              ? 'The event feed is unavailable. Reconnecting automatically.'
              : loading
                ? 'Connecting to the event feed…'
                : events.length === 0
                  ? isAwake ? 'No events recorded yet. The next scanner update will appear here.' : 'No events recorded in this session.'
                  : 'No events match these filters. Try another category or search.'}
          </div>
        )}
      </div>
      <div className="event-log-footnote">Newest first · current session · up to 100 events</div>
    </section>
  )
}

export default LiveEventLog
