import { Activity, AudioLines, ChevronDown, CircleDot, Maximize, MicVocal, Minimize, Pause, Pencil, Play, SkipBack, SkipForward, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { VisualizerMode } from '@shared/types'
import { formatRate } from '@renderer/lib/format'
import { mediaUrl } from '@renderer/lib/media'
import { trackArtist, trackTitle } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useSettings } from '@renderer/store/settings'
import { useUi } from '@renderer/store/ui'
import { LikeButton } from './LikeButton'
import { Lyrics } from './Lyrics'
import { Cover, IconButton } from './ui'
import { Visualizer } from './Visualizer'

const MODES: { id: VisualizerMode; icon: React.ReactNode }[] = [
  { id: 'bars', icon: <AudioLines size={15} /> },
  { id: 'wave', icon: <Activity size={15} /> },
  { id: 'circle', icon: <CircleDot size={15} /> },
  { id: 'particles', icon: <Sparkles size={15} /> }
]

export function VisualizerModes(): React.JSX.Element {
  const { t } = useTranslation()
  const mode = useSettings((s) => s.settings.visualizer)
  const set = useSettings((s) => s.set)
  return (
    <div className="viz-modes" role="radiogroup" aria-label={t('visualizer.mode')}>
      {MODES.map((m) => (
        <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'is-active' : ''} title={t(`visualizer.modes.${m.id}`)} onClick={() => set({ visualizer: m.id })}>
          {m.icon}
        </button>
      ))}
    </div>
  )
}

export function NowPlaying(): React.JSX.Element | null {
  const { t } = useTranslation()
  const open = useUi((s) => s.nowPlayingOpen)
  const setOpen = useUi((s) => s.setNowPlaying)
  const editTags = useUi((s) => s.editTags)
  const currentId = usePlayer((s) => s.currentId)
  const playing = usePlayer((s) => s.playing)
  const rate = usePlayer((s) => s.rate)
  const track = useLibrary((s) => (currentId ? s.tracks[currentId] : undefined))
  const mode = useSettings((s) => s.settings.visualizer)
  const p = usePlayer.getState()
  const stage = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
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

  useEffect(() => {
    const onChange = (): void => setFull(document.fullscreenElement === stage.current && !!stage.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.fullscreenElement) setOpen(false)
      if (e.key === 'F11' || (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement))) {
        e.preventDefault()
        void toggleFull()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const toggleFull = async (): Promise<void> => {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await stage.current?.requestFullscreen()
  }

  if (!open || !track) return null
  const cover = track.coverPath ? mediaUrl(track.coverPath) : undefined
  const bigCircle = tab === 'visual' && mode === 'circle'

  return (
    <div className="now-playing">
      <div className="now-playing__bg" style={{ backgroundImage: cover ? `url("${cover}")` : undefined }} />
      <div className="now-playing__top drag">
        <IconButton label={t('player.collapse')} onClick={() => setOpen(false)}>
          <ChevronDown size={22} />
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
            {tab === 'visual' && (
              <>
                <VisualizerModes />
                <IconButton label={t('visualizer.fullscreen')} size="sm" onClick={() => void toggleFull()}>
                  <Maximize size={16} />
                </IconButton>
              </>
            )}
          </div>
          {tab === 'lyrics' ? <Lyrics track={track} /> : bigCircle ? <div className="visualizer-spacer" /> : <Visualizer mode={mode} coverUrl={cover} />}
          <div className="now-playing__controls">
            <IconButton label={t('player.prev')} onClick={() => void p.prev()} size="lg">
              <SkipBack size={26} fill="currentColor" />
            </IconButton>
            <button type="button" className="play-btn play-btn--xl" onClick={() => void p.toggle()} aria-label={playing ? t('player.pause') : t('player.play')}>
              {playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" className="play-icon" />}
            </button>
            <IconButton label={t('player.next')} onClick={() => void p.next()} size="lg">
              <SkipForward size={26} fill="currentColor" />
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
            <div className="viz-stage__meta">
              <Cover path={track.coverPath} seed={track.id} size={64} rounded={12} />
              <div>
                <strong>{trackTitle(track, t)}</strong>
                <span>{trackArtist(track, t)}</span>
              </div>
            </div>
            <div className="viz-stage__tools">
              <VisualizerModes />
              <IconButton label={t('visualizer.exitFullscreen')} size="sm" onClick={() => void toggleFull()}>
                <Minimize size={16} />
              </IconButton>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
