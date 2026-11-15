import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchSource } from '@shared/types'
import { SOURCE_NAMES, SourceIcon } from './ServiceIcons'

export const SOURCES: SearchSource[] = ['soundcloud', 'youtube', 'spotify']

/** Remembered choice of a page (`key`), SoundCloud by default. */
export function rememberedSource(key: string): SearchSource {
  try {
    const v = localStorage.getItem(key)
    return SOURCES.includes(v as SearchSource) ? (v as SearchSource) : 'soundcloud'
  } catch {
    return 'soundcloud'
  }
}

export function rememberSource(key: string, v: SearchSource): void {
  try {
    localStorage.setItem(key, v)
  } catch {
    // convenience only
  }
}

/**
 * The current service with an arrow; clicking it unfolds the list of services.
 * `notes` adds a small line under a service (e.g. "needs your keys").
 */
export function SourcePicker(props: {
  value: SearchSource
  onChange: (v: SearchSource) => void
  notes?: Partial<Record<SearchSource, string>>
  align?: 'left' | 'right'
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (open) items.current[focus]?.focus()
  }, [open, focus])

  const choose = (v: SearchSource): void => {
    setOpen(false)
    if (v !== props.value) props.onChange(v)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setFocus(Math.max(0, SOURCES.indexOf(props.value)))
        setOpen(true)
      } else setFocus((f) => (f + (e.key === 'ArrowDown' ? 1 : SOURCES.length - 1)) % SOURCES.length)
    }
  }

  return (
    <div ref={root} className={`source-picker ${open ? 'is-open' : ''}`} onKeyDown={onKey}>
      <button
        type="button"
        className="source-picker__btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${t('search.source')}: ${SOURCE_NAMES[props.value]}`}
        title={t('search.source')}
        onClick={() => {
          setFocus(Math.max(0, SOURCES.indexOf(props.value)))
          setOpen(!open)
        }}
      >
        <SourceIcon source={props.value} />
        <span>{SOURCE_NAMES[props.value]}</span>
        <ChevronDown size={16} className="source-picker__chev" />
      </button>
      {open && (
        <div className={`source-picker__menu source-picker__menu--${props.align ?? 'right'}`} role="listbox" aria-label={t('search.source')}>
          {SOURCES.map((s, i) => (
            <button
              key={s}
              ref={(el) => {
                items.current[i] = el
              }}
              type="button"
              role="option"
              aria-selected={s === props.value}
              className={`source-picker__item ${s === props.value ? 'is-active' : ''}`}
              onClick={() => choose(s)}
            >
              <SourceIcon source={s} size={18} />
              <span className="source-picker__text">
                <strong>{SOURCE_NAMES[s]}</strong>
                {props.notes?.[s] && <small>{props.notes[s]}</small>}
              </span>
              {s === props.value && <Check size={16} className="source-picker__check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
