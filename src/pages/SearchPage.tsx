import { KeyRound, Loader2, Search } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchResult, SearchSource } from '@shared/types'
import { LayoutToggle, useLayout } from '@renderer/components/LayoutToggle'
import { OnlineResults } from '@renderer/components/OnlineResults'
import { SOURCE_NAMES } from '@renderer/components/ServiceIcons'
import { rememberSource, rememberedSource, SourcePicker } from '@renderer/components/SourcePicker'
import { TrackList } from '@renderer/components/TrackList'
import { Button } from '@renderer/components/ui'
import { matchesQuery } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { streamTrack, useRadio } from '@renderer/store/radio'
import { useSettings } from '@renderer/store/settings'
import { useUi } from '@renderer/store/ui'

const SOURCE_KEY = 'velvet.searchSource'

/** The user's own Spotify keys from Settings → Import, if both are filled in. */
export function useSpotifyKeys(): { clientId: string; clientSecret: string } | null {
  const id = useSettings((s) => s.settings.importer.spotifyClientId)
  const secret = useSettings((s) => s.settings.importer.spotifyClientSecret)
  return useMemo(() => (id.trim() && secret.trim() ? { clientId: id.trim(), clientSecret: secret.trim() } : null), [id, secret])
}

/** Spotify needs the user's keys: what to do instead of results without them. */
export function SpotifyKeysHint({ reason }: { reason?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useUi((s) => s.navigate)
  return (
    <div className="keys-hint card">
      <KeyRound size={22} />
      <div>
        <strong>{reason === 'spotify-auth' ? t('search.spotify.badKeys') : t('search.spotify.needKeys')}</strong>
        <p className="muted small">{t('search.spotify.howTo')}</p>
      </div>
      <Button variant="primary" onClick={() => navigate({ type: 'settings', section: 'import' })}>
        {reason === 'spotify-auth' ? t('search.spotify.fixKeys') : t('search.spotify.addKeys')}
      </Button>
    </div>
  )
}

/** Text for a search / recommendation error (Spotify's are explained). */
export function onlineError(error: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (error === 'spotify-forbidden') return t('search.spotify.forbidden')
  if (error === 'spotify-rate-limit') return t('search.spotify.rateLimit')
  // no connection (or a blocked one): say so instead of the tool's own message
  if (/deezer-unavailable|unable to connect|proxy|timed? ?out|connection (refused|reset|failed)|name or service|getaddrinfo|network is unreachable|error sending request|dns/i.test(error))
    return t('search.offline')
  return t('search.error', { error: error.slice(0, 200) })
}

export function SearchPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<SearchSource>(() => rememberedSource(SOURCE_KEY))
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState('')
  const order = useLibrary((s) => s.order)
  const tracks = useLibrary((s) => s.tracks)
  const keys = useSpotifyKeys()
  const seq = useRef(0)
  const [layout, setLayout] = useLayout('search')

  const local = useMemo(() => (searched ? order.filter((id) => tracks[id] && matchesQuery(tracks[id], searched)).slice(0, 5) : []), [searched, order, tracks])
  const needsKeys = source === 'spotify' && (!keys || error === 'spotify-keys' || error === 'spotify-auth')

  const run = async (q = query, src = source): Promise<void> => {
    const text = q.trim()
    if (!text) return
    const id = ++seq.current
    setSearched(text)
    setError('')
    if (src === 'spotify' && !keys) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    const res = await window.velvet.search.query(text, src, src === 'spotify' ? keys : null).catch((e: unknown) => ({ results: [], error: String(e) }))
    if (id !== seq.current) return
    setResults(res.results)
    setError(res.error ?? '')
    setLoading(false)
  }

  const changeSource = (v: SearchSource): void => {
    setSource(v)
    rememberSource(SOURCE_KEY, v)
    setResults([])
    if (searched) void run(searched, v)
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
        <SourcePicker value={source} onChange={changeSource} notes={keys ? undefined : { spotify: t('search.spotify.keysNote') }} />
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

      {needsKeys && <SpotifyKeysHint reason={error} />}
      {!needsKeys && searched && (
        <div className="recommend-bar">
          <h3 className="section-title">{t('search.online', { source: SOURCE_NAMES[source] })}</h3>
          <div className="toolbar__spacer" />
          <LayoutToggle value={layout} onChange={setLayout} />
        </div>
      )}
      {!needsKeys && error && <p className="text-danger small">{onlineError(error, t)}</p>}
      {!needsKeys && (
        <OnlineResults
          results={results}
          loading={loading}
          layout={layout}
          onRadio={(r) => void useRadio.getState().start(streamTrack({ ...r, source: r.source }, source === 'soundcloud' ? 'soundcloud' : 'youtube'))}
        />
      )}
      {!needsKeys && !loading && searched && !error && results.length === 0 && <p className="muted">{t('search.nothing')}</p>}
      {!searched && !needsKeys && <p className="muted small">{t('search.hint')}</p>}
    </div>
  )
}
