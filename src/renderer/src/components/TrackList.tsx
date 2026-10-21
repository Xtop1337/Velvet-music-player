import { AlertTriangle, ArrowDown, ArrowUp, Clock3, Cloud, HardDrive, MoreHorizontal, Play, Youtube } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Track } from '@shared/types'
import { formatTime } from '@renderer/lib/format'
import type { SortKey } from '@renderer/lib/group'
import { multiTrackMenu, trackMenu } from '@renderer/lib/trackMenu'
import { TRACK_DRAG_TYPE, trackArtist, trackTitle } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'
import { LikeButton } from './LikeButton'
import { Cover, PlayingBars } from './ui'

const REORDER_TYPE = 'application/x-velvet-index'

function SpotifyMark(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.18" />
      <path d="M6.5 9.3c3.8-1.1 7.9-.8 11.2 1M7.2 12.6c3.1-.8 6.3-.5 9 .9M7.8 15.7c2.4-.6 4.9-.4 7 .7" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function SourceIcon({ source }: { source: Track['source'] }): React.JSX.Element {
  if (source === 'soundcloud') return <Cloud size={15} />
  if (source === 'spotify') return <SpotifyMark />
  if (source === 'youtube') return <Youtube size={15} />
  return <HardDrive size={15} />
}

interface RowProps {
  track: Track
  index: number
  ids: string[]
  current: boolean
  playing: boolean
  missing: boolean
  selected: boolean
  playlistId?: string
  dropBefore: boolean
  onDragOverRow: (index: number | null) => void
  onSelect: (index: number, e: React.MouseEvent) => void
  onMenu: (index: number, x: number, y: number) => void
  dragIds: (index: number) => string[]
}

const Row = memo(function Row(p: RowProps) {
  const { track, index, ids, current, playing, missing, selected, playlistId, dropBefore, onDragOverRow, onSelect, onMenu, dragIds } = p
  const { t } = useTranslation()

  return (
    <div
      role="row"
      aria-selected={selected}
      className={`track-row ${current ? 'is-current' : ''} ${missing ? 'is-missing' : ''} ${selected ? 'is-selected' : ''} ${dropBefore ? 'is-drop-before' : ''}`}
      draggable
      onMouseDown={(e) => e.button === 0 && onSelect(index, e)}
      onDragStart={(e) => {
        e.dataTransfer.setData(TRACK_DRAG_TYPE, JSON.stringify(dragIds(index)))
        if (playlistId) e.dataTransfer.setData(REORDER_TYPE, String(index))
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      onDragOver={(e) => {
        if (!playlistId || !e.dataTransfer.types.includes(REORDER_TYPE)) return
        e.preventDefault()
        onDragOverRow(index)
      }}
      onDrop={(e) => {
        if (!playlistId) return
        const from = e.dataTransfer.getData(REORDER_TYPE)
        onDragOverRow(null)
        if (from === '') return
        e.preventDefault()
        const f = Number(from)
        useLibrary.getState().movePlaylistTrack(playlistId, f, f < index ? index - 1 : index)
      }}
      onDragEnd={() => onDragOverRow(null)}
      onDoubleClick={() => void usePlayer.getState().playQueue(ids, index)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(index, e.clientX, e.clientY)
      }}
    >
      <div className="track-row__num">
        {current ? <PlayingBars paused={!playing} /> : <span className="num">{index + 1}</span>}
        <button
          type="button"
          className="track-row__play"
          aria-label={t('player.play')}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => (current ? void usePlayer.getState().toggle() : void usePlayer.getState().playQueue(ids, index))}
        >
          <Play size={15} fill="currentColor" />
        </button>
      </div>
      <div className="track-row__main">
        <Cover path={track.coverPath} seed={track.id} size={40} rounded={8} />
        <div className="track-row__text">
          <span className="track-row__title">
            {trackTitle(track, t)}
            {missing && (
              <span className="badge badge--warn" title={t('track.missing')}>
                <AlertTriangle size={12} />
              </span>
            )}
          </span>
          <span className="track-row__artist">{trackArtist(track, t)}</span>
        </div>
      </div>
      <div className="track-row__album">{track.album}</div>
      <div className="track-row__source" title={track.source}>
        <SourceIcon source={track.source} />
      </div>
      <div className="track-row__like" onMouseDown={(e) => e.stopPropagation()}>
        <LikeButton trackId={track.id} size={16} />
      </div>
      <div className="track-row__time">{formatTime(track.duration)}</div>
      <div className="track-row__more">
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="More"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            onMenu(index, r.left - 200, r.bottom + 4)
          }}
        >
          <MoreHorizontal size={18} />
        </button>
      </div>
    </div>
  )
})

