import {
  AudioLines,
  ChevronUp,
  ListMusic,
  PictureInPicture2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume,
  Volume1,
  Volume2,
  VolumeX
} from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { VOLUME_MAX } from '@shared/defaults'
import { engine } from '@renderer/audio/engine'
import { formatRate, formatTime } from '@renderer/lib/format'
import { presetLabel, trackArtist, trackTitle } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { allPresets, usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'
import { LikeButton } from './LikeButton'
import { SpeedPanel } from './SpeedPanel'
import { Cover, IconButton, Slider } from './ui'

/**
 * Progress bar. The position is written straight into the DOM from the audio element's own
 * `timeupdate` events (~4 per second while playing, none while paused). The fill moves about a
 * pixel per update, which looks continuous; a 60 fps animation here would force the glass
 * player bar to re-blur its background every frame.
 */
export function Progress(): React.JSX.Element {
  const duration = usePlayer((s) => s.duration)
  const currentId = usePlayer((s) => s.currentId)
  const seek = usePlayer((s) => s.seek)
  const input = useRef<HTMLInputElement>(null)
  const fill = useRef<HTMLDivElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  const dragging = useRef(false)
  const max = duration || 1

  const paint = useCallback((sec: number) => {
    const d = usePlayer.getState().duration || engine.duration || 1
    const p = Math.min(1, Math.max(0, sec / d))
    if (fill.current) fill.current.style.transform = `scaleX(${p.toFixed(4)})`
    if (input.current && !dragging.current) input.current.value = String(Math.min(sec, d))
    if (time.current) time.current.textContent = formatTime(sec)
  }, [])

  useEffect(() => {
    const now = (): void => {
      if (!dragging.current) paint(engine.currentTime)
    }
    now()
    const offs = ['timeupdate', 'seeked', 'durationchange', 'loadedmetadata'].map((ev) => engine.on(ev, now))
    return () => offs.forEach((off) => off())
  }, [paint, currentId, duration])

  const commit = (v: number): void => {
    dragging.current = false
    seek(v)
    paint(v)
  }

  return (
    <div className="progress">
      <span className="progress__time" ref={time}>
        0:00
      </span>
      <div className="progress__bar">
        <div className="progress__track">
          <div className="progress__fill" ref={fill} />
        </div>
        <input
          ref={input}
          type="range"
          className="progress__input"
          aria-label="Seek"
          min={0}
          max={max}
          step={0.1}
          defaultValue={0}
          onInput={(e) => {
            dragging.current = true
            const v = Number((e.target as HTMLInputElement).value)
            if (fill.current) fill.current.style.transform = `scaleX(${Math.min(1, v / max)})`
            if (time.current) time.current.textContent = formatTime(v)
          }}
          onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        />
      </div>
      <span className="progress__time">{formatTime(duration)}</span>
    </div>
  )
}

export function VolumeControl(): React.JSX.Element {
  const { t } = useTranslation()
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)
  const v = muted ? 0 : volume
  const pct = Math.round(v * 100)
  const Icon = v === 0 ? VolumeX : v < 0.35 ? Volume : v < 0.9 ? Volume1 : Volume2

  return (
    <div className="volume" title={t('player.volumeHint')}>
      <IconButton label={muted ? t('player.unmute') : t('player.mute')} onClick={toggleMute} size="sm">
        <Icon size={19} />
      </IconButton>
      <Slider
        className="slider--volume"
        label={t('player.volume')}
        min={0}
        max={VOLUME_MAX}
        step={0.01}
        value={v}
        hotFrom={1}
        wheelStep={0.05}
        onChange={setVolume}
        formatValue={(x) => `${Math.round(x * 100)}%`}
      />
      <button
        type="button"
        className={`volume__pct ${v > 1 ? 'is-hot' : ''}`}
        onClick={() => setVolume(1)}
        aria-label={`${t('player.volume')} ${pct}%`}
      >
        {pct}%
      </button>
    </div>
  )
}

