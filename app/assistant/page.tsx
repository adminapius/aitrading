'use client'

// Assistant mode (docs/assistant-mode-spec.md): scanner, alerts, risk calculator, daily limits and journal for
// Jose's MANUAL trades in a separate Alpaca paper account. It never places, changes or cancels an order.
import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { riskPlan } from '@/lib/assistant/risk'

type Session = { ok: true; mode: 'paper' | 'live'; equity: number; dayStartEquity: number; buyingPower: number }
type ApiError = Error & { status?: number; refused?: boolean }
const fetcher = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { cache: 'no-store' })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(body?.error ?? `Request failed (${r.status})`) as ApiError; e.status = r.status; e.refused = Boolean(body?.refused); throw e }
  return body as T
}
const send = async (url: string, method: string, body?: unknown) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) })
  const json = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(json?.error ?? `Request failed (${r.status})`)
  return json
}
const money = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD' }))
const num = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d))
const millions = (v: number | null | undefined) => (v == null ? '—' : `${(v / 1e6).toFixed(2)}M`)
const etTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—')
const etDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const card = 'rounded-lg border border-border bg-card p-4'
const input = 'w-full rounded-md border border-border bg-input px-2 py-1.5 text-sm'
const button = 'rounded-md border border-border bg-secondary px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50'

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <div className={card}>
        <h1 className="mb-1 text-lg font-semibold">Assistant</h1>
        <p className="mb-4 text-sm text-muted-foreground">For manual trades. It never places orders.</p>
        <form onSubmit={async (e) => { e.preventDefault(); setError(null); try { await send('/api/assistant/login', 'POST', { password }); onDone() } catch (err) { setError((err as Error).message) } }}>
          <input className={input} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Password" />
          <button className={`${button} mt-3 w-full`} type="submit">Sign in</button>
          {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
        </form>
      </div>
    </main>
  )
}

type Limits = { realized: number; maxLoss: number; lossHit: boolean; lossHitAt: string | null; tradesOpened: number; maxTrades: number; tradesHit: boolean; tradesHitAt: string | null } | null
function LimitsBar({ limits, mode }: { limits: Limits; mode: string }) {
  if (!limits) return null
  const hit = limits.lossHit || limits.tradesHit
  return (
    <div className={`mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border px-4 py-2 text-sm ${hit ? 'border-destructive bg-destructive/15 text-destructive' : 'border-border bg-card'}`} role="status">
      <span className="font-semibold uppercase">{mode} account</span>
      <span className={limits.lossHit ? 'font-bold' : ''}>Today {money(limits.realized)} / max loss −{money(limits.maxLoss)}{limits.lossHit ? ` · DAILY MAX LOSS HIT ${etTime(limits.lossHitAt)}` : ''}</span>
      <span className={limits.tradesHit ? 'font-bold' : ''}>Trades {limits.tradesOpened} / {limits.maxTrades}{limits.tradesHit ? ` · MAX TRADES HIT ${etTime(limits.tradesHitAt)}` : ''}</span>
    </div>
  )
}

