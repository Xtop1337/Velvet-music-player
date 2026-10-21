import { FilePlus2, FolderPlus, Link2, Music, Play, Search, Shuffle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlbumGrid, ArtistGrid } from '@renderer/components/CardGrid'
import { TrackList, type TrackListSort } from '@renderer/components/TrackList'
import { Button, Segmented } from '@renderer/components/ui'
import { addPicked } from '@renderer/lib/addMusic'
import { formatTime } from '@renderer/lib/format'
import { groupAlbums, groupArtists, sortTracks, type SortKey } from '@renderer/lib/group'
import { matchesQuery, totalDuration } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'

type Mode = 'tracks' | 'albums' | 'artists'

function remembered<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback
  } catch {
    return fallback
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // per-viewer convenience only
  }
}

export function LibraryPage(): React.JSX.Element {
  const { t } = useTranslation()
  const order = useLibrary((s) => s.order)
  const tracks = useLibrary((s) => s.tracks)
  const search = useUi((s) => s.search)
  const setSearch = useUi((s) => s.setSearch)
  const navigate = useUi((s) => s.navigate)
  const [mode, setMode] = useState<Mode>(() => remembered<Mode>('velvet.libraryMode', 'tracks'))
  const [sort, setSort] = useState<TrackListSort>(() => {
    const [key, dir] = remembered('velvet.librarySort', 'added:desc').split(':')
    return { key: key as SortKey, desc: dir === 'desc' }
  })

  const filtered = useMemo(() => order.filter((id) => tracks[id] && matchesQuery(tracks[id], search)), [order, tracks, search])
  const ids = useMemo(() => sortTracks(filtered, tracks, sort.key, sort.desc), [filtered, tracks, sort])
  const albums = useMemo(() => (mode === 'albums' ? groupAlbums(filtered, tracks) : []), [mode, filtered, tracks])
  const artists = useMemo(() => (mode === 'artists' ? groupArtists(filtered, tracks) : []), [mode, filtered, tracks])
  const duration = useMemo(() => totalDuration(filtered.map((id) => tracks[id])), [filtered, tracks])

  const changeMode = (m: Mode): void => {
    setMode(m)
    remember('velvet.libraryMode', m)
  }
  const changeSort = (s: TrackListSort): void => {
    setSort(s)
    remember('velvet.librarySort', `${s.key}:${s.desc ? 'desc' : 'asc'}`)
  }

  return (
    <div className="page">
      <header className="page-head drag">
        <div className="page-head__titles">
          <h1>{t('library.title')}</h1>
          <p>{t('library.subtitle', { tracks: t('common.tracks', { count: filtered.length }), duration: formatTime(duration) })}</p>
        </div>
        <div className="page-head__actions no-drag">
          <label className="search">
            <Search size={16} />
            <input
              id="global-search"
              value={search}
              placeholder={t('library.search')}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
            />
          </label>
          <Button icon={<FilePlus2 size={17} />} onClick={() => void addPicked('files', t)}>
            {t('library.addFiles')}
          </Button>
          <Button icon={<FolderPlus size={17} />} onClick={() => void addPicked('folder', t)}>
            {t('library.addFolder')}
          </Button>
        </div>
      </header>

      {order.length === 0 ? (
        <div className="empty">
          <div className="empty__art">
            <Music size={40} />
          </div>
          <h2>{t('library.emptyTitle')}</h2>
          <p>{t('library.emptyText')}</p>
          <div className="empty__actions">
            <Button variant="primary" icon={<FilePlus2 size={17} />} onClick={() => void addPicked('files', t)}>
              {t('library.addFiles')}
            </Button>
            <Button icon={<FolderPlus size={17} />} onClick={() => void addPicked('folder', t)}>
              {t('library.addFolder')}
            </Button>
            <Button icon={<Link2 size={17} />} onClick={() => navigate({ type: 'import' })}>
              {t('nav.import')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <Button variant="primary" icon={<Play size={16} fill="currentColor" />} onClick={() => void usePlayer.getState().playQueue(ids, 0)} disabled={!ids.length}>
              {t('library.playAll')}
            </Button>
            <Button
              icon={<Shuffle size={16} />}
              disabled={!ids.length}
              onClick={() => {
                const p = usePlayer.getState()
                if (!p.shuffle) p.setShuffle(true)
                void p.playQueue(ids, Math.floor(Math.random() * ids.length))
              }}
            >
              {t('library.shuffle')}
            </Button>
            <div className="toolbar__spacer" />
            {mode === 'tracks' && (
              <select
                className="input input--select input--sm"
                aria-label={t('sort.label')}
                value={sort.key}
                onChange={(e) => changeSort({ key: e.target.value as SortKey, desc: e.target.value === 'added' || e.target.value === 'plays' })}
              >
                {(['added', 'title', 'artist', 'album', 'duration', 'plays'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`sort.${k}`)}
                  </option>
                ))}
              </select>
            )}
            <Segmented<Mode>
              label={t('library.view')}
              value={mode}
              onChange={changeMode}
              options={[
                { value: 'tracks', label: t('library.modes.tracks') },
                { value: 'albums', label: t('library.modes.albums') },
                { value: 'artists', label: t('library.modes.artists') }
              ]}
            />
          </div>
          {filtered.length === 0 ? (
            <p className="muted pad">{t('library.noResults', { query: search })}</p>
          ) : mode === 'albums' ? (
            <AlbumGrid albums={albums} />
          ) : mode === 'artists' ? (
            <ArtistGrid artists={artists} />
          ) : (
            <TrackList ids={ids} sort={sort} onSort={changeSort} />
          )}
        </>
      )}
    </div>
  )
}
