import { Heart, Maximize2, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RemoteState } from '@shared/types'
import { Cover } from '@renderer/components/ui'
import { formatTime } from '@renderer/lib/format'

const L = {
  ru: { nothing: 'Ничего не играет', open: 'Открыть Velvet', close: 'Закрыть', play: 'Играть', pause: 'Пауза', next: 'Следующий', prev: 'Предыдущий', like: 'Избранное' },
  en: { nothing: 'Nothing playing', open: 'Open Velvet', close: 'Close', play: 'Play', pause: 'Pause', next: 'Next', prev: 'Previous', like: 'Liked' }
}

/** Always-on-top mini player. It has no audio of its own: it mirrors and controls the main window. */
export function MiniApp(): React.JSX.Element {
  const [s, setS] = useState<RemoteState | null>(null)
  const [pos, setPos] = useState(0)
  const [at, setAt] = useState(performance.now())

  useEffect(
    () =>
      window.velvet.remote.onState((next) => {
        setS(next)
        setPos(next.position)
        setAt(performance.now())
      }),
    []
  )
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = s?.theme ?? 'snow'
    root.dataset.mini = 'on'
    if (s?.accent) root.style.setProperty('--accent', s.accent)
    if (s?.onAccent) root.style.setProperty('--on-accent', s.onAccent)
  }, [s?.theme, s?.accent, s?.onAccent])

  // interpolate progress between state pushes
  const [, force] = useState(0)
  useEffect(() => {
    if (!s?.playing) return
    const id = window.setInterval(() => force((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [s?.playing])
  const position = s?.playing ? Math.min(s.duration, pos + ((performance.now() - at) / 1000) * (s.rate || 1)) : pos
  const t = L[s?.language ?? 'ru']
  const cmd = window.velvet.remote.command

  return (
    <div className="mini">
      <div className="mini__drag" />
      {s?.trackId ? <Cover path={s.coverPath} seed={s.trackId} size={84} rounded={14} className="mini__cover" /> : <div className="mini__cover mini__cover--empty" />}
      <div className="mini__body">
        <div className="mini__meta">
          <strong title={s?.title}>{s?.title || t.nothing}</strong>
          <span>{s?.artist}</span>
        </div>
        <div className="mini__controls">
          <button type="button" aria-label={t.prev} onClick={() => cmd({ cmd: 'prev' })}>
            <SkipBack size={17} fill="currentColor" />
          </button>
          <button type="button" className="mini__play" aria-label={s?.playing ? t.pause : t.play} onClick={() => cmd({ cmd: 'toggle' })}>
            {s?.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <button type="button" aria-label={t.next} onClick={() => cmd({ cmd: 'next' })}>
            <SkipForward size={17} fill="currentColor" />
          </button>
          <button type="button" className={s?.liked ? 'is-liked' : ''} aria-label={t.like} onClick={() => cmd({ cmd: 'like' })} disabled={!s?.trackId}>
            <Heart size={16} fill={s?.liked ? 'currentColor' : 'none'} />
          </button>
          <span className="mini__time">
            {formatTime(position)} / {formatTime(s?.duration ?? 0)}
          </span>
        </div>
        <div
          className="mini__bar"
          onClick={(e) => {
            if (!s?.duration) return
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            cmd({ cmd: 'seek', value: ((e.clientX - r.left) / r.width) * s.duration })
          }}
        >
          <i style={{ width: `${s?.duration ? (position / s.duration) * 100 : 0}%` }} />
        </div>
      </div>
      <div className="mini__window">
        <button type="button" aria-label={t.open} title={t.open} onClick={() => cmd({ cmd: 'show' })}>
          <Maximize2 size={14} />
        </button>
        <button type="button" aria-label={t.close} title={t.close} onClick={() => void window.velvet.remote.closeSelf()}>
          <X size={15} />
        </button>
      </div>
    </div>
  )
}
