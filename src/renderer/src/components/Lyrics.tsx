import { Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activeLine, parseLrc } from '@shared/lrc'
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
  return { result, loading, reload: () => setNonce((n) => n + 1) }
}

export function Lyrics({ track }: { track: Track }): React.JSX.Element {
  const { t } = useTranslation()
  const { result, loading, reload } = useLyrics(track)
  const parsed = useMemo(() => parseLrc(result?.synced || result?.plain || ''), [result])
  const [active, setActive] = useState(-1)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!parsed.synced) return
    let raf = 0
    const tick = (): void => {
      // a tiny lead so the highlight lands with the voice, not after it
      const i = activeLine(parsed.lines, engine.currentTime + 0.15)
      setActive((prev) => (prev === i ? prev : i))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [parsed])

  useEffect(() => {
    const b = box.current
    const el = b?.querySelector<HTMLElement>(`[data-line="${active}"]`)
    // scroll only the lyrics box (scrollIntoView would also scroll the whole screen)
    if (b && el) b.scrollTo({ top: el.offsetTop - b.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' })
  }, [active])

  if (loading) {
    return (
      <div className="lyrics lyrics--state">
        <Loader2 size={22} className="spin" />
      </div>
    )
  }
  if (!parsed.lines.length) {
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
    <div className={`lyrics ${parsed.synced ? 'is-synced' : ''}`} ref={box}>
      {parsed.lines.map((l, i) =>
        parsed.synced ? (
          <button
            key={i}
            type="button"
            data-line={i}
            className={`lyrics__line ${i === active ? 'is-active' : ''} ${i < active ? 'is-past' : ''}`}
            onClick={() => usePlayer.getState().seek(l.time ?? 0)}
          >
            {l.text || '♪'}
          </button>
        ) : (
          <p key={i} className="lyrics__line lyrics__line--plain">
            {l.text || ' '}
          </p>
        )
      )}
      <p className="lyrics__source">{t(`lyrics.source.${result?.source ?? 'none'}`)}</p>
    </div>
  )
}
