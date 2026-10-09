const STROKES = ['var(--primary)', 'var(--foreground)', '#fbbf24', 'var(--muted-foreground)']
const WIDTH = 1000
const HEIGHT = 280

type Series = { id: string; label: string; points: Array<{ date: string; equity: number }> }

export function EquityChart({ runs, startingEquity }: { runs: Series[]; startingEquity: number }) {
  const dates = [...new Set(runs.flatMap((run) => run.points.map((point) => point.date)))].sort()
  const values = runs.flatMap((run) => run.points.map((point) => point.equity)).concat(startingEquity)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(max - min, 1)
  const x = (date: string) => dates.length > 1 ? (dates.indexOf(date) / (dates.length - 1)) * WIDTH : 0
  const y = (value: number) => HEIGHT - ((value - min) / range) * HEIGHT

  if (!dates.length) return <p className="text-sm text-muted-foreground">No equity points.</p>

  return (
    <figure className="flex flex-col gap-3">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="h-72 w-full" role="img" aria-label="Daily equity per strategy">
        <line x1={0} x2={WIDTH} y1={y(startingEquity)} y2={y(startingEquity)} stroke="var(--border)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        {runs.map((run, index) => (
          <polyline
            key={run.id}
            fill="none"
            stroke={STROKES[index % STROKES.length]}
            strokeWidth={1.75}
            vectorEffect="non-scaling-stroke"
            points={run.points.map((point) => `${x(point.date)},${y(point.equity)}`).join(' ')}
          />
        ))}
      </svg>
      <figcaption className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{dates[0]} · low ${min.toFixed(0)} · high ${max.toFixed(0)} · dashed = ${startingEquity.toFixed(0)} start</span>
        <span className="flex flex-wrap gap-4">
          {runs.map((run, index) => (
            <span key={run.id} className="flex items-center gap-2">
              <span aria-hidden="true" className="inline-block h-0.5 w-4" style={{ background: STROKES[index % STROKES.length] }} />
              {run.label}
            </span>
          ))}
        </span>
        <span>{dates.at(-1)}</span>
      </figcaption>
    </figure>
  )
}
