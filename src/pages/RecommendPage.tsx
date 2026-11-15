import { History, Loader2, Pause, Play, Radio, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchResult, SearchSource } from '@shared/types'
import { LayoutToggle, useLayout } from '@renderer/components/LayoutToggle'
import { MixCard, MixCollage, mixGradient } from '@renderer/components/MixCard'
import { OnlineResults } from '@renderer/components/OnlineResults'
import { SOURCE_NAMES } from '@renderer/components/ServiceIcons'
import { rememberSource, rememberedSource, SourcePicker } from '@renderer/components/SourcePicker'
import { Button } from '@renderer/components/ui'
import { forgottenTracks } from '@renderer/lib/forgotten'
import { withoutKnown } from '@renderer/lib/recommend'
import { useLibrary } from '@renderer/store/library'
import { useMixes } from '@renderer/store/mixes'
import { usePlayer } from '@renderer/store/player'
import { WAVE_MODE_IDS } from '@renderer/lib/wave'
import { resolveService, streamTrack, useRadio, type WaveSource } from '@renderer/store/radio'
import { downloadSuggestion, useRecs } from '@renderer/store/recs'
import { useStats } from '@renderer/store/stats'
import { useTaste } from '@renderer/store/taste'
import { useUi } from '@renderer/store/ui'
import { onlineError, SpotifyKeysHint, useSpotifyKeys } from './SearchPage'

const SOURCE_KEY = 'velvet.recommendSource'
const SHOWN = 40

/** "My wave": an endless radio from the whole taste; where it looks and how far it strays are chosen here. */
function WaveCard(): React.JSX.Element {
  const { t } = useTranslation()
  const radio = useRadio((s) => s.active)
  const loading = useRadio((s) => s.loading)
  const source = useRadio((s) => s.source)
  const mode = useRadio((s) => s.mode)
  const playing = usePlayer((s) => s.playing)
  const tracks = useLibrary((s) => s.tracks)
  const on = radio?.kind === 'wave'
  const auto = useMemo(() => resolveService('auto', tracks), [tracks])
  return (
    <section className={`wave-card ${on && playing ? 'is-playing' : ''}`}>
      <div className="wave-card__glow" aria-hidden />
      <div className="wave-card__text">
        <h2>
          <Radio size={22} /> {t('radio.wave')}
        </h2>
        <p>{t(`radio.modeText.${mode}`)}</p>
        <div className="wave-card__controls">
          <div className="wave-seg" role="radiogroup" aria-label={t('radio.mode')}>
            {WAVE_MODE_IDS.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'is-active' : ''} onClick={() => useRadio.getState().setMode(m)}>
                {t(`radio.modes.${m}`)}
              </button>
            ))}
          </div>
          <label className="wave-source">
            <span>{t('radio.source')}</span>
            <select aria-label={t('radio.source')} value={source} onChange={(e) => useRadio.getState().setSource(e.target.value as WaveSource)}>
              <option value="auto">{t('radio.sourceAuto', { name: auto === 'soundcloud' ? 'SoundCloud' : 'YouTube' })}</option>
              <option value="soundcloud">SoundCloud</option>
              <option value="youtube">YouTube</option>
            </select>
          </label>
        </div>
      </div>
      <Button
        variant="primary"
        icon={loading && on ? <Loader2 size={18} className="spin" /> : on && playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        onClick={() => (on ? void usePlayer.getState().toggle() : void useRadio.getState().start('wave'))}
      >
        {on && playing ? t('player.pause') : t('radio.listen')}
      </Button>
    </section>
  )
}

