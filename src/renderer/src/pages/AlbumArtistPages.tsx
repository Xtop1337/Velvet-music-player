import { Disc3, Mic2, Play, Shuffle } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlbumGrid } from '@renderer/components/CardGrid'
import { TrackList } from '@renderer/components/TrackList'
import { Button, Cover } from '@renderer/components/ui'
import { formatTime } from '@renderer/lib/format'
import { byTrackNo, groupAlbums, splitArtists, tracksOfArtist } from '@renderer/lib/group'
import { totalDuration } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'

function PlayButtons({ ids }: { ids: string[] }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="playlist-hero__actions no-drag">
      <Button variant="primary" icon={<Play size={16} fill="currentColor" />} disabled={!ids.length} onClick={() => void usePlayer.getState().playQueue(ids, 0)}>
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
    </div>
  )
}

export function AlbumPage({ album, artist }: { album: string; artist: string }): React.JSX.Element {
  const { t } = useTranslation()
  const order = useLibrary((s) => s.order)
  const tracks = useLibrary((s) => s.tracks)
  const navigate = useUi((s) => s.navigate)
  const group = useMemo(() => {
    const k = album.trim().toLowerCase()
    return groupAlbums(order.filter((id) => tracks[id]?.album.trim().toLowerCase() === k), tracks)[0]
  }, [order, tracks, album])
  const ids = useMemo(() => (group ? [...group.trackIds].sort(byTrackNo(tracks)) : []), [group, tracks])
  const shownArtist = group?.artist || artist

  return (
    <div className="page">
      <header className="playlist-hero drag">
        <div className="playlist-hero__cover no-drag">
          <Cover path={group?.coverPath} seed={album} size={196} rounded={20} />
        </div>
        <div className="playlist-hero__info">
          <span className="eyebrow">
            <Disc3 size={14} /> {t('album.label')}
          </span>
          <h1>{album}</h1>
          <p>
            <button type="button" className="hero-link no-drag" onClick={() => navigate({ type: 'artist', artist: splitArtists(shownArtist)[0] ?? shownArtist })}>
              {shownArtist}
            </button>
            {group?.year ? ` · ${group.year}` : ''} · {t('common.tracks', { count: ids.length })} · {formatTime(totalDuration(ids.map((id) => tracks[id])))}
          </p>
          <PlayButtons ids={ids} />
        </div>
      </header>
      <TrackList ids={ids} />
    </div>
  )
}

export function ArtistPage({ artist }: { artist: string }): React.JSX.Element {
  const { t } = useTranslation()
  const order = useLibrary((s) => s.order)
  const tracks = useLibrary((s) => s.tracks)
  const ids = useMemo(() => tracksOfArtist(artist, order, tracks), [artist, order, tracks])
  const albums = useMemo(() => groupAlbums(ids, tracks), [ids, tracks])
  const popular = useMemo(
    () => [...ids].sort((a, b) => (tracks[b].playCount ?? 0) - (tracks[a].playCount ?? 0)).slice(0, 5),
    [ids, tracks]
  )
  const cover = ids.map((id) => tracks[id].coverPath).find(Boolean)

  return (
    <div className="page">
      <header className="playlist-hero drag">
        <div className="playlist-hero__cover playlist-hero__cover--round no-drag">
          <Cover path={cover} seed={artist} size={196} rounded={98} />
        </div>
        <div className="playlist-hero__info">
          <span className="eyebrow">
            <Mic2 size={14} /> {t('artist.label')}
          </span>
          <h1>{artist}</h1>
          <p>
            {t('common.tracks', { count: ids.length })}
            {albums.length > 0 && ` · ${t('artist.albums', { count: albums.length })}`}
          </p>
          <PlayButtons ids={ids} />
        </div>
      </header>
      {ids.length > 5 && ids.some((id) => tracks[id].playCount) && (
        <>
          <h3 className="section-title">{t('artist.popular')}</h3>
          <TrackList ids={popular} />
        </>
      )}
      {albums.length > 0 && (
        <>
          <h3 className="section-title">{t('artist.albumsTitle')}</h3>
          <AlbumGrid albums={albums} />
        </>
      )}
      <h3 className="section-title">{t('artist.allTracks')}</h3>
      <TrackList ids={ids} />
    </div>
  )
}
