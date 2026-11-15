import { Loader2, Minus, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activeLine, estimateTimes, isSpeedVersion, lineProgress, parseLrc, scaleLines, singingPace, stretchFactor, wordTimings, type TimedWord } from '@shared/lrc'
import type { LyricsResult, Track } from '@shared/types'
import { engine } from '@renderer/audio/engine'
import { useLibrary } from '@renderer/store/library'
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
const WORDS_KEY = 'velvet.lyricsWords'

function rememberedWords(): boolean {
  try {
    return localStorage.getItem(WORDS_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * Apple-Music-style lyrics: only a few lines around the current one are shown, the column glides
 * to the active line, and the line lights up as it is sung — word by word ("By words", on by
 * default) or as one smooth fill. The highlight follows what is *heard* (the audio output's
 * latency is taken into account), lyrics of slowed / sped-up versions are stretched to the file,
 * and a manual shift is kept per track. Unsynced lyrics get estimated timings so they scroll too.
 */
export function Lyrics({ track }: { track: Track }): React.JSX.Element {
  const { t } = useTranslation()
  const { result, loading, reload } = useLyrics(track)
  const duration = usePlayer((s) => s.duration) || track.duration
  const [byWords, setByWords] = useState(rememberedWords)
  const offset = track.lyricsOffset ?? 0
  const parsed = useMemo(() => parseLrc(result?.synced || result?.plain || ''), [result])
  // a slowed / sped-up file of a song timed at its original speed: stretch the timestamps to fit
  const speedVersion = isSpeedVersion(`${track.title} ${track.album}`)
  const stretchOn = track.lyricsStretch ?? speedVersion
  const lengthsDiffer = !!result?.duration && duration > 0 && Math.abs(duration / result.duration - 1) > 0.02
  const stretch = parsed.synced ? stretchFactor(duration, result?.duration, stretchOn) : 1
  const lines = useMemo(
    () => (parsed.synced ? scaleLines(parsed.lines, stretch) : estimateTimes(parsed.lines, duration)),
    [parsed, duration, stretch]
  )
  const pace = useMemo(() => (parsed.synced ? singingPace(lines) : 0), [parsed.synced, lines])
  const words = useMemo(() => (parsed.synced && byWords ? lines.map((_, i) => wordTimings(lines, i, duration, pace)) : null), [parsed.synced, byWords, lines, duration, pace])
  const playing = usePlayer((s) => s.playing)
  const [active, setActive] = useState(-1)
  const box = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)

  // lyrics cached before the original's length was kept: look a slowed version up once more
  const refetched = useRef('')
  useEffect(() => {
    if (speedVersion && result?.source === 'lrclib' && result.synced && result.duration === undefined && refetched.current !== track.id) {
      refetched.current = track.id
      reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, speedVersion, track.id])

  // follow the playback position; the fill is written straight to the DOM
  useEffect(() => {
    if (!lines.length) return
    let raf = 0
    let last = -2
    let spans: HTMLElement[] = []
    const paint = (): number => {
      const time = engine.heardTime - offset
      const i = activeLine(lines, time)
      const lineChanged = i !== last
      if (lineChanged) {
        last = i
        setActive(i)
        spans = []
      }
      const el = column.current?.querySelector<HTMLElement>(`[data-line="${i}"]`)
      if (!el) return i
      const timed: TimedWord[] | undefined = words?.[i]
      if (timed?.length) {
        // React renders the word spans right after the line becomes active
        if (!spans.length) spans = [...el.querySelectorAll<HTMLElement>('.lyrics__word')]
        for (let k = 0; k < spans.length && k < timed.length; k++) {
          const w = timed[k]
          const fill = time >= w.end ? 100 : time <= w.start ? 0 : ((time - w.start) / (w.end - w.start)) * 100
          const v = `${fill.toFixed(0)}%`
          if (spans[k].dataset.fill !== v) {
            spans[k].dataset.fill = v
            spans[k].style.setProperty('--fill', v)
          }
        }
      } else {
        el.style.setProperty('--fill', `${(lineProgress(lines, i, time, duration, pace || undefined) * 100).toFixed(1)}%`)
      }
      return i
    }
    if (!playing) {
      // paused: place the highlight once instead of running a loop (twice: the spans render after the line is set)
      paint()
      const again = window.setTimeout(paint, 60)
      return () => clearTimeout(again)
    }
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      paint()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [lines, duration, playing, words, pace, offset])

  // glide the column so the active line sits a third of the way down
  useLayoutEffect(() => {
    const b = box.current
    const col = column.current
    if (!b || !col) return
    const el = col.querySelector<HTMLElement>(`[data-line="${Math.max(0, active)}"]`)
    if (!el) return
    const y = el.offsetTop - b.clientHeight * 0.32 + el.offsetHeight / 2
    col.style.transform = `translateY(${-Math.max(0, y)}px)`
  }, [active, lines, byWords])

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

  const shift = (d: number): void => {
    const next = Math.round((offset + d) * 10) / 10
    useLibrary.getState().updateTrack(track.id, { lyricsOffset: Math.abs(next) < 0.05 ? undefined : Math.max(-15, Math.min(15, next)) })
  }
  const toggleWords = (): void => {
    const on = !byWords
    setByWords(on)
    try {
      localStorage.setItem(WORDS_KEY, on ? 'on' : 'off')
    } catch {
      // a convenience only
    }
  }

  return (
    <div className="lyrics-wrap">
      <div className={`lyrics ${parsed.synced ? 'is-synced' : 'is-estimated'} ${words ? 'is-words' : ''}`} ref={box}>
        <div className="lyrics__column" ref={column}>
          {lines.map((l, i) => {
            const d = i - Math.max(0, active)
            const visible = d >= -BEFORE && d <= AFTER
            const blank = !l.text.trim()
            const timed = i === active ? words?.[i] : undefined
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
                onClick={() => usePlayer.getState().seek(Math.max(0, (l.time ?? 0) + offset))}
              >
                {blank ? (
                  <span className="lyrics__dots" aria-label="♪">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : timed?.length ? (
                  // the active line, word by word
                  <span className="lyrics__words">
                    {timed.map((w, k) => (
                      <span key={k} className="lyrics__word">
                        {w.text}{' '}
                      </span>
                    ))}
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
          {stretch !== 1 && ` · ${t('lyrics.stretched', { percent: Math.round(stretch * 100) })}`}
        </span>
        <span className="lyrics__tools">
          {parsed.synced && (
            <>
              <button type="button" className={`lyrics__chip ${byWords ? 'is-on' : ''}`} aria-pressed={byWords} onClick={toggleWords} title={t('lyrics.byWordsHint')}>
                {t('lyrics.byWords')}
              </button>
              {lengthsDiffer && (
                <button
                  type="button"
                  className={`lyrics__chip ${stretch !== 1 ? 'is-on' : ''}`}
                  aria-pressed={stretch !== 1}
                  title={t('lyrics.stretchHint')}
                  onClick={() => useLibrary.getState().updateTrack(track.id, { lyricsStretch: !stretchOn })}
                >
                  {t('lyrics.stretch')}
                </button>
              )}
              <span className="lyrics__offset" title={t('lyrics.offsetHint')}>
                <button type="button" className="icon-btn icon-btn--sm" aria-label={t('lyrics.earlier')} title={t('lyrics.earlier')} onClick={() => shift(-0.1)}>
                  <Minus size={13} />
                </button>
                <button type="button" className="lyrics__offset-value" onClick={() => shift(-offset)} title={t('lyrics.offsetReset')}>
                  {offset > 0 ? '+' : ''}
                  {offset.toFixed(1)} {t('lyrics.sec')}
                </button>
                <button type="button" className="icon-btn icon-btn--sm" aria-label={t('lyrics.later')} title={t('lyrics.later')} onClick={() => shift(0.1)}>
                  <Plus size={13} />
                </button>
              </span>
            </>
          )}
          {result?.source !== 'user' && (
            <button type="button" className="link-btn" onClick={reload} title={t('lyrics.findAgain')}>
              <RefreshCw size={12} /> {t('lyrics.findAgain')}
            </button>
          )}
        </span>
      </div>
    </div>
  )
}
