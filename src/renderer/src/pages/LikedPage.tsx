import { Heart, Play, Shuffle } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { TrackList } from '@renderer/components/TrackList'
import { Button } from '@renderer/components/ui'
import { formatTime } from '@renderer/lib/format'
import { matchesQuery, totalDuration } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'

export function LikedPage(): React.JSX.Element {
  const { t } = useTranslation()
  const tracks = useLibrary((s) => s.tracks)
  const order = useLibrary((s) => s.order)
  const search = useUi((s) => s.search)
  const ids = useMemo(
    () =>
      order
        .filter((id) => tracks[id]?.liked)
        .sort((a, b) => (tracks[b].likedAt ?? 0) - (tracks[a].likedAt ?? 0)),
    [order, tracks]
  )
  const shown = useMemo(() => ids.filter((id) => matchesQuery(tracks[id], search)), [ids, tracks, search])

  return (
    <div className="page">
      <header className="playlist-hero drag">
        <div className="liked-art">
          <Heart size={72} fill="currentColor" />
        </div>
        <div className="playlist-hero__info">
          <span className="eyebrow">{t('playlist.label')}</span>
          <h1>{t('liked.title')}</h1>
          <p>
            {t('common.tracks', { count: ids.length })} · {formatTime(totalDuration(ids.map((id) => tracks[id])))}
          </p>
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
        </div>
      </header>
      {ids.length === 0 ? (
        <div className="empty empty--small">
          <h2>{t('liked.emptyTitle')}</h2>
          <p>{t('liked.emptyText')}</p>
        </div>
      ) : (
        <TrackList ids={shown} />
      )}
    </div>
  )
}