export interface TrackListSort {
  key: SortKey
  desc: boolean
}

export function TrackList({
  ids,
  playlistId,
  sort,
  onSort
}: {
  ids: string[]
  playlistId?: string
  sort?: TrackListSort
  onSort?: (s: TrackListSort) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tracks = useLibrary((s) => s.tracks)
  const missing = useLibrary((s) => s.missing)
  const currentId = usePlayer((s) => s.currentId)
  const playing = usePlayer((s) => s.playing)
  const openMenu = useUi((s) => s.openMenu)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // a new list (filter, sort, other page) clears the selection
  useEffect(() => {
    setSelected(new Set())
    anchor.current = null
  }, [ids])

  const onSelect = useCallback((index: number, e: React.MouseEvent) => {
    setSelected((prev) => {
      if (e.shiftKey && anchor.current !== null) {
        const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)]
        const next = new Set(e.ctrlKey || e.metaKey ? prev : [])
        for (let i = a; i <= b; i++) next.add(i)
        return next
      }
      anchor.current = index
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev)
        if (next.has(index)) next.delete(index)
        else next.add(index)
        return next
      }
      // plain click keeps a multi-selection when pressing on one of its rows (so it can be dragged)
      return prev.has(index) && prev.size > 1 ? prev : new Set([index])
    })
  }, [])

  const selectionFor = useCallback(
    (index: number): number[] => (selected.has(index) && selected.size > 1 ? [...selected].sort((a, b) => a - b) : [index]),
    [selected]
  )

  const dragIds = useCallback((index: number) => selectionFor(index).map((i) => ids[i]), [selectionFor, ids])

  const onMenu = useCallback(
    (index: number, x: number, y: number) => {
      const rows = selectionFor(index)
      if (!selected.has(index)) setSelected(new Set([index]))
      const items =
        rows.length > 1
          ? multiTrackMenu({ trackIds: rows.map((i) => ids[i]), t, playlistId, playlistIndexes: playlistId ? rows : undefined })
          : trackMenu({ trackId: ids[index], context: ids, index, t, playlistId, playlistIndex: playlistId ? index : undefined })
      openMenu(x, y, items)
    },
    [selectionFor, selected, ids, t, playlistId, openMenu]
  )

  const header = (key: SortKey | null, label: React.ReactNode, className = ''): React.JSX.Element => {
    if (!key || !onSort) return <div className={className}>{label}</div>
    const active = sort?.key === key
    return (
      <button
        type="button"
        className={`track-list__sort ${active ? 'is-active' : ''} ${className}`}
        onClick={() => onSort({ key, desc: active ? !sort!.desc : key === 'plays' || key === 'added' })}
      >
        {label}
        {active && (sort!.desc ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}
      </button>
    )
  }

  return (
    <div
      className="track-list"
      role="table"
      ref={listRef}
      tabIndex={-1}
      aria-multiselectable
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault()
          setSelected(new Set(ids.map((_, i) => i)))
        } else if (e.key === 'Escape') setSelected(new Set())
        else if (e.key === 'Enter' && selected.size) {
          const first = Math.min(...selected)
          void usePlayer.getState().playQueue(ids, first)
        }
      }}
      onMouseDown={() => listRef.current?.focus({ preventScroll: true })}
    >
      <div className="track-list__head" role="row">
        <div>#</div>
        {header('title', t('columns.title'))}
        {header('album', t('columns.album'))}
        <div />
        <div />
        {header('duration', <Clock3 size={15} />, 'track-list__time')}
        <div />
      </div>
      {selected.size > 1 && (
        <div className="selection-bar">
          {t('selection.count', { count: selected.size })}
          <button type="button" className="link-btn" onClick={() => setSelected(new Set())}>
            {t('selection.clear')}
          </button>
        </div>
      )}
      {ids.map((id, i) => {
        const track = tracks[id]
        if (!track) return null
        return (
          <Row
            key={`${id}-${i}`}
            track={track}
            index={i}
            ids={ids}
            current={id === currentId}
            playing={playing}
            missing={missing.has(id)}
            selected={selected.has(i)}
            playlistId={playlistId}
            dropBefore={dropIndex === i}
            onDragOverRow={setDropIndex}
            onSelect={onSelect}
            onMenu={onMenu}
            dragIds={dragIds}
          />
        )
      })}
    </div>
  )
}
