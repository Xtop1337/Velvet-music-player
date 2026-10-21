import { useEffect, useRef, useState } from 'react'

export interface Bar {
  label: string
  value: number
}

/** Round-topped bar path anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

/** Single-series bar chart with a recessive grid and per-bar hover tooltip. */
export function BarChart({ data, format, label }: { data: Bar[]; format: (v: number) => string; label: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const height = 200
  const padL = 36
  const padB = 24
  const padT = 8
  const plotW = Math.max(10, width - padL)
  const plotH = height - padB - padT
  const max = niceMax(Math.max(...data.map((d) => d.value), 0))
  const step = plotW / Math.max(1, data.length)
  const barW = Math.max(2, Math.min(28, step - 2))
  const ticks = [0, max / 2, max]
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 70))))
  const h = hover !== null ? data[hover] : null

  return (
    <div className="bar-chart" ref={ref} role="img" aria-label={label}>
      <svg width={width} height={height}>
        {ticks.map((tk) => {
          const y = padT + plotH - (tk / max) * plotH
          return (
            <g key={tk}>
              <line x1={padL} x2={width} y1={y} y2={y} className="bar-chart__grid" />
              <text x={padL - 8} y={y + 4} textAnchor="end" className="bar-chart__tick">
                {Number.isInteger(tk) ? tk : tk.toFixed(1)}
              </text>
            </g>
          )
        })}
        {data.map((d, i) => {
          const bh = (d.value / max) * plotH
          const x = padL + i * step + (step - barW) / 2
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={padL + i * step} y={padT} width={step} height={plotH} fill="transparent" />
              {d.value > 0 && (
                <path d={barPath(x, padT + plotH - bh, barW, bh, 4)} className={`bar-chart__bar ${hover === i ? 'is-hover' : ''}`} />
              )}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 6} textAnchor="middle" className="bar-chart__tick">
                  {d.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {h && hover !== null && (
        <div
          className="bar-chart__tip"
          style={{ left: Math.min(width - 120, Math.max(0, padL + hover * step + step / 2 - 60)), top: 0 }}
        >
          <span>{h.label}</span>
          <strong>{format(h.value)}</strong>
        </div>
      )}
    </div>
  )
}