type Row = { symbol: string; name: string | null; price: number; gainPct: number | null; relativeVolume: number | null; relativeVolumeReliable: boolean; spreadPct: number | null; float: number | null; floatMiss: string | null; fmpFloat: number | null; headline: string | null; headlineAgeMin: number | null; halt: { status: string; at: string | null; reason: string | null }; dilution: { flagged: boolean; forms: string[]; links: string[] }; failed: string[] }
function Scanner({ onPick }: { onPick: (symbol: string, price: number) => void }) {
  const { data, error } = useSWR<{ at: string; rows: Row[] }>('/api/assistant/scanner', fetcher, { refreshInterval: 15_000 })
  const [onlyMatches, setOnlyMatches] = useState(false)
  const rows = (data?.rows ?? []).filter((r) => !onlyMatches || r.failed.length === 0)
  return (
    <section className={card} aria-label="Scanner">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Scanner · gainers 07:00–11:00 ET <span className="text-xs text-muted-foreground">({data ? `updated ${etTime(data.at)}` : 'loading'})</span></h2>
        <label className="text-sm"><input type="checkbox" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} /> only rows matching my filters</label>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1 pr-3">Symbol</th><th className="pr-3">Price</th><th className="pr-3">Gain</th><th className="pr-3">RVOL</th><th className="pr-3" title="EDGAR shares outstanding filed before today (>= float)">Float (EDGAR)</th><th className="pr-3">News</th><th className="pr-3">Halt</th><th className="pr-3">Dilution</th><th className="pr-3">Spread</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className={`border-t border-border ${r.failed.length === 0 ? 'bg-primary/10' : ''}`}>
                <td className="py-1.5 pr-3 font-semibold" title={r.name ?? ''}>{r.symbol}{r.failed.length === 0 && <span className="ml-1 text-xs text-primary">match</span>}</td>
                <td className="pr-3">${num(r.price)}</td>
                <td className="pr-3">{r.gainPct == null ? '—' : `+${num(r.gainPct, 1)}%`}</td>
                <td className="pr-3" title={r.relativeVolumeReliable ? '' : 'thin baseline'}>{num(r.relativeVolume, 1)}{!r.relativeVolumeReliable && r.relativeVolume == null ? ' (thin)' : ''}</td>
                <td className="pr-3" title={r.floatMiss ?? ''}>{r.float != null ? millions(r.float) : <span className="text-muted-foreground">{r.floatMiss ?? '—'}</span>}{r.fmpFloat != null && <span className="ml-1 text-xs text-muted-foreground">FMP {millions(r.fmpFloat)}</span>}</td>
                <td className="max-w-xs truncate pr-3" title={r.headline ?? ''}>{r.headline ? `${r.headlineAgeMin} min · ${r.headline}` : <span className="text-muted-foreground">none</span>}</td>
                <td className={`pr-3 ${r.halt.status === 'none' || r.halt.status === 'resumed' ? '' : 'text-destructive'}`} title={r.halt.reason ?? ''}>{r.halt.status === 'none' ? '—' : `${r.halt.status} ${etTime(r.halt.at)}`}</td>
                <td className="pr-3">{r.dilution.flagged ? <a className="text-destructive underline" href={r.dilution.links[0]} target="_blank" rel="noreferrer" title={r.dilution.forms.join(', ')}>{r.dilution.forms[0] ?? 'flag'}</a> : '—'}</td>
                <td className="pr-3">{r.spreadPct == null ? '—' : `${num(r.spreadPct)}%`}</td>
                <td><button className={button} onClick={() => onPick(r.symbol, r.price)}>Risk</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !rows.length && <p className="py-3 text-sm text-muted-foreground">No gainers right now.</p>}
      </div>
    </section>
  )
}