export function SpeedPill({ anchor = 'bar' }: { anchor?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const rate = usePlayer((s) => s.rate)
  const presetId = usePlayer((s) => s.activePresetId)
  const preservesPitch = usePlayer((s) => s.preservesPitch)
  const open = useUi((s) => s.speedOpen === anchor)
  const setSpeed = useUi((s) => s.setSpeed)
  const setOpen = (v: boolean): void => setSpeed(v ? anchor : null)
  const preset = allPresets().find((p) => p.id === presetId)
  const changed = Math.abs(rate - 1) > 0.001 || (presetId !== 'normal' && presetId !== '')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.menu-layer, .modal-scrim')) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <div className="speed-anchor" ref={ref}>
      <button
        type="button"
        className={`speed-pill ${changed ? 'is-changed' : ''} ${open ? 'is-open' : ''}`}
        onClick={() => setOpen(!open)}
        title={t('player.speed')}
        aria-expanded={open}
      >
        <span className="speed-pill__rate">{formatRate(rate)}</span>
        <span className="speed-pill__preset">
          {preset ? presetLabel(preset, t) : t('speed.custom')}
          {!preservesPitch && <i className="speed-pill__dot" title={t('speed.autoPitchOff')} />}
        </span>
        <ChevronUp size={14} className="speed-pill__chev" />
      </button>
      {open && <SpeedPanel />}
    </div>
  )
}

export function Transport({ big = false }: { big?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const playing = usePlayer((s) => s.playing)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const p = usePlayer.getState()
  return (
    <div className={`player__controls ${big ? 'player__controls--big' : ''}`}>
      <IconButton label={t('player.shuffle')} active={shuffle} onClick={() => p.setShuffle(!shuffle)} size="sm">
        <Shuffle size={18} />
      </IconButton>
      <IconButton label={t('player.prev')} onClick={() => void p.prev()} size={big ? 'lg' : 'md'}>
        <SkipBack size={big ? 24 : 20} fill="currentColor" />
      </IconButton>
      <button type="button" className={`play-btn ${big ? 'play-btn--big' : ''}`} onClick={() => void p.toggle()} aria-label={playing ? t('player.pause') : t('player.play')}>
        {playing ? <Pause size={big ? 26 : 22} fill="currentColor" /> : <Play size={big ? 26 : 22} fill="currentColor" className="play-icon" />}
      </button>
      <IconButton label={t('player.next')} onClick={() => void p.next()} size={big ? 'lg' : 'md'}>
        <SkipForward size={big ? 24 : 20} fill="currentColor" />
      </IconButton>
      <IconButton
        label={repeat === 'one' ? t('player.repeatOne') : repeat === 'all' ? t('player.repeatAll') : t('player.repeatOff')}
        active={repeat !== 'off'}
        onClick={p.cycleRepeat}
        size="sm"
      >
        {repeat === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}
      </IconButton>
    </div>
  )
}

export function PlayerBar(): React.JSX.Element {
  const { t } = useTranslation()
  const currentId = usePlayer((s) => s.currentId)
  const track = useLibrary((s) => (currentId ? s.tracks[currentId] : undefined))
  const queueOpen = useUi((s) => s.queueOpen)
  const setQueue = useUi((s) => s.setQueue)
  const setNowPlaying = useUi((s) => s.setNowPlaying)

  return (
    <footer className="player">
      <div className="player__track">
        {track ? (
          <>
            <div className="player__cover">
              <Cover path={track.coverPath} seed={track.id} size={58} rounded={12} />
            </div>
            <div className="player__meta">
              <span className="player__title" title={trackTitle(track, t)}>
                {trackTitle(track, t)}
              </span>
              <span className="player__artist">{trackArtist(track, t)}</span>
            </div>
            <LikeButton trackId={track.id} />
          </>
        ) : (
          <div className="player__meta player__meta--empty">
            <span className="player__title">{t('player.nothing')}</span>
            <span className="player__artist">{t('player.nothingHint')}</span>
          </div>
        )}
      </div>

      <div className="player__center">
        <Transport />
        <div className="player__timeline">
          <SpeedPill />
          <Progress />
        </div>
      </div>

      <div className="player__right">
        <IconButton label={t('player.visualizer')} onClick={() => setNowPlaying(true)} size="sm" disabled={!track}>
          <AudioLines size={19} />
        </IconButton>
        <IconButton label={t('player.mini')} onClick={() => void window.velvet.remote.toggleMini()} size="sm">
          <PictureInPicture2 size={18} />
        </IconButton>
        <IconButton label={t('player.queue')} active={queueOpen} onClick={() => setQueue(!queueOpen)} size="sm">
          <ListMusic size={19} />
        </IconButton>
        <VolumeControl />
      </div>
    </footer>
  )
}
