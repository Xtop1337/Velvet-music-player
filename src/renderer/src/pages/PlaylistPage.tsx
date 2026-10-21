import { ImagePlus, ListMusic, MoreHorizontal, Pencil, Play, Shuffle, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { TrackList } from '@renderer/components/TrackList'
import { Button, Cover, IconButton } from '@renderer/components/ui'
import { formatTime } from '@renderer/lib/format'
import { matchesQuery, totalDuration } from '@renderer/lib/tracks'
import { useLibrary } from '@renderer/store/library'
import { usePlayer } from '@renderer/store/player'
import { useUi } from '@renderer/store/ui'

export function PlaylistPage({ id }: { id: string }): React.JSX.Element {
  const { t } = useTranslation()
  const playlist = useLibrary((s) => s.playlists.find((p) => p.id === id))
  const tracks = useLibrary((s) => s.tracks)
  const search = useUi((s) => s.search)
  const ui = useUi.getState()

  const ids = useMemo(() => (playlist?.trackIds ?? []).filter((tid) => tracks[tid]), [playlist, tracks])
  const shown = useMemo(() => (search ? ids.filter((tid) => matchesQuery(tracks[tid], search)) : ids), [ids, tracks, search])
  const covers = useMemo(() => ids.map((tid) => tracks[tid]?.coverPath).filter(Boolean).slice(0, 4) as string[], [ids, tracks])

  if (!playlist) return <div className="page" />

  const rename = (): void =>
    ui.askText({ title: t('menu.rename'), value: playlist.name, onSubmit: (v) => v.trim() && useLibrary.getState().renamePlaylist(id, v.trim()) })
  const remove = (): void =>
    ui.askConfirm({
      title: t('playlist.deleteConfirm', { name: playlist.name }),
      text: t('playlist.deleteText'),
      danger: true,
      onConfirm: () => {
        useLibrary.getState().deletePlaylist(id)
        ui.navigate({ type: 'library' })
      }
    })

  return (
    <div className="page">
      <header className="playlist-hero drag">
        <button
          type="button"
          className="playlist-hero__cover no-drag"
          title={t('menu.changeCover')}
          onClick={async () => {
            const p = await window.velvet.covers.pick()
            if (p) useLibrary.getState().setPlaylistCover(id, p)
          }}
        >
          {playlist.coverPath || covers.length < 4 ? (
            <Cover path={playlist.coverPath ?? covers[0]} seed={playlist.id} size={196} rounded={20} />
          ) : (
            <div className="mosaic">
              {covers.map((c, i) => (
                <Cover key={i} path={c} seed={`${playlist.id}${i}`} />
              ))}
            </div>
          )}
          <span className="playlist-hero__edit">
            <ImagePlus size={22} />
          </span>
        </button>
        <div className="playlist-hero__info">
          <span className="eyebrow">
            <ListMusic size={14} /> {t('playlist.label')}
          </span>
          <h1 className="no-drag" onDoubleClick={rename}>
            {playlist.name}
          </h1>
          <p>
            {t('common.tracks', { count: ids.length })} · {formatTime(totalDuration(ids.map((tid) => tracks[tid])))}
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
            <IconButton
              label="More"
              onClick={(e) =>
                ui.openMenu(e.clientX, e.clientY, [
                  { label: t('menu.rename'), icon: <Pencil size={16} />, onClick: rename },
                  {
                    label: t('menu.changeCover'),
                    icon: <ImagePlus size={16} />,
                    onClick: async () => {
                      const p = await window.velvet.covers.pick()
                      if (p) useLibrary.getState().setPlaylistCover(id, p)
                    }
                  },
                  ...(playlist.coverPath ? [{ label: t('menu.removeCover'), onClick: () => useLibrary.getState().setPlaylistCover(id, undefined) }] : []),
                  { separator: true },
                  { label: t('menu.delete'), icon: <Trash2 size={16} />, danger: true, onClick: remove }
                ])
              }
            >
              <MoreHorizontal size={20} />
            </IconButton>
          </div>
        </div>
      </header>
      {ids.length === 0 ? (
        <div className="empty empty--small">
          <h2>{t('playlist.emptyTitle')}</h2>
          <p>{t('playlist.emptyText')}</p>
        </div>
      ) : (
        <TrackList ids={shown} playlistId={search ? undefined : id} />
      )}
    </div>
  )
}
