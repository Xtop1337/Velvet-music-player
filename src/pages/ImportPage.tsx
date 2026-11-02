import { CheckCircle2, ClipboardPaste, Cloud, Download, Link2, Loader2, RefreshCw, X, XCircle, Youtube } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseMusicLink } from '@shared/links'
import type { ImportProgress } from '@shared/types'
import { Button } from '@renderer/components/ui'
import { useImports } from '@renderer/store/imports'
import { useLibrary } from '@renderer/store/library'
import { useUi } from '@renderer/store/ui'

function SpotifyLogo({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="12" fill="#1DB954" />
      <path d="M6.3 9.2c3.9-1.1 8.2-.8 11.6 1.1M7 12.6c3.2-.9 6.6-.6 9.4 1M7.7 15.8c2.5-.7 5.1-.5 7.3.8" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  )
}

function JobCard({ job }: { job: ImportProgress }): React.JSX.Element {
  const { t } = useTranslation()
  const cancel = useImports((s) => s.cancel)
  const playlists = useLibrary((s) => s.playlists)
  const navigate = useUi((s) => s.navigate)
  const active = job.state === 'resolving' || job.state === 'downloading'
  const overall = job.total ? (job.completed + job.failed + (active ? job.percent : 0)) / job.total : 0
  const pl = job.kind !== 'track' && job.title ? playlists.find((p) => p.name === job.title && p.trackIds.some((id) => job.trackIds.includes(id))) : undefined
  const err = job.error ? t(`import.errors.${job.error}`, { defaultValue: job.error }) : ''

  return (
    <div className={`job job--${job.state}`}>
      <div className="job__icon">
        {active ? <Loader2 size={20} className="spin" /> : job.state === 'done' ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
      </div>
      <div className="job__body">
        <div className="job__title">
          <strong>{job.title || job.url}</strong>
          <span className="job__state">{t(`import.states.${job.state}`)}</span>
        </div>
        {job.total > 0 && (
          <div className="job__meta">
            {t('import.progress', { completed: job.completed, total: job.total })}
            {job.failed > 0 && <span className="job__failed"> · {t('import.failed', { count: job.failed })}</span>}
            {active && job.current && <span className="job__current"> · {job.current}</span>}
          </div>
        )}
        {(job.state === 'error' || (job.failed > 0 && !active)) && err && <div className="job__error">{err}</div>}
        {(active || job.total > 0) && (
          <div className="job__bar">
            <i style={{ width: `${Math.round((job.state === 'done' ? 1 : overall) * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="job__actions">
        {active && (
          <Button variant="ghost" icon={<X size={16} />} onClick={() => cancel(job.jobId)}>
            {t('import.cancel')}
          </Button>
        )}
        {pl && !active && (
          <Button variant="secondary" onClick={() => navigate({ type: 'playlist', id: pl.id })}>
            {t('import.openPlaylist')}
          </Button>
        )}
      </div>
    </div>
  )
}

export function ImportPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const jobs = useImports((s) => s.jobs)
  const ytdlp = useImports((s) => s.ytdlp)
  const installing = useImports((s) => s.installing)
  const { start, clearFinished, refreshYtdlp, installYtdlp } = useImports.getState()
  const toast = useUi((s) => s.toast)
  const link = useMemo(() => parseMusicLink(url), [url])

  useEffect(() => {
    void refreshYtdlp()
  }, [refreshYtdlp])

  const submit = async (): Promise<void> => {
    if (!link) return
    await start(link.url)
    setUrl('')
  }

  const install = async (): Promise<void> => {
    try {
      await installYtdlp()
      const s = useImports.getState().ytdlp
      if (s?.version) toast(t('import.ytdlp.updated', { version: s.version }), 'success')
    } catch (e) {
      toast(t('import.ytdlp.failed', { error: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  const ServiceIcon = link?.service === 'spotify' ? SpotifyLogo : link?.service === 'soundcloud' ? Cloud : link?.service === 'youtube' ? Youtube : Link2

  return (
    <div className="page page--narrow">
      <header className="page-head drag">
        <div className="page-head__titles">
          <h1>{t('import.title')}</h1>
          <p>{t('import.subtitle')}</p>
        </div>
      </header>

      <form
        className={`import-box ${link ? `is-${link.service}` : ''}`}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <span className="import-box__icon">
          <ServiceIcon size={20} />
        </span>
        <input className="import-box__input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('import.placeholder')} spellCheck={false} />
        <button
          type="button"
          className="btn btn--ghost"
          onClick={async () => {
            try {
              setUrl((await navigator.clipboard.readText()).trim())
            } catch {
              // clipboard permission denied
            }
          }}
        >
          <ClipboardPaste size={16} />
          <span>{t('import.paste')}</span>
        </button>
        <button type="submit" className="btn btn--primary" disabled={!link}>
          <Download size={16} />
          <span>{t('import.start')}</span>
        </button>
      </form>
      <div className="import-hint">
        {url && !link && <span className="text-danger">{t('import.unsupported')}</span>}
        {link && <span className="badge badge--accent">{t(`import.detected.${link.service}`, { kind: t(`import.kinds.${link.kind}`) })}</span>}
        {link?.service === 'spotify' && <p className="muted">{t('import.spotifyNote')}</p>}
      </div>

      <div className="services">
        <span className="muted">{t('import.services')}:</span>
        <span className="service">
          <Cloud size={16} /> SoundCloud
        </span>
        <span className="service">
          <SpotifyLogo size={16} /> Spotify
        </span>
        <span className="service">
          <Youtube size={16} /> YouTube
        </span>
      </div>

      <section className="card">
        <div className="card__head">
          <h3>{t('import.jobs')}</h3>
          {jobs.some((j) => j.state !== 'resolving' && j.state !== 'downloading') && (
            <button type="button" className="link-btn" onClick={clearFinished}>
              {t('import.clear')}
            </button>
          )}
        </div>
        {jobs.length === 0 ? <p className="muted">{t('import.noJobs')}</p> : jobs.map((j) => <JobCard key={j.jobId} job={j} />)}
      </section>

      <section className="card card--row">
        <div>
          <strong>{t('import.ytdlp.title')}</strong>
          <p className="muted">{ytdlp?.installed ? t('import.ytdlp.installed', { version: ytdlp.version }) : t('import.ytdlp.missing')}</p>
        </div>
        <Button icon={<RefreshCw size={16} className={installing ? 'spin' : ''} />} onClick={() => void install()} disabled={installing}>
          {installing ? t('import.ytdlp.installing') : ytdlp?.installed ? t('import.ytdlp.update') : t('import.ytdlp.install')}
        </Button>
      </section>
      <p className="muted small">{t('import.legal')}</p>
    </div>
  )
}
