/**
 * Small, dependency-free SVG charts for the dashboard. Kept intentionally
 * simple — a donut gauge and a smoothed area/line chart — so they stay crisp
 * and match the light UI system.
 */

import type { CSSProperties } from 'react'

export function Donut({ percent }: { percent: number }): JSX.Element {
  const p = Math.max(0, Math.min(100, Math.round(percent)))
  const style: CSSProperties = {}
  ;(style as Record<string, string>)['--p'] = String(p)
  return (
    <div className="donut" style={style}>
      <span className="donut-val">{p}%</span>
    </div>
  )
}

/** Horizontal bar list — like the reference "Country Redistribution" panel. */
export function BarList({
  items,
  formatValue
}: {
  items: Array<{ label: string; value: number }>
  formatValue?: (v: number) => string
}): JSX.Element {
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="barlist">
      {items.map((it, i) => (
        <div className="barlist-row" key={`${it.label}-${i}`}>
          <div className="barlist-label" title={it.label}>
            {it.label}
          </div>
          <div className="barlist-track">
            <div
              className="barlist-fill"
              style={{ width: `${Math.max(3, (it.value / max) * 100)}%` }}
            />
          </div>
          <div className="barlist-value">{formatValue ? formatValue(it.value) : it.value}</div>
        </div>
      ))}
    </div>
  )
}

interface Series {
  points: number[]
  color: string
  fill?: boolean
}

/**
 * Monotone cubic interpolation (Fritsch–Carlson). Unlike a plain Catmull-Rom
 * spline, this never overshoots the data range, so a flat run followed by a
 * spike can't bow the curve below the baseline (or above the peak). Assumes x
 * is strictly increasing, which it always is here (equally-spaced points).
 */
function smoothPath(pts: Array<[number, number]>): string {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`
  if (n === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`

  // Secant slopes between consecutive points.
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0]
    slope[i] = dx[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx[i]
  }

  // Tangents: 0 at local extrema (sign change / flat), otherwise a slope-
  // limited average that keeps every segment monotonic — the anti-overshoot.
  const m: number[] = new Array(n)
  m[0] = slope[0]
  m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1]
    const s1 = slope[i]
    if (s0 * s1 <= 0) {
      m[i] = 0
    } else {
      const p = (s0 * dx[i] + s1 * dx[i - 1]) / (dx[i - 1] + dx[i])
      m[i] =
        (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0
    }
  }

  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[i + 1]
    const cp1x = x1 + dx[i] / 3
    const cp1y = y1 + (m[i] * dx[i]) / 3
    const cp2x = x2 - dx[i] / 3
    const cp2y = y2 - (m[i + 1] * dx[i]) / 3
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
  }
  return d
}

export function AreaChart({
  series,
  labels,
  height = 200
}: {
  series: Series[]
  labels?: string[]
  height?: number
}): JSX.Element {
  const W = 640
  const H = height
  const padL = 6
  const padR = 6
  const padT = 14
  const padB = labels ? 24 : 10
  const all = series.flatMap((s) => s.points)
  const max = Math.max(1, ...all)
  const n = Math.max(1, ...series.map((s) => s.points.length))
  const xFor = (i: number): number => padL + (i / Math.max(1, n - 1)) * (W - padL - padR)
  const yFor = (v: number): number => padT + (1 - v / max) * (H - padT - padB)

  const gridLines = 4
  const gridYs = Array.from({ length: gridLines + 1 }, (_, i) => padT + (i / gridLines) * (H - padT - padB))

  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
      <defs>
        {series.map((s, si) => (
          <linearGradient key={si} id={`area-${si}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={s.color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={s.color} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>

      {gridYs.map((y, i) => (
        <line key={i} x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--chart-grid)" strokeWidth="1" />
      ))}

      {series.map((s, si) => {
        const pts = s.points.map((v, i) => [xFor(i), yFor(v)] as [number, number])
        const line = smoothPath(pts)
        const last = pts[pts.length - 1]
        return (
          <g key={si}>
            {s.fill && last && (
              <path
                d={`${line} L${last[0]},${H - padB} L${pts[0][0]},${H - padB} Z`}
                fill={`url(#area-${si})`}
              />
            )}
            <path d={line} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            {last && <circle cx={last[0]} cy={last[1]} r="3.5" fill={s.color} stroke="#fff" strokeWidth="2" />}
          </g>
        )
      })}

      {labels &&
        labels.map((lb, i) => {
          if (n > 8 && i % 2 !== 0 && i !== labels.length - 1) return null
          return (
            <text
              key={i}
              x={xFor(i)}
              y={H - 6}
              textAnchor="middle"
              fontSize="10"
              fill="var(--text-3)"
            >
              {lb}
            </text>
          )
        })}
    </svg>
  )
}
