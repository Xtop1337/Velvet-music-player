import { Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AlbumGroup, ArtistGroup } from '@renderer/lib/group'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'
import { Cover } from './ui'

export function AlbumGrid({ albums }: { albums: AlbumGroup[] }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useUi((s) => s.navigate)
  return (
    <div className="card-grid">
      {albums.map((a) => (
        <div key={a.key} className="grid-card" onClick={() => navigate({ type: 'album', album: a.album, artist: a.artist })}>
          <div className="grid-card__art">
            <Cover path={a.coverPath} seed={a.key} className="grid-card__cover" />
            <button
              type="button"
              className="grid-card__play"
              aria-label={t('player.play')}
              onClick={(e) => {
                e.stopPropagation()
                void usePlayer.getState().playQueue(a.trackIds, 0)
              }}
            >
              <Play size={20} fill="currentColor" />
            </button>
          </div>
          <strong>{a.album}</strong>
          <small>
            {a.artist}
            {a.year ? ` · ${a.year}` : ''}
          </small>
        </div>
      ))}
    </div>
  )
}

export function ArtistGrid({ artists }: { artists: ArtistGroup[] }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useUi((s) => s.navigate)
  return (
    <div className="card-grid">
      {artists.map((a) => (
        <div key={a.name} className="grid-card grid-card--artist" onClick={() => navigate({ type: 'artist', artist: a.name })}>
          <div className="grid-card__art">
            <Cover path={a.coverPath} seed={a.name} className="grid-card__cover" />
            <button
              type="button"
              className="grid-card__play"
              aria-label={t('player.play')}
              onClick={(e) => {
                e.stopPropagation()
                void usePlayer.getState().playQueue(a.trackIds, 0)
              }}
            >
              <Play size={20} fill="currentColor" />
            </button>
          </div>
          <strong>{a.name}</strong>
          <small>{t('common.tracks', { count: a.trackIds.length })}</small>
        </div>
      ))}
    </div>
  )
}
