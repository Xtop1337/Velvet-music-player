import { Pause, Play, StickyNote } from 'lucide-react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Track } from '@shared/types'
import { trackMenu } from '@renderer/lib/trackMenu'
import { beginTrackDrag } from '@renderer/lib/trackDrag'
import { trackArtist, trackTitle } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'
import { LikeButton } from './LikeButton'
import type { Layout } from './LayoutToggle'
import { TrackList, type TrackListSort } from './TrackList'
import { Cover, PlayingBars } from './ui'

const Tile = memo(function Tile(p: { track: Track; index: number; ids: string[]; current: boolean; playing: boolean; playlistId?: string; missing: boolean }) {
  const { track, index, ids, current, playing, playlistId, missing } = p
  const { t } = useTranslation()
  const openMenu = useUi((s) => s.openMenu)
  const menu = (x: number, y: number): void =>
    openMenu(x, y, trackMenu({ trackId: track.id, context: ids, index, t, playlistId, playlistIndex: playlistId ? index : undefined }))
  return (
    <div
      className={`tile tile--track ${current ? 'is-current' : ''} ${missing ? 'is-missing' : ''}`}
      onPointerDown={(e) => beginTrackDrag(e, () => ({ ids: [track.id], playlistId, from: playlistId ? index : undefined }))}
      onDoubleClick={() => void usePlayer.getState().playQueue(ids, index)}
      onContextMenu={(e) => {
        e.preventDefault()
        menu(e.clientX, e.clientY)
      }}
    >
      <div className="tile__art">
        <Cover path={track.coverPath} url={track.coverUrl} seed={track.id} className="tile__cover" />
        <button
          type="button"
          className="tile__play"
          aria-label={current && playing ? t('player.pause') : t('player.play')}
          onClick={() => (current ? void usePlayer.getState().toggle() : void usePlayer.getState().playQueue(ids, index))}
        >
          {current && playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
        {current && (
          <span className="tile__now">
            <PlayingBars paused={!playing} />
          </span>
        )}
        <span className="tile__like" onPointerDown={(e) => e.stopPropagation()}>
          <LikeButton trackId={track.id} size={16} />
        </span>
      </div>
      <strong title={trackTitle(track, t)}>
        {trackTitle(track, t)}
        {track.note && (
          <span className="track-row__note" title={track.note}>
            <StickyNote size={12} />
          </span>
        )}
      </strong>
      <span className="tile__sub" title={trackArtist(track, t)}>
        {trackArtist(track, t)}
      </span>
      {(track.bpm || track.camelot) && (
        <small className="tile__meta">
          {track.bpm ? `${Math.round(track.bpm)} BPM` : ''}
          {track.bpm && track.camelot ? ' · ' : ''}
          {track.camelot ?? ''}
        </small>
      )}
    </div>
  )
})

/** Tracks as tiles: cover, title, artist; play, like, menu and drag like the rows. */
export function TrackGrid({ ids, playlistId }: { ids: string[]; playlistId?: string }): React.JSX.Element {
  const tracks = useLibrary((s) => s.tracks)
  const missing = useLibrary((s) => s.missing)
  const currentId = usePlayer((s) => s.currentId)
  const playing = usePlayer((s) => s.playing)
  return (
    <div className="tile-grid">
      {ids.map((id, i) => {
        const track = tracks[id]
        if (!track) return null
        return <Tile key={`${id}-${i}`} track={track} index={i} ids={ids} current={id === currentId} playing={playing} playlistId={playlistId} missing={missing.has(id)} />
      })}
    </div>
  )
}

/** Rows or tiles, as the page's layout switch says. */
export function TrackView(props: { ids: string[]; layout: Layout; playlistId?: string; sort?: TrackListSort; onSort?: (s: TrackListSort) => void }): React.JSX.Element {
  return props.layout === 'grid' ? <TrackGrid ids={props.ids} playlistId={props.playlistId} /> : <TrackList ids={props.ids} playlistId={props.playlistId} sort={props.sort} onSort={props.onSort} />
}
