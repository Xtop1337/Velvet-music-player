import { Activity, AudioLines, CircleDot, Maximize, MicVocal, Minimize, Pencil, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { VisualizerMode } from '@shared/types'
import { useAutoHide } from '@renderer/hooks/useAutoHide'
import { formatRate } from '@renderer/lib/format'
import { mediaUrl } from '@renderer/lib/media'
import { trackArtist, trackTitle } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'
import { useUi } from '@renderer/store/ui'
import { LikeButton } from './LikeButton'
import { Lyrics } from './Lyrics'
import { Progress, SpeedPill, Transport, VolumeControl } from './PlayerBar'
import { Cover, IconButton } from './ui'
import { Visualizer } from './Visualizer'

const MODES: { id: VisualizerMode; icon: (size: number) => React.ReactNode }[] = [
  { id: 'bars', icon: (s) => <AudioLines size={s} /> },
  { id: 'wave', icon: (s) => <Activity size={s} /> },
  { id: 'circle', icon: (s) => <CircleDot size={s} /> },
  { id: 'particles', icon: (s) => <Sparkles size={s} /> }
]

/** Flat row of mode buttons (used in Settings). */
export function VisualizerModes(): React.JSX.Element {
  const { t } = useTranslation()
  const mode = useSettings((s) => s.settings.visualizer)
  const set = useSettings((s) => s.set)
  return (
    <div className="viz-modes" role="radiogroup" aria-label={t('visualizer.mode')}>
      {MODES.map((m) => (
        <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'is-active' : ''} title={t(`visualizer.modes.${m.id}`)} onClick={() => set({ visualizer: m.id })}>
          {m.icon(15)}
        </button>
      ))}
    </div>
  )
}

/**
 * One round button showing the current mode. Hovering it spreads a ring
 * of the modes around it; click one to switch.
 */
