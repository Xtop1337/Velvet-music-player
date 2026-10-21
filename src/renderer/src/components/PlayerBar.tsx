import {
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
import { useEffect, useRef, useState } from 'react'
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

/** Progress bar that follows the audio element at display refresh rate. */
function Progress(): React.JSX.Element {
  const duration = usePlayer((s) => s.duration)
  const seek = usePlayer((s) => s.seek)
  const [pos, setPos] = useState(0)
  const [drag, setDrag] = useState<number | null>(null)

  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      setPos(engine.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const shown = drag ?? pos
  const max = duration || 1
  return (
    <div className="progress">
      <span className="progress__time">{formatTime(shown)}</span>
      <Slider
        className="slider--progress"
        label="Seek"
        min={0}
        max={max}
        step={0.1}
        value={Math.min(shown, max)}
        onChange={(v) => setDrag(v)}
        onCommit={(v) => {
          seek(v)
          setDrag(null)
        }}
        formatValue={formatTime}
      />
      <span className="progress__time">{formatTime(duration)}</span>
    </div>
  )
}

function VolumeControl(): React.JSX.Element {
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

function SpeedPill(): React.JSX.Element {
  const { t } = useTranslation()
  const rate = usePlayer((s) => s.rate)
  const presetId = usePlayer((s) => s.activePresetId)
  const preservesPitch = usePlayer((s) => s.preservesPitch)
  const open = useUi((s) => s.speedOpen)
  const setOpen = useUi((s) => s.setSpeed)
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
  }, [open, setOpen])

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

export function PlayerBar(): React.JSX.Element {
  const { t } = useTranslation()
  const currentId = usePlayer((s) => s.currentId)
  const track = useLibrary((s) => (currentId ? s.tracks[currentId] : undefined))
  const playing = usePlayer((s) => s.playing)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const p = usePlayer.getState()
  const queueOpen = useUi((s) => s.queueOpen)
  const setQueue = useUi((s) => s.setQueue)
  const setNowPlaying = useUi((s) => s.setNowPlaying)

  return (
    <footer className="player">
      <div className="player__track">
        {track ? (
          <>
            <button type="button" className="player__cover" onClick={() => setNowPlaying(true)} title={t('player.expand')}>
              <Cover path={track.coverPath} seed={track.id} size={58} rounded={12} />
              <span className="player__cover-hint">
                <ChevronUp size={18} />
              </span>
            </button>
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
        <div className="player__controls">
          <IconButton label={t('player.shuffle')} active={shuffle} onClick={() => p.setShuffle(!shuffle)} size="sm">
            <Shuffle size={18} />
          </IconButton>
          <IconButton label={t('player.prev')} onClick={() => void p.prev()}>
            <SkipBack size={20} fill="currentColor" />
          </IconButton>
          <button type="button" className="play-btn" onClick={() => void p.toggle()} aria-label={playing ? t('player.pause') : t('player.play')}>
            {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" className="play-icon" />}
          </button>
          <IconButton label={t('player.next')} onClick={() => void p.next()}>
            <SkipForward size={20} fill="currentColor" />
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
        <div className="player__timeline">
          <SpeedPill />
          <Progress />
        </div>
      </div>

      <div className="player__right">
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
