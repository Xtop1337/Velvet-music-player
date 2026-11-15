import { Check, Download, Loader2, Pause, Play, Radio } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchResult, SearchSource } from '@shared/types'
import { engine } from '@renderer/audio/engine'
import { formatTime, placeholderGradient } from '@renderer/lib/format'
import { useImports } from '@renderer/store/imports'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'
import type { Layout } from './LayoutToggle'
import { RateButtons } from './RateButtons'
import { SourceIcon } from './ServiceIcons'

const preview = new Audio()
preview.preload = 'none'

/** Rows (or tiles) of songs found online: listen first, download in one click. */
export function OnlineResults(props: {
  results: SearchResult[]
  loading: boolean
  layout?: Layout
  /** a short line under the artist, by result id (e.g. why it is recommended) */
  notes?: Record<string, string>
  /** show the service mark on each row (lists that mix services) */
  showSource?: boolean
  /** download (default: import the result's link) */
  onDownload?: (r: SearchResult) => void
  /** show 👍 / 👎 on each song (ratings teach the recommendations) */
  rate?: boolean
  /** start a radio from this song */
  onRadio?: (r: SearchResult) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)
  const jobs = useImports((s) => s.jobs)
  const toast = useUi((s) => s.toast)
  const grid = props.layout === 'grid'

  useEffect(() => {
    const stop = (): void => setPreviewing(null)
    preview.addEventListener('ended', stop)
    preview.addEventListener('pause', stop)
    return () => {
      preview.removeEventListener('ended', stop)
      preview.removeEventListener('pause', stop)
      preview.pause()
    }
  }, [])

  const togglePreview = async (r: SearchResult): Promise<void> => {
    if (previewing === r.id) {
      preview.pause()
      return
    }
    setPreviewLoading(r.id)
    try {
      // a 30-second preview plays at once; otherwise the audio is looked up first
      const url = r.preview ?? (await window.velvet.search.preview({ url: r.url, title: r.title, artist: r.artist, duration: r.duration }))
      if (!engine.paused) usePlayer.getState().pause()
      preview.src = url
      preview.volume = Math.min(1, usePlayer.getState().volume)
      await preview.play()
      setPreviewing(r.id)
    } catch (e) {
      toast(String(e).includes('no-match') ? t('search.noMatch') : t('search.previewFailed'), 'error')
    } finally {
      setPreviewLoading((id) => (id === r.id ? null : id))
    }
  }

  if (props.loading) {
    return (
      <div className={grid ? 'tile-grid' : 'search-results'}>
        {Array.from({ length: grid ? 10 : 6 }, (_, i) =>
          grid ? (
            <div key={i} className="tile is-skeleton">
              <div className="tile__art" />
              <i />
              <i />
            </div>
          ) : (
            <div key={i} className="search-row is-skeleton">
              <div className="search-row__art" />
              <div className="search-row__text">
                <i />
                <i />
              </div>
            </div>
          )
        )}
      </div>
    )
  }
  if (!props.results.length) return null

  const download = (r: SearchResult): void => (props.onDownload ? props.onDownload(r) : void useImports.getState().start(r.url))

  return (
    <div className={grid ? 'tile-grid' : 'search-results'}>
      {props.results.map((r) => {
        // the newest import of this link (jobs are kept newest first)
        const job = jobs.find((j) => j.url === r.url)
        const active = job && (job.state === 'resolving' || job.state === 'downloading')
        const note = props.notes?.[r.id]
        const art = (
          <button type="button" className={grid ? 'tile__art' : 'search-row__art'} onClick={() => void togglePreview(r)} aria-label={t('search.preview')} title={t('search.preview')}>
            {r.thumbnail ? <img src={r.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span style={{ background: placeholderGradient(r.id) }} />}
            <span className={grid ? 'tile__play' : 'search-row__play'}>
              {previewLoading === r.id ? <Loader2 size={18} className="spin" /> : previewing === r.id ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </span>
          </button>
        )
        const dl = (
          <button
            type="button"
            className={grid ? `icon-btn icon-btn--sm ${job?.state === 'done' ? 'is-done' : ''}` : `btn ${job?.state === 'done' ? 'btn--ghost' : 'btn--secondary'}`}
            disabled={!!active || job?.state === 'done'}
            title={t('search.download')}
            aria-label={t('search.download')}
            onClick={() => download(r)}
          >
            {job?.state === 'done' ? <Check size={16} /> : active ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
            {!grid && (
              <span>
                {job?.state === 'done'
                  ? t('search.added')
                  : active
                    ? `${Math.round(job!.percent * 100)}%`
                    : job?.state === 'error'
                      ? t('search.retry')
                      : t('search.download')}
              </span>
            )}
          </button>
        )
        const extras = (
          <>
            {props.onRadio && (
              <button type="button" className="icon-btn icon-btn--sm" title={t('radio.fromTrack')} aria-label={t('radio.fromTrack')} onClick={() => props.onRadio!(r)}>
                <Radio size={16} />
              </button>
            )}
            {props.rate && <RateButtons song={{ artist: r.artist, title: r.title, genre: r.genre, url: r.url }} />}
          </>
        )
        if (grid) {
          return (
            <div key={r.id} className={`tile ${previewing === r.id ? 'is-previewing' : ''}`}>
              {art}
              <strong title={r.title}>{r.title}</strong>
              <span className="tile__sub" title={r.artist}>
                {props.showSource && r.source !== 'radio' && <SourceIcon source={r.source as SearchSource} size={12} />}
                {r.artist}
              </span>
              {note && <small className="tile__note">{note}</small>}
              <div className="tile__actions">
                {extras}
                {dl}
              </div>
            </div>
          )
        }
        return (
          <div key={r.id} className={`search-row ${previewing === r.id ? 'is-previewing' : ''}`}>
            {art}
            <div className="search-row__text">
              <strong>{r.title}</strong>
              <span>
                {props.showSource && r.source !== 'radio' && <SourceIcon source={r.source as SearchSource} size={12} />}
                {r.artist}
              </span>
              {note && <small className="search-row__note">{note}</small>}
            </div>
            <span className="search-row__time">{r.duration ? formatTime(r.duration) : ''}</span>
            <div className="search-row__actions">{extras}</div>
            {dl}
          </div>
        )
      })}
    </div>
  )
}