export function VisualizerPicker({ direction = 'up' }: { direction?: 'up' | 'down' }): React.JSX.Element {
  const { t } = useTranslation()
  const mode = useSettings((s) => s.settings.visualizer)
  const set = useSettings((s) => s.set)
  const [open, setOpen] = useState(false)
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]
  // fan the options out over an arc above (or below) the button, clear of its neighbours
  const span = 130
  const start = direction === 'up' ? 270 - span / 2 : 90 - span / 2
  return (
    <div
      className={`viz-picker viz-picker--${direction} ${open ? 'is-open' : ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}
    >
      <span className="viz-picker__ring" aria-hidden />
      {MODES.map((m, i) => {
        const angle = ((start + (i * span) / (MODES.length - 1)) * Math.PI) / 180
        const r = 70
        return (
          <button
            key={m.id}
            type="button"
            className={`viz-picker__item ${mode === m.id ? 'is-active' : ''}`}
            style={{ ['--x' as string]: `${Math.cos(angle) * r}px`, ['--y' as string]: `${Math.sin(angle) * r}px`, transitionDelay: open ? `${i * 35}ms` : '0ms' }}
            title={t(`visualizer.modes.${m.id}`)}
            aria-label={t(`visualizer.modes.${m.id}`)}
            tabIndex={open ? 0 : -1}
            onClick={() => {
              set({ visualizer: m.id })
              setOpen(false)
            }}
          >
            {m.icon(17)}
          </button>
        )
      })}
      <button
        type="button"
        className="viz-picker__main"
        aria-label={`${t('visualizer.mode')}: ${t(`visualizer.modes.${current.id}`)}`}
        title={t('visualizer.mode')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {current.icon(18)}
      </button>
    </div>
  )
}

export function NowPlaying(): React.JSX.Element | null {
  const { t } = useTranslation()
  const open = useUi((s) => s.nowPlayingOpen)
  const setOpen = useUi((s) => s.setNowPlaying)
  const editTags = useUi((s) => s.editTags)
  const currentId = usePlayer((s) => s.currentId)
  const rate = usePlayer((s) => s.rate)
  const track = useLibrary((s) => (currentId ? s.tracks[currentId] : undefined))
  const mode = useSettings((s) => s.settings.visualizer)
  const stage = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
  // the control bars fade away while the pointer is elsewhere
  const bar = useRef<HTMLDivElement>(null)
  const stageBar = useRef<HTMLDivElement>(null)
  const speedNp = useUi((s) => s.speedOpen === 'np')
  const speedFull = useUi((s) => s.speedOpen === 'full')
  const barShown = useAutoHide(bar, { active: open && !!track && !full, hold: speedNp })
  const stageShown = useAutoHide(stageBar, { active: full, hold: speedFull })
  const [tab, setTab] = useState<'visual' | 'lyrics'>(() => {
    try {
      return localStorage.getItem('velvet.npTab') === 'lyrics' ? 'lyrics' : 'visual'
    } catch {
      return 'visual'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('velvet.npTab', tab)
    } catch {
      // convenience only
    }
  }, [tab])

  // When fullscreen ends, the Esc that ended it must not also close this screen.
  // The browser may deliver that Esc before or after `fullscreenchange`, so both cases are covered:
  // fullRef is still true before the event, fullExitedAt is recent after it.
  const fullExitedAt = useRef(0)
  const fullRef = useRef(false)
  useEffect(() => {
    const onChange = (): void => {
      const isFull = !!stage.current && document.fullscreenElement === stage.current
      if (!isFull && fullRef.current) fullExitedAt.current = performance.now()
      fullRef.current = isFull
      setFull(isFull)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFull = async (): Promise<void> => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else if (useUi.getState().nowPlayingOpen) await stage.current?.requestFullscreen()
    } catch {
      // fullscreen refused (e.g. no user gesture); nothing to do
    }
  }

  // The fullscreen hotkey reaches this screen through a DOM event.
  useEffect(() => {
    const onToggle = (): void => void toggleFull()
    window.addEventListener('velvet:fullscreen', onToggle)
    return () => window.removeEventListener('velvet:fullscreen', onToggle)
  })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('.modal-scrim, .speed-panel')) return
      if (document.fullscreenElement || fullRef.current || performance.now() - fullExitedAt.current < 600) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open || !track) return null
  const cover = track.coverPath ? mediaUrl(track.coverPath) : undefined
  const bigCircle = tab === 'visual' && mode === 'circle'

  return (
    <div className="now-playing">
      <div className="now-playing__bg" style={{ backgroundImage: cover ? `url("${cover}")` : undefined }} />
      <div className="now-playing__top drag">
        <IconButton label={t('player.close')} onClick={() => setOpen(false)}>
          <X size={22} />
        </IconButton>
        <span>{t('player.nowPlaying')}</span>
        <IconButton label={t('menu.editInfo')} onClick={() => editTags(track.id)}>
          <Pencil size={18} />
        </IconButton>
      </div>

      <div className="now-playing__body">
        {bigCircle ? (
          <div className="now-playing__circle">
            <Visualizer mode="circle" coverUrl={cover} />
          </div>
        ) : (
          <Cover path={track.coverPath} seed={track.id} className="now-playing__cover" />
        )}
        <div className="now-playing__info">
          <div className="now-playing__title-row">
            <h1>{trackTitle(track, t)}</h1>
            <LikeButton trackId={track.id} size={26} className="like-btn--lg" />
          </div>
          <p className="now-playing__artist">{trackArtist(track, t)}</p>
          {track.album && <p className="now-playing__album">{track.album}</p>}
          {Math.abs(rate - 1) > 0.001 && <span className="badge badge--accent">{formatRate(rate)}</span>}
          <div className="np-toolbar no-drag">
            <div className="np-tabs" role="tablist">
              {(['visual', 'lyrics'] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>
                  {k === 'visual' ? <AudioLines size={15} /> : <MicVocal size={15} />}
                  {t(`nowPlaying.${k}`)}
                </button>
              ))}
            </div>
            {tab === 'visual' && <VisualizerPicker direction="down" />}
          </div>
          {tab === 'lyrics' ? <Lyrics track={track} /> : bigCircle ? <div className="visualizer-spacer" /> : <Visualizer mode={mode} coverUrl={cover} />}
        </div>
      </div>

      <div ref={bar} className={`np-bar no-drag ${barShown ? '' : 'is-hidden'}`}>
        <Progress />
        <div className="np-bar__row">
          <div className="np-bar__left">
            <SpeedPill anchor="np" />
          </div>
          <Transport big />
          <div className="np-bar__right">
            <VolumeControl />
            <IconButton label={t('visualizer.fullscreen')} size="sm" className="np-bar__full" onClick={() => void toggleFull()}>
              <Maximize size={18} />
            </IconButton>
          </div>
        </div>
      </div>

      {/* fullscreen stage: only shown while the browser fullscreen is active */}
      <div ref={stage} className={`viz-stage ${full ? 'is-full' : ''}`}>
        {full && (
          <>
            <div className="viz-stage__bg" style={{ backgroundImage: cover ? `url("${cover}")` : undefined }} />
            <Visualizer mode={mode} coverUrl={cover} className="viz-stage__canvas" />
            <div ref={stageBar} className="viz-stage__bottom">
              <div className="viz-stage__meta">
                <Cover path={track.coverPath} seed={track.id} size={64} rounded={12} />
                <div>
                  <strong>{trackTitle(track, t)}</strong>
                  <span>{trackArtist(track, t)}</span>
                </div>
              </div>
              <div className={`viz-stage__tools ${stageShown ? '' : 'is-hidden'}`}>
                <SpeedPill anchor="full" />
                <VolumeControl />
                <VisualizerPicker />
                <IconButton label={t('visualizer.exitFullscreen')} size="sm" onClick={() => void toggleFull()}>
                  <Minimize size={18} />
                </IconButton>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
