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

function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(
      1
    )},${p2[1].toFixed(1)}`
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
            {s.fill && (
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