function RiskCalc({ session, pick, setups, limitHit }: { session: Session; pick: { symbol: string; price: number } | null; setups: string[]; limitHit: boolean }) {
  const [symbol, setSymbol] = useState('')
  const [entry, setEntry] = useState('')
  const [stop, setStop] = useState('')
  const [setup, setSetup] = useState(setups[0] ?? '')
  const [saved, setSaved] = useState<string | null>(null)
  useEffect(() => { if (pick) { setSymbol(pick.symbol); setEntry(pick.price.toFixed(2)) } }, [pick])
  const plan = useMemo(() => riskPlan({ entry: Number(entry), stop: Number(stop), equity: session.equity, buyingPower: session.buyingPower, limitHit }), [entry, stop, session, limitHit])
  return (
    <section className={card} aria-label="Risk calculator">
      <h2 className="mb-3 font-semibold">Risk calculator · 1% of {money(session.equity)}</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-xs">Symbol<input className={input} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></label>
        <label className="text-xs">Entry<input className={input} inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} /></label>
        <label className="text-xs">Stop<input className={input} inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} /></label>
        <label className="text-xs">Setup<select className={input} value={setup} onChange={(e) => setSetup(e.target.value)}>{setups.map((s) => <option key={s}>{s}</option>)}</select></label>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        <div><dt className="text-xs text-muted-foreground">Shares</dt><dd className="text-lg font-semibold">{plan.ok ? plan.shares : '—'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Dollar risk</dt><dd>{plan.ok ? money(plan.dollarRisk) : '—'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">1R target</dt><dd>{plan.ok ? `$${num(plan.target1R)}` : '—'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">2R target</dt><dd>{plan.ok ? `$${num(plan.target2R)}` : '—'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Position</dt><dd>{plan.ok ? `${money(plan.positionValue)} (${(100 * plan.positionPctOfEquity).toFixed(0)}%)${plan.capped ? ` · capped by ${plan.capped}` : ''}` : '—'}</dd></div>
      </dl>
      {plan.warnings.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-destructive">{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      <div className="mt-3 flex items-center gap-3">
        <button className={button} disabled={!plan.ok || !symbol} onClick={async () => { try { await send('/api/assistant/plan', 'POST', { symbol, entry: Number(entry), stop: Number(stop), setup }); setSaved(`Plan saved ${new Date().toLocaleTimeString()}: the journal uses this stop for your next ${symbol} fill within 10 minutes.`) } catch (e) { setSaved((e as Error).message) } }}>Save plan</button>
        <span className="text-xs text-muted-foreground">{saved ?? 'No order is sent. Place the order yourself in Alpaca.'}</span>
      </div>
    </section>
  )
}

type Trade = { key: string; symbol: string; mode: 'paper' | 'live'; side: string; entryAt: string; exitAt: string | null; open: boolean; shares: number; avgEntry: number; avgExit: number | null; net: number; stop: number | null; stopFrom: string | null; r: number | null; setup: string; notes: string; screenshotUrl: string | null; afterLimit: boolean }
type StatRow = { key: string; trades: number; withR: number; noStop: number; winPct: number; expectancyR: number; pf: number; totalR: number; net: number; enough: boolean }
type Journal = { trades: Trade[]; limits: Limits; stats: { paper: StatRow; live: StatRow; bySetup: StatRow[]; byTime: StatRow[]; byPrice: StatRow[] }; edge: { status: string; text: string }; settings: { setups: string[] } }

function StatsTable({ title, rows }: { title: string; rows: StatRow[] }) {
  return (
    <div className="overflow-x-auto">
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground"><tr><th className="pr-2">Group</th><th className="pr-2">Trades</th><th className="pr-2">With R</th><th className="pr-2">Win %</th><th className="pr-2">Exp. R</th><th className="pr-2">PF</th><th className="pr-2">Total R</th><th>$</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key} className={`border-t border-border ${r.enough ? '' : 'text-muted-foreground'}`} title={r.enough ? '' : 'Under 30 trades with R: too few to judge'}><td className="pr-2">{r.key}</td><td className="pr-2">{r.trades}</td><td className="pr-2">{r.withR}</td><td className="pr-2">{num(r.winPct, 0)}</td><td className="pr-2">{num(r.expectancyR)}</td><td className="pr-2">{Number.isFinite(r.pf) ? num(r.pf) : '∞'}</td><td className="pr-2">{num(r.totalR)}</td><td>{money(r.net)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

function TradeRow({ t, setups, onChange }: { t: Trade; setups: string[]; onChange: () => void }) {
  const [notes, setNotes] = useState(t.notes)
  const [stop, setStop] = useState(t.stop == null ? '' : String(t.stop))
  const save = async (values: Record<string, unknown>) => { await send('/api/assistant/trade', 'PATCH', { key: t.key, ...values }); onChange() }
  return (
    <tr className={`border-t border-border align-top ${t.afterLimit ? 'bg-destructive/10' : ''}`}>
      <td className="py-1.5 pr-2"><span className={`rounded px-1 text-xs font-semibold uppercase ${t.mode === 'paper' ? 'bg-secondary' : 'bg-destructive/30'}`}>{t.mode}</span></td>
      <td className="pr-2">{etDate(t.entryAt)} {etTime(t.entryAt)}{t.afterLimit && <div className="text-xs text-destructive">after a limit was hit</div>}</td>
      <td className="pr-2 font-semibold">{t.symbol} <span className="text-xs font-normal text-muted-foreground">{t.side}</span></td>
      <td className="pr-2">{t.shares} @ {num(t.avgEntry)}{t.avgExit != null ? ` → ${num(t.avgExit)}` : ''}{t.open ? ' (open)' : ''}</td>
      <td className={`pr-2 ${t.net >= 0 ? 'text-primary' : 'text-destructive'}`}>{t.open ? '—' : money(t.net)}</td>
      <td className="pr-2">{t.r == null ? <span className="text-muted-foreground">{t.open ? 'open' : 'no stop'}</span> : `${num(t.r)}R`}</td>
      <td className="pr-2"><input className={`${input} w-20`} inputMode="decimal" placeholder="stop" value={stop} onChange={(e) => setStop(e.target.value)} onBlur={() => save({ stop: stop ? Number(stop) : null })} title={t.stopFrom ? `from ${t.stopFrom}` : 'enter the stop to get R'} /></td>
      <td className="pr-2"><select className={input} value={t.setup} onChange={(e) => save({ setup: e.target.value })}>{[...new Set([t.setup, ...setups])].map((s) => <option key={s}>{s}</option>)}</select></td>
      <td className="pr-2"><textarea className={`${input} min-w-48`} rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== t.notes && save({ notes })} /></td>
      <td>{t.screenshotUrl ? <a href={t.screenshotUrl} target="_blank" rel="noreferrer" className="text-xs underline">view</a> : null}
        <label className="ml-1 cursor-pointer text-xs underline">add<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.set('key', t.key); fd.set('file', f); await fetch('/api/assistant/screenshot', { method: 'POST', body: fd }); onChange() }} /></label></td>
    </tr>
  )
}

function JournalView({ journal, reload }: { journal: Journal | undefined; reload: () => void }) {
  const [importing, setImporting] = useState<string | null>(null)
  if (!journal) return <section className={card}><p className="text-sm text-muted-foreground">Loading journal…</p></section>
  const s = journal.stats
  return (
    <section className={`${card} space-y-4`} aria-label="Journal">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Journal</h2>
        <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{importing}</span><button className={button} onClick={async () => { setImporting('importing…'); try { const r = await send('/api/assistant/import', 'POST'); setImporting(`${r.imported} new fills`); reload() } catch (e) { setImporting((e as Error).message) } }}>Import fills now</button></div>
      </div>
      <div className={`rounded-md border px-3 py-2 text-sm ${journal.edge.status === 'meets' ? 'border-primary' : journal.edge.status === 'does-not-meet' ? 'border-destructive' : 'border-border'}`}>
        <strong>Paper yardstick (30 trades, E's rule: expectancy &gt; +0.10R and PF &gt; 1.3), judged on paper trades only, before any live money:</strong> {journal.edge.text}{journal.edge.status === 'meets' ? ' · meets it' : journal.edge.status === 'does-not-meet' ? ' · does not meet it' : ''}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <StatsTable title="Overall" rows={[{ ...s.paper, key: 'paper' }, { ...s.live, key: 'live (not judged)' }]} />
        <StatsTable title="By setup" rows={s.bySetup} />
        <StatsTable title="By time of day (ET)" rows={s.byTime} />
        <StatsTable title="By price band" rows={s.byPrice} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground"><tr><th className="pr-2">Account</th><th className="pr-2">Entry (ET)</th><th className="pr-2">Symbol</th><th className="pr-2">Shares / prices</th><th className="pr-2">Net</th><th className="pr-2">R</th><th className="pr-2">Stop</th><th className="pr-2">Setup</th><th className="pr-2">Notes</th><th>Screenshot</th></tr></thead>
          <tbody>{journal.trades.map((t) => <TradeRow key={`${t.key}:${t.notes}:${t.stop}`} t={t} setups={journal.settings.setups} onChange={reload} />)}</tbody>
        </table>
        {!journal.trades.length && <p className="py-3 text-sm text-muted-foreground">No manual fills yet. Trades in the separate paper account appear here within 5 minutes.</p>}
      </div>
    </section>
  )
}

type Settings = { filters: Record<string, number | boolean | null>; maxLossPct: number; maxTrades: number; setups: string[] }

function SettingsView({ onSaved }: { onSaved: () => void }) {
  const { data, mutate } = useSWR<Settings>('/api/assistant/settings', fetcher)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { if (data && !draft) setDraft(data) }, [data, draft])
  if (!draft) return <section className={card}>Loading settings…</section>
  const f = draft.filters
  const set = (k: string, v: number | boolean | null) => setDraft({ ...draft, filters: { ...f, [k]: v } })
  const field = (k: string, label: string, scale = 1) => <label className="text-xs">{label}<input className={input} inputMode="decimal" value={f[k] == null ? '' : String(Number(f[k]) / scale)} onChange={(e) => set(k, e.target.value === '' ? null : Number(e.target.value) * scale)} /></label>
  return (
    <section className={`${card} space-y-4`} aria-label="Settings">
      <h2 className="font-semibold">Alert filters (no orders are ever sent)</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {field('floatMax', 'Float max (M shares)', 1e6)}{field('priceMin', 'Price min $')}{field('priceMax', 'Price max $')}{field('gainMin', 'Gain min %')}
        {field('rvolMin', 'RVOL min')}{field('newsMinutes', 'News within (min)')}{field('windowStart', 'Window start (min after 00:00 ET)')}{field('windowEnd', 'Window end (min after 00:00 ET)')}
        <label className="text-xs"><input type="checkbox" checked={Boolean(f.excludeDilution)} onChange={(e) => set('excludeDilution', e.target.checked)} /> exclude dilution-flagged</label>
        <label className="text-xs"><input type="checkbox" checked={Boolean(f.excludeHalted)} onChange={(e) => set('excludeHalted', e.target.checked)} /> exclude halted</label>
        <label className="text-xs"><input type="checkbox" checked={Boolean(f.reAlertNewHigh)} onChange={(e) => set('reAlertNewHigh', e.target.checked)} /> alert again on a new high</label>
      </div>
      <h2 className="font-semibold">Daily limits</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-xs">Max loss (% of the day's starting equity)<input className={input} inputMode="decimal" value={String(draft.maxLossPct * 100)} onChange={(e) => setDraft({ ...draft, maxLossPct: Number(e.target.value) / 100 })} /></label>
        <label className="text-xs">Max trades a day<input className={input} inputMode="numeric" value={String(draft.maxTrades)} onChange={(e) => setDraft({ ...draft, maxTrades: Number(e.target.value) })} /></label>
        <label className="col-span-2 text-xs">Setup tags (comma-separated)<input className={input} value={draft.setups.join(', ')} onChange={(e) => setDraft({ ...draft, setups: e.target.value.split(',').map((s) => s.trim()) })} /></label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className={button} onClick={async () => { try { const s = await send('/api/assistant/settings', 'PUT', draft); setDraft(s); mutate(s); setMsg('Saved.'); onSaved() } catch (e) { setMsg((e as Error).message) } }}>Save settings</button>
        <button className={button} onClick={async () => { try { const r = await send('/api/assistant/push', 'POST'); setMsg(r.sent ? `Test alert sent (${r.channels.join(', ')}).` : 'No alert channel answered: check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID or NTFY_TOPIC_URL.') } catch (e) { setMsg((e as Error).message) } }}>Send a test alert</button>
        <span className="text-xs text-muted-foreground">{msg ?? 'Alerts go to your existing Telegram / ntfy channel, titled [Assistant].'}</span>
      </div>
    </section>
  )
}

export default function AssistantPage() {
  const { data: session, error, mutate } = useSWR<Session>('/api/assistant/session', fetcher, { refreshInterval: 60_000, shouldRetryOnError: false })
  const signedIn = Boolean(session)
  const { data: journal, mutate: reloadJournal } = useSWR<Journal>(signedIn ? '/api/assistant/journal' : null, fetcher, { refreshInterval: 60_000 })
  const [tab, setTab] = useState<'scanner' | 'risk' | 'journal' | 'settings'>('scanner')
  const [pick, setPick] = useState<{ symbol: string; price: number } | null>(null)
  const e = error as ApiError | undefined
  if (e?.status === 401) return <Login onDone={() => mutate()} />
  if (e?.refused) return <main className="mx-auto mt-24 max-w-lg px-4"><div className={`${card} border-destructive`}><h1 className="mb-2 font-semibold text-destructive">Assistant refused to start</h1><p className="text-sm">{e.message}</p></div></main>
  if (e) return <main className="mx-auto mt-24 max-w-lg px-4"><div className={card}><p className="text-sm text-destructive">{e.message}</p></div></main>
  if (!session) return <main className="mx-auto mt-24 max-w-lg px-4 text-sm text-muted-foreground">Loading…</main>
  const limitHit = Boolean(journal?.limits?.lossHit || journal?.limits?.tradesHit)
  const tabs = [['scanner', 'Scanner'], ['risk', 'Risk'], ['journal', 'Journal'], ['settings', 'Settings']] as const
  return (
    <main className="mx-auto max-w-7xl px-4 py-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="text-lg font-semibold">Trading assistant</h1><p className="text-xs text-muted-foreground">Manual trades only · separate {session.mode} account · it never places orders · equity {money(session.equity)}</p></div>
        <nav className="flex gap-1">{tabs.map(([id, label]) => <button key={id} className={`${button} ${tab === id ? 'border-primary text-primary' : ''}`} onClick={() => setTab(id)}>{label}</button>)}
          <button className={button} onClick={async () => { await send('/api/assistant/logout', 'POST'); mutate() }}>Sign out</button></nav>
      </header>
      <LimitsBar limits={journal?.limits ?? null} mode={session.mode} />
      {tab === 'scanner' && <Scanner onPick={(symbol, price) => { setPick({ symbol, price }); setTab('risk') }} />}
      {tab === 'risk' && <RiskCalc session={session} pick={pick} setups={journal?.settings.setups ?? ['other']} limitHit={limitHit} />}
      {tab === 'journal' && <JournalView journal={journal} reload={() => reloadJournal()} />}
      {tab === 'settings' && <SettingsView onSaved={() => reloadJournal()} />}
    </main>
  )
}