export function RecommendPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [source, setSource] = useState<SearchSource>(() => rememberedSource(SOURCE_KEY))
  const [layout, setLayout] = useLayout('recommend')
  const tracks = useLibrary((s) => s.tracks)
  const order = useLibrary((s) => s.order)
  const libraryLoaded = useLibrary((s) => s.loaded)
  const statsLoaded = useStats((s) => s.loaded)
  const history = useStats((s) => s.history)
  const dislikes = useTaste((s) => s.dislikes)
  const batch = useRecs((s) => s.batches[source])
  const loading = useRecs((s) => !!s.loading[source])
  const mixes = useMixes((s) => s.mixes)
  const keys = useSpotifyKeys()
  const navigate = useUi((s) => s.navigate)
  const empty = libraryLoaded && order.length === 0

  useEffect(() => {
    if (!libraryLoaded || !statsLoaded || empty) return
    void useMixes.getState().ensure()
    void useRecs.getState().load(source)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryLoaded, statsLoaded, source])

  const forgotten = useMemo(() => (libraryLoaded && statsLoaded ? forgottenTracks(tracks, history) : []), [libraryLoaded, statsLoaded, tracks, history])

  const changeSource = (v: SearchSource): void => {
    setSource(v)
    rememberSource(SOURCE_KEY, v)
  }

  const shown = useMemo(() => {
    if (!batch) return []
    const taste = useTaste.getState()
    return withoutKnown(batch.results, tracks)
      .filter((r) => !taste.isDisliked(r.artist, r.title) && !taste.isArtistBanned(r.artist))
      .slice(0, SHOWN)
    // `dislikes` re-runs this after "Not interested"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch, tracks, dislikes])
  const notes = useMemo(() => Object.fromEntries(shown.filter((r) => r.because).map((r) => [r.id, t('recommend.likeArtist', { artist: r.because })])), [shown, t])
  const needsKeys = source === 'spotify' && (!keys || batch?.error === 'spotify-keys' || batch?.error === 'spotify-auth')

  // the user's own genres first, neighbouring ones after
  const close = useMemo(() => new Set(batch?.close ?? []), [batch])
  const inGenre = useMemo(() => shown.filter((r) => close.has(r.id)), [shown, close])
  const nearby = useMemo(() => shown.filter((r) => !close.has(r.id)), [shown, close])
  const list = (results: SearchResult[], isLoading = false): React.JSX.Element => (
    <OnlineResults
      results={results}
      loading={isLoading}
      layout={layout}
      notes={notes}
      rate
      onDownload={(r) => void downloadSuggestion(r, source)}
      onRadio={(r) => void useRadio.getState().start(streamTrack(r, source === 'soundcloud' ? 'soundcloud' : 'youtube'))}
    />
  )

  if (empty) {
    return (
      <div className="page page--narrow">
        <header className="page-head drag">
          <div className="page-head__titles">
            <h1>{t('recommend.title')}</h1>
          </div>
        </header>
        <div className="empty empty--small">
          <div className="empty__art">
            <Sparkles size={40} />
          </div>
          <h2>{t('recommend.emptyTitle')}</h2>
          <p>{t('recommend.emptyText')}</p>
          <div className="empty__actions">
            <Button variant="primary" onClick={() => navigate({ type: 'search' })}>
              {t('recommend.toSearch')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page page--narrow foryou">
      <header className="page-head drag">
        <div className="page-head__titles">
          <h1>{t('recommend.title')}</h1>
          <p>{t('recommend.subtitle')}</p>
        </div>
      </header>

      <WaveCard />

      {(mixes.length > 0 || forgotten.length > 0) && (
        <>
          <h3 className="section-title">
            {t('mixes.title')} <small className="muted">{t('mixes.daily')}</small>
          </h3>
          <div className="mix-grid">
            {mixes.map((m) => (
              <MixCard key={m.id} mix={m} />
            ))}
            {forgotten.length > 0 && (
              <div className="mix-card" onClick={() => navigate({ type: 'mix', id: 'forgotten' })}>
                <div className="mix-card__art">
                  <MixCollage ids={forgotten} label={t('forgotten.title')} gradient={mixGradient('forgotten')} />
                  <button
                    type="button"
                    className="grid-card__play"
                    aria-label={t('player.play')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void usePlayer.getState().playQueue(forgotten, 0)
                    }}
                  >
                    <Play size={20} fill="currentColor" />
                  </button>
                </div>
                <strong>
                  <History size={14} /> {t('forgotten.title')}
                </strong>
                <small>{t('forgotten.sub', { count: forgotten.length })}</small>
              </div>
            )}
          </div>
        </>
      )}

      <div className="recommend-bar">
        <h3 className="section-title">{t('recommend.newForYou')}</h3>
        <div className="toolbar__spacer" />
        <SourcePicker value={source} onChange={changeSource} notes={keys ? undefined : { spotify: t('search.spotify.keysNote') }} />
        <Button icon={loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />} disabled={loading || needsKeys} onClick={() => void useRecs.getState().load(source, true)}>
          {t('recommend.refresh')}
        </Button>
        <LayoutToggle value={layout} onChange={setLayout} />
      </div>

      {needsKeys ? (
        <SpotifyKeysHint reason={batch?.error} />
      ) : (
        <>
          {batch?.basedOn.length && !loading && shown.length ? (
            <p className="recommend-because">
              <Sparkles size={15} />
              <span>{t('recommend.basedOn', { artists: batch.basedOn.join(', '), source: SOURCE_NAMES[source] })}</span>
            </p>
          ) : null}
          {loading && !shown.length && <p className="muted small">{t('recommend.loading', { source: SOURCE_NAMES[source] })}</p>}
          {batch?.error && !loading && !shown.length && <p className="text-danger small">{onlineError(batch.error, t)}</p>}
          {loading && !shown.length && list([], true)}
          {inGenre.length > 0 && nearby.length > 0 && <h4 className="recommend-group">{t('recommend.inGenre')}</h4>}
          {list(inGenre)}
          {inGenre.length > 0 && nearby.length > 0 && <h4 className="recommend-group">{t('recommend.nearby')}</h4>}
          {list(nearby)}
          {loading && shown.length > 0 && (
            <p className="muted small inline-loading">
              <Loader2 size={13} className="spin" /> {t('recommend.adding', { source: SOURCE_NAMES[source] })}
            </p>
          )}
          {!loading && batch && !batch.error && shown.length === 0 && <p className="muted">{t('recommend.nothing')}</p>}
        </>
      )}
    </div>
  )
}
