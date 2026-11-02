import { Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activeLine, estimateTimes, lineProgress, parseLrc } from '@shared/lrc'
import type { LyricsResult, Track } from '@shared/types'
import { engine } from '@renderer/audio/engine'
import { usePlayer } from '@renderer/store/player'

const memo = new Map<string, LyricsResult>()

export function useLyrics(track: Track | undefined): { result: LyricsResult | null; loading: boolean; reload: () => void } {
  const [result, setResult] = useState<LyricsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!track) return setResult(null)
    if (track.lyrics?.trim()) return setResult({ synced: track.lyrics, source: 'user' })
    const hit = nonce === 0 ? memo.get(track.id) : undefined
    if (hit) return setResult(hit)
    let alive = true
    setLoading(true)
    setResult(null)
    void window.velvet.lyrics
      .get({ trackId: track.id, path: track.path, title: track.title, artist: track.artist, album: track.album, duration: track.duration, force: nonce > 0 })
      .then((r) => {
        if (!r.error) memo.set(track.id, r)
        if (alive) setResult(r)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [track?.id, track?.lyrics, track?.title, track?.artist, nonce])
  return {
    result,
    loading,
    reload: () => {
      if (track) memo.delete(track.id)
      setNonce((n) => n + 1)
    }
  }
}

/** How many lines around the current one stay visible. */
const BEFORE = 1
const AFTER = 3

/**
 * Apple-Music-style lyrics: only a few lines around the current one are shown,
 * the column glides to the active line and the line fills in as it is sung.
 * Unsynced lyrics get estimated timings so they scroll with the song too.
 */
export function Lyrics({ track }: { track: Track }): React.JSX.Element {
  const { t } = useTranslation()
  const { result, loading, reload } = useLyrics(track)
  const duration = usePlayer((s) => s.duration) || track.duration
  const parsed = useMemo(() => parseLrc(result?.synced || result?.plain || ''), [result])
  const lines = useMemo(() => (parsed.synced ? parsed.lines : estimateTimes(parsed.lines, duration)), [parsed, duration])
  const playing = usePlayer((s) => s.playing)
  const [active, setActive] = useState(-1)
  const box = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)

  // follow the playback position; the fill of the active line is written straight to the DOM
  useEffect(() => {
    if (!lines.length) return
    let raf = 0
    let last = -2
    if (!playing) {
      // paused: place the highlight once instead of running a loop
      const i = activeLine(lines, engine.currentTime + 0.15)
      setActive(i)
      const el = column.current?.querySelector<HTMLElement>(`[data-line="${i}"]`)
      el?.style.setProperty('--fill', `${(lineProgress(lines, i, engine.currentTime + 0.15, duration) * 100).toFixed(1)}%`)
      return
    }
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      // a tiny lead so the highlight lands with the voice, not after it
      const time = engine.currentTime + 0.15
      const i = activeLine(lines, time)
      if (i !== last) {
        last = i
        setActive(i)
      }
      const el = column.current?.querySelector<HTMLElement>(`[data-line="${i}"]`)
      if (el) el.style.setProperty('--fill', `${(lineProgress(lines, i, time, duration) * 100).toFixed(1)}%`)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [lines, duration, playing])

  // glide the column so the active line sits a third of the way down
  useLayoutEffect(() => {
    const b = box.current
    const col = column.current
    if (!b || !col) return
    const el = col.querySelector<HTMLElement>(`[data-line="${Math.max(0, active)}"]`)
    if (!el) return
    const y = el.offsetTop - b.clientHeight * 0.32 + el.offsetHeight / 2
    col.style.transform = `translateY(${-Math.max(0, y)}px)`
  }, [active, lines])

  if (loading) {
    return (
      <div className="lyrics lyrics--state">
        <Loader2 size={22} className="spin" />
        <span>{t('lyrics.searching')}</span>
      </div>
    )
  }
  if (!lines.length) {
    return (
      <div className="lyrics lyrics--state">
        <p>{result?.instrumental ? t('lyrics.instrumental') : result?.error ? t('lyrics.offline') : t('lyrics.notFound')}</p>
        <button type="button" className="link-btn" onClick={reload}>
          <RefreshCw size={14} /> {t('lyrics.retry')}
        </button>
      </div>
    )
  }

  return (
    <div className="lyrics-wrap">
      <div className={`lyrics ${parsed.synced ? 'is-synced' : 'is-estimated'}`} ref={box}>
        <div className="lyrics__column" ref={column}>
          {lines.map((l, i) => {
            const d = i - Math.max(0, active)
            const visible = d >= -BEFORE && d <= AFTER
            const blank = !l.text.trim()
            return (
              <button
                key={i}
                type="button"
                data-line={i}
                tabIndex={visible ? 0 : -1}
                className={`lyrics__line ${i === active ? 'is-active' : ''} ${d < 0 ? 'is-past' : ''} ${blank ? 'is-break' : ''}`}
                style={{
                  ['--d' as string]: Math.abs(d),
                  opacity: !visible ? 0 : i === active ? 1 : d < 0 ? 0.32 : Math.max(0.18, 0.62 - (d - 1) * 0.16)
                }}
                onClick={() => usePlayer.getState().seek(l.time ?? 0)}
              >
                {blank ? (
                  <span className="lyrics__dots" aria-label="♪">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <span className="lyrics__text" data-text={l.text}>
                    {l.text}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
      <div className="lyrics__foot">
        <span>
          {t(`lyrics.source.${result?.source ?? 'none'}`)}
          {!parsed.synced && ` · ${t('lyrics.estimated')}`}
        </span>
        {result?.source !== 'user' && (
          <button type="button" className="link-btn" onClick={reload} title={t('lyrics.findAgain')}>
            <RefreshCw size={12} /> {t('lyrics.findAgain')}
          </button>
        )}
      </div>
    </div>
  )
}
