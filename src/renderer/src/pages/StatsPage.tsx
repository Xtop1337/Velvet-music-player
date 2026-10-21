import { Clock3, Disc3, Headphones, Mic2, Play, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart } from '@renderer/components/BarChart'
import { Button, Cover, Segmented } from '@renderer/components/ui'
import { summarize, type Period } from '@renderer/lib/stats'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useStats } from '@renderer/store/stats'
import { useUi } from '@renderer/store/ui'

function hoursMinutes(sec: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h ? t('stats.hm', { h, m }) : t('stats.m', { m })
}

export function StatsPage(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [period, setPeriod] = useState<Period>('30d')
  const history = useStats((s) => s.history)
  const tracks = useLibrary((s) => s.tracks)
  const navigate = useUi((s) => s.navigate)
  const askConfirm = useUi((s) => s.askConfirm)
  const sum = useMemo(() => summarize(history, tracks, period, i18n.language), [history, tracks, period, i18n.language])
  const recent = useMemo(() => [...history].reverse().filter((h) => tracks[h.t]).slice(0, 12), [history, tracks])
  const minutes = (v: number): string => t('stats.minShort', { m: Math.round(v) })

  const tiles = [
    { icon: <Clock3 size={18} />, label: t('stats.time'), value: hoursMinutes(sum.seconds, t) },
    { icon: <Headphones size={18} />, label: t('stats.plays'), value: String(sum.plays) },
    { icon: <Disc3 size={18} />, label: t('stats.unique'), value: String(sum.uniqueTracks) },
    { icon: <Mic2 size={18} />, label: t('stats.topArtist'), value: sum.topArtists[0]?.label ?? '—' }
  ]

  return (
    <div className="page page--narrow stats">
      <header className="page-head drag">
        <div className="page-head__titles">
          <h1>{t('stats.title')}</h1>
          <p>{t('stats.subtitle')}</p>
        </div>
        <div className="page-head__actions no-drag">
          <Segmented<Period>
            label={t('stats.period')}
            value={period}
            onChange={setPeriod}
            options={[
              { value: '7d', label: t('stats.periods.7d') },
              { value: '30d', label: t('stats.periods.30d') },
              { value: '365d', label: t('stats.periods.365d') },
              { value: 'all', label: t('stats.periods.all') }
            ]}
          />
        </div>
      </header>

      {history.length === 0 ? (
        <div className="empty empty--small">
          <div className="empty__art">
            <Headphones size={40} />
          </div>
          <h2>{t('stats.emptyTitle')}</h2>
          <p>{t('stats.emptyText')}</p>
        </div>
      ) : (
        <>
          <div className="stat-tiles">
            {tiles.map((x) => (
              <div key={x.label} className="stat-tile">
                <span className="stat-tile__label">
                  {x.icon}
                  {x.label}
                </span>
                <strong className="stat-tile__value">{x.value}</strong>
              </div>
            ))}
          </div>

          <section className="card">
            <div className="card__head">
              <h3>{sum.bucketUnit === 'day' ? t('stats.perDay') : t('stats.perMonth')}</h3>
            </div>
            <BarChart data={sum.buckets.map((b) => ({ label: b.label, value: b.minutes }))} format={minutes} label={t('stats.perDay')} />
            <details className="chart-table">
              <summary>{t('stats.asTable')}</summary>
              <table>
                <tbody>
                  {sum.buckets
                    .filter((b) => b.minutes > 0)
                    .map((b) => (
                      <tr key={b.start}>
                        <td>{b.label}</td>
                        <td>{minutes(b.minutes)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </details>
          </section>

          <div className="stats-grid">
            <section className="card">
              <h3 className="card__subtitle">{t('stats.topTracks')}</h3>
              <ol className="rank-list">
                {sum.topTracks.map((r, i) => {
                  const tr = r.trackId ? tracks[r.trackId] : undefined
                  return (
                    <li key={r.key}>
                      <span className="rank-list__n">{i + 1}</span>
                      <Cover path={tr?.coverPath} seed={r.key} size={40} rounded={8} />
                      <span className="rank-list__text">
                        <strong>{r.label}</strong>
                        <small>{r.sub}</small>
                      </span>
                      <span className="rank-list__count">{t('stats.playsN', { count: r.plays })}</span>
                      {r.trackId && (
                        <button type="button" className="icon-btn icon-btn--sm" aria-label={t('player.play')} onClick={() => void usePlayer.getState().playQueue([r.trackId!], 0)}>
                          <Play size={15} fill="currentColor" />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ol>
            </section>
            <section className="card">
              <h3 className="card__subtitle">{t('stats.topArtists')}</h3>
              <ol className="rank-list">
                {sum.topArtists.map((r, i) => (
                  <li key={r.key} className="is-link" onClick={() => navigate({ type: 'artist', artist: r.label })}>
                    <span className="rank-list__n">{i + 1}</span>
                    <span className="rank-list__text">
                      <strong>{r.label}</strong>
                      <small>{hoursMinutes(r.seconds, t)}</small>
                    </span>
                    <span className="rank-list__count">{t('stats.playsN', { count: r.plays })}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          {sum.topAlbums.length > 0 && (
            <section className="card">
              <h3 className="card__subtitle">{t('stats.topAlbums')}</h3>
              <div className="album-strip">
                {sum.topAlbums.map((r) => {
                  const tr = r.trackId ? tracks[r.trackId] : undefined
                  return (
                    <button key={r.key} type="button" className="album-card" onClick={() => tr && navigate({ type: 'album', album: tr.album, artist: tr.artist })}>
                      <Cover path={tr?.coverPath} seed={r.key} className="album-card__cover" />
                      <strong>{r.label}</strong>
                      <small>{t('stats.playsN', { count: r.plays })}</small>
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          <section className="card">
            <div className="card__head">
              <h3>{t('stats.recent')}</h3>
              <Button
                variant="ghost"
                icon={<Trash2 size={15} />}
                onClick={() => askConfirm({ title: t('stats.clearConfirm'), danger: true, onConfirm: () => useStats.getState().clear() })}
              >
                {t('stats.clear')}
              </Button>
            </div>
            <ul className="rank-list">
              {recent.map((h) => {
                const tr = tracks[h.t]
                return (
                  <li key={`${h.t}-${h.at}`}>
                    <Cover path={tr.coverPath} seed={tr.id} size={36} rounded={8} />
                    <span className="rank-list__text">
                      <strong>{tr.title}</strong>
                      <small>{tr.artist}</small>
                    </span>
                    <span className="rank-list__count">{new Date(h.at).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })}</span>
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
