import { Check, Cloud, Download, Loader2, Pause, Play, Search, Youtube } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchResult, SearchSource } from '@shared/types'
import { TrackList } from '@renderer/components/TrackList'
import { Segmented } from '@renderer/components/ui'
import { engine } from '@renderer/audio/engine'
import { formatTime, placeholderGradient } from '@renderer/lib/format'
import { matchesQuery } from '@renderer/lib/tracks'
import { useImports } from '@renderer/store/imports'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'

const preview = new Audio()
preview.preload = 'none'

function remembered(): SearchSource {
  try {
    return localStorage.getItem('velvet.searchSource') === 'youtube' ? 'youtube' : 'soundcloud'
  } catch {
    return 'soundcloud'
  }
}

export function SearchPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<SearchSource>(remembered)
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState('')
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)
  const [started, setStarted] = useState<Record<string, string>>({})
  const jobs = useImports((s) => s.jobs)
  const order = useLibrary((s) => s.order)
  const tracks = useLibrary((s) => s.tracks)
  const toast = useUi((s) => s.toast)
  const seq = useRef(0)

  const local = useMemo(() => (searched ? order.filter((id) => tracks[id] && matchesQuery(tracks[id], searched)).slice(0, 5) : []), [searched, order, tracks])

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

  const run = async (q = query, src = source): Promise<void> => {
    const text = q.trim()
    if (!text) return
    const id = ++seq.current
    setLoading(true)
    setError('')
    setSearched(text)
    const res = await window.velvet.search.query(text, src)
    if (id !== seq.current) return
    setResults(res.results)
    setError(res.error ?? '')
    setLoading(false)
  }

  const togglePreview = async (r: SearchResult): Promise<void> => {
    if (previewing === r.id) {
      preview.pause()
      return
    }
    setPreviewLoading(r.id)
    try {
      const url = await window.velvet.search.preview(r.url)
      if (!engine.paused) usePlayer.getState().pause()
      preview.src = url
      preview.volume = Math.min(1, usePlayer.getState().volume)
      await preview.play()
      setPreviewing(r.id)
    } catch {
      toast(t('search.previewFailed'), 'error')
    } finally {
      setPreviewLoading(null)
    }
  }

  const download = async (r: SearchResult): Promise<void> => {
    const jobId = await useImports.getState().start(r.url)
    setStarted((s) => ({ ...s, [r.id]: jobId }))
  }

  return (
    <div className="page page--narrow">
      <header className="page-head drag">
        <div className="page-head__titles">
          <h1>{t('search.title')}</h1>
          <p>{t('search.subtitle')}</p>
        </div>
      </header>
      <form
        className="import-box"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <span className="import-box__icon">
          <Search size={20} />
        </span>
        <input className="import-box__input" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search.placeholder')} />
        <Segmented<SearchSource>
          label={t('search.source')}
          value={source}
          onChange={(v) => {
            setSource(v)
            try {
              localStorage.setItem('velvet.searchSource', v)
            } catch {
              // convenience only
            }
            if (searched) void run(searched, v)
          }}
          options={[
            { value: 'soundcloud', label: <span className="seg-icon"><Cloud size={15} /> SoundCloud</span> },
            { value: 'youtube', label: <span className="seg-icon"><Youtube size={15} /> YouTube</span> }
          ]}
        />
        <button type="submit" className="btn btn--primary" disabled={!query.trim() || loading}>
          {loading ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
          <span>{t('search.go')}</span>
        </button>
      </form>

      {local.length > 0 && (
        <>
          <h3 className="section-title">{t('search.inLibrary')}</h3>
          <TrackList ids={local} />
        </>
      )}

      {searched && <h3 className="section-title">{t('search.online', { source: source === 'soundcloud' ? 'SoundCloud' : 'YouTube' })}</h3>}
      {error && <p className="text-danger small">{t('search.error', { error: error.slice(0, 200) })}</p>}
      {loading && (
        <div className="search-results">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="search-row is-skeleton">
              <div className="search-row__art" />
              <div className="search-row__text">
                <i />
                <i />
              </div>
            </div>
          ))}
        </div>
      )}
      {!loading && searched && !error && results.length === 0 && <p className="muted">{t('search.nothing')}</p>}
      {!loading && results.length > 0 && (
        <div className="search-results">
          {results.map((r) => {
            const job = started[r.id] ? jobs.find((j) => j.jobId === started[r.id]) : undefined
            const active = job && (job.state === 'resolving' || job.state === 'downloading')
            return (
              <div key={r.id} className={`search-row ${previewing === r.id ? 'is-previewing' : ''}`}>
                <button type="button" className="search-row__art" onClick={() => void togglePreview(r)} aria-label={t('search.preview')} title={t('search.preview')}>
                  {r.thumbnail ? <img src={r.thumbnail} alt="" /> : <span style={{ background: placeholderGradient(r.id) }} />}
                  <span className="search-row__play">
                    {previewLoading === r.id ? <Loader2 size={18} className="spin" /> : previewing === r.id ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
                  </span>
                </button>
                <div className="search-row__text">
                  <strong>{r.title}</strong>
                  <span>{r.artist}</span>
                </div>
                <span className="search-row__time">{r.duration ? formatTime(r.duration) : ''}</span>
                <button type="button" className={`btn ${job?.state === 'done' ? 'btn--ghost' : 'btn--secondary'}`} disabled={!!active || job?.state === 'done'} onClick={() => void download(r)}>
                  {job?.state === 'done' ? <Check size={16} /> : active ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
                  <span>
                    {job?.state === 'done'
                      ? t('search.added')
                      : active
                        ? `${Math.round(job!.percent * 100)}%`
                        : job?.state === 'error'
                          ? t('search.retry')
                          : t('search.download')}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      )}
      {!searched && <p className="muted small">{t('search.hint')}</p>}
    </div>
  )
}
