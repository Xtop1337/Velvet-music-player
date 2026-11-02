import { Music2, X } from 'lucide-react'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { mediaUrl } from '@renderer/lib/media'
import { placeholderGradient } from '@renderer/lib/format'

export function IconButton(props: {
  label: string
  onClick?: (e: React.MouseEvent) => void
  children: ReactNode
  active?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
  disabled?: boolean
}): React.JSX.Element {
  const { label, onClick, children, active, size = 'md', className = '', disabled } = props
  return (
    <button
      type="button"
      className={`icon-btn icon-btn--${size} ${active ? 'is-active' : ''} ${className}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function Button(props: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  icon?: ReactNode
  disabled?: boolean
  type?: 'button' | 'submit'
  className?: string
  title?: string
}): React.JSX.Element {
  const { children, onClick, variant = 'secondary', icon, disabled, type = 'button', className = '', title } = props
  return (
    <button type={type} className={`btn btn--${variant} ${className}`} onClick={onClick} disabled={disabled} title={title}>
      {icon}
      <span>{children}</span>
    </button>
  )
}

export function Slider(props: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  onCommit?: (v: number) => void
  label: string
  className?: string
  /** Value above which the track is drawn in the "hot" colour (e.g. 100% volume). */
  hotFrom?: number
  /** Centre the fill around this value (for EQ sliders). */
  origin?: number
  wheelStep?: number
  style?: CSSProperties
  formatValue?: (v: number) => string
}): React.JSX.Element {
  const { value, min, max, step = 0.01, onChange, onCommit, label, className = '', hotFrom, origin, wheelStep, style, formatValue } = props
  const pct = (v: number): number => ((v - min) / (max - min)) * 100
  const p = pct(value)
  let background: string
  if (origin !== undefined) {
    const o = pct(origin)
    const a = Math.min(o, p)
    const b = Math.max(o, p)
    background = `linear-gradient(90deg, var(--slider-track) ${a}%, var(--accent) ${a}%, var(--accent) ${b}%, var(--slider-track) ${b}%)`
  } else if (hotFrom !== undefined && value > hotFrom) {
    const h = pct(hotFrom)
    background = `linear-gradient(90deg, var(--accent) ${h}%, var(--hot) ${h}%, var(--hot) ${p}%, var(--slider-track) ${p}%)`
  } else {
    background = `linear-gradient(90deg, var(--accent) ${p}%, var(--slider-track) ${p}%)`
  }
  return (
    <input
      type="range"
      className={`slider ${className}`}
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      aria-valuetext={formatValue?.(value)}
      title={formatValue ? `${label}: ${formatValue(value)}` : label}
      style={{ ...style, background }}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      onWheel={
        wheelStep
          ? (e) => {
              const next = Math.min(max, Math.max(min, value + (e.deltaY < 0 ? wheelStep : -wheelStep)))
              onChange(Math.round(next / step) * step)
            }
          : undefined
      }
    />
  )
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      className={`toggle ${props.checked ? 'is-on' : ''}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="toggle__knob" />
    </button>
  )
}

export function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  label: string
}): React.JSX.Element {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? 'is-active' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Cover(props: { path?: string; seed: string; size?: number; className?: string; rounded?: number }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [props.path])
  const style: CSSProperties = {
    width: props.size,
    height: props.size,
    borderRadius: props.rounded
  }
  if (props.path && !failed) {
    return (
      <img
        className={`cover ${props.className ?? ''}`}
        style={style}
        src={mediaUrl(props.path)}
        alt=""
        draggable={false}
        crossOrigin="anonymous"
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <div className={`cover cover--empty ${props.className ?? ''}`} style={{ ...style, background: placeholderGradient(props.seed) }}>
      <Music2 size={props.size ? Math.max(14, props.size * 0.36) : 18} />
    </div>
  )
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title} style={{ width: props.width }}>
        <header className="modal__head">
          <h2>{props.title}</h2>
          <IconButton label="Close" size="sm" onClick={props.onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="modal__body">{props.children}</div>
        {props.footer && <footer className="modal__foot">{props.footer}</footer>}
      </div>
    </div>
  )
}

export function Field(props: { label: string; hint?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <label className="field">
      <span className="field__label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field__hint">{props.hint}</span>}
    </label>
  )
}

/** Equalizer bars shown next to the playing track. */
export function PlayingBars({ paused }: { paused?: boolean }): React.JSX.Element {
  return (
    <span className={`bars ${paused ? 'is-paused' : ''}`} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}
