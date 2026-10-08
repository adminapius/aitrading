'use client'

import { useMemo, useState } from 'react'
import useSWRInfinite from 'swr/infinite'
import { Activity, Search, X } from 'lucide-react'

type EventRecord = {
  id: string
  level: string
  event_type: string
  message: string
  created_at: string
  symbol?: string | null
}

type EventPage = {
  events: EventRecord[]
  nextCursor: string | null
  hasMore: boolean
  degraded?: boolean
  degradedReason?: string
}

type EventCategory = 'scan' | 'ai' | 'execution' | 'system' | 'alerts'

const PAGE_SIZE = 200

const eventFetcher = async (url: string): Promise<EventPage> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Event history request failed (${response.status})`)
  return response.json()
}

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

export function LiveEventLog({ isAwake }: { isAwake: boolean }) {
  const [query, setQuery] = useState('')
  const { data, error, isLoading, isValidating, size, setSize } = useSWRInfinite<EventPage>(
    (pageIndex, previousPage) => {
      if (previousPage && !previousPage.hasMore) return null
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (pageIndex > 0 && previousPage?.nextCursor) params.set('before', previousPage.nextCursor)
      return `/api/events?${params}`
    },
    eventFetcher,
    { refreshInterval: 5_000, revalidateOnFocus: true, revalidateFirstPage: true, revalidateAll: false },
  )
  const events = useMemo(() => data?.flatMap((page) => page.events) ?? [], [data])
  const visibleEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return events
    return events.filter((event) => [event.symbol, event.event_type, event.level, event.message]
      .some((value) => value?.toLowerCase().includes(normalizedQuery)))
  }, [events, query])
  const latestPage = data?.at(-1)
  const feedOffline = Boolean(error || data?.[0]?.degraded)
  const loadingOlder = isValidating && !isLoading

  return (
    <section className="panel events-panel event-log-panel" aria-labelledby="event-log-title">
      <div className="event-log-heading">
        <div className="event-log-title-row">
          <h2 id="event-log-title">LIVE EVENT LOG</h2>
          <span className="event-log-total">{events.length.toLocaleString()} LOADED TODAY</span>
        </div>
        <span className={`event-log-status ${feedOffline ? 'is-offline' : isAwake ? 'is-active' : 'is-idle'}`}>
          <i aria-hidden="true" />{feedOffline ? 'OFFLINE' : isAwake ? 'LIVE' : 'IDLE'}
        </span>
      </div>
      <div className="event-log-subhead">
        <span>TODAY · 7AM–3:55PM ET</span>
        <span><Activity aria-hidden="true" /> POLL 5S</span>
      </div>
      <div className="event-log-search">
        <Search aria-hidden="true" />
        <label className="sr-only" htmlFor="event-log-search">Search loaded messages, symbols, levels, and event types</label>
        <input
          autoComplete="off"
          id="event-log-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search loaded messages, symbols, levels, or event types"
          type="search"
          value={query}
        />
        {query && <button aria-label="Clear search" onClick={() => setQuery('')} type="button"><X aria-hidden="true" /></button>}
      </div>
      <div className="event-log-feed" aria-label="Events, newest first" aria-live="polite">
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
              ? data?.[0]?.degradedReason ?? 'The event feed is unavailable. Reconnecting automatically.'
              : isLoading
                ? 'Connecting to the event feed…'
                : events.length === 0
                  ? isAwake ? 'No events recorded yet today. The next scanner update will appear here.' : 'No events recorded today.'
                  : 'No loaded events match this search.'}
          </div>
        )}
      </div>
      {latestPage?.hasMore && (
        <button className="event-log-load-more" disabled={loadingOlder} onClick={() => setSize(size + 1)} type="button">
          {loadingOlder ? 'Loading older events…' : 'Load older events'}
        </button>
      )}
      <div className="event-log-footnote">Newest first · paginated 200 at a time · today&apos;s full operating session</div>
    </section>
  )
}

export default LiveEventLog
