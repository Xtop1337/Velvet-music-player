import type { TFunction } from 'i18next'
import { Disc3, ExternalLink, FileAudio, FolderOpen, Heart, Mic2, ListEnd, ListMusic, ListPlus, Pencil, Play, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { splitArtists } from '@renderer/lib/group'
import { useLibrary } from '@renderer/store/library'
import { allPresets, usePlayer } from '@renderer/store/player'
import { useUi, type MenuItem } from '@renderer/store/ui'
import { presetLabel, trackTitle } from './tracks'

export function addToPlaylistToast(playlistId: string, ids: string[], t: TFunction): void {
  const lib = useLibrary.getState()
  const pl = lib.playlists.find((p) => p.id === playlistId)
  if (!pl) return
  const added = lib.addToPlaylist(playlistId, ids)
  useUi.getState().toast(added ? t('playlist.addedTo', { name: pl.name, count: added }) : t('playlist.alreadyThere', { name: pl.name }), added ? 'success' : 'info')
}

export function newPlaylistWith(ids: string[], t: TFunction): void {
  useUi.getState().askText({
    title: t('playlist.namePrompt'),
    value: '',
    placeholder: t('playlist.namePlaceholder'),
    onSubmit: (name) => {
      const id = useLibrary.getState().createPlaylist(name.trim() || t('playlist.defaultName'), ids)
      useUi.getState().toast(t('playlist.addedTo', { name: name.trim() || t('playlist.defaultName'), count: ids.length }), 'success')
      return id
    }
  })
}

/** Context menu for a track row. `context` is the list the row belongs to. */
export function trackMenu(opts: {
  trackId: string
  context: string[]
  index: number
  t: TFunction
  playlistId?: string
  playlistIndex?: number
}): MenuItem[] {
  const { trackId, context, index, t, playlistId, playlistIndex } = opts
  const lib = useLibrary.getState()
  const track = lib.tracks[trackId]
  const player = usePlayer.getState()
  const ui = useUi.getState()
  if (!track) return []
  const presets = allPresets()

  const items: MenuItem[] = [
    { label: t('menu.play'), icon: <Play size={16} />, onClick: () => void player.playQueue(context, index) },
    { label: t('menu.playNext'), icon: <ListPlus size={16} />, onClick: () => player.playNext([trackId]) },
    { label: t('menu.addToQueue'), icon: <ListEnd size={16} />, onClick: () => player.enqueue([trackId]) },
    { separator: true },
    {
      label: t('menu.addToPlaylist'),
      icon: <ListMusic size={16} />,
      children: [
        { label: t('menu.newPlaylist'), icon: <Plus size={16} />, onClick: () => newPlaylistWith([trackId], t) },
        ...(lib.playlists.length ? [{ separator: true } as MenuItem] : []),
        ...lib.playlists.map((p) => ({
          label: p.name,
          disabled: p.id === playlistId,
          checked: p.trackIds.includes(trackId),
          onClick: () => addToPlaylistToast(p.id, [trackId], t)
        }))
      ]
    },
    {
      label: t('menu.preset'),
      icon: <SlidersHorizontal size={16} />,
      children: [
        { label: t('menu.presetNone'), checked: !track.presetId, onClick: () => lib.updateTrack(trackId, { presetId: undefined }) },
        { separator: true },
        ...presets.map((p) => ({
          label: presetLabel(p, t),
          checked: track.presetId === p.id,
          onClick: () => lib.updateTrack(trackId, { presetId: p.id })
        }))
      ]
    },
    { label: t('menu.editInfo'), icon: <Pencil size={16} />, onClick: () => ui.editTags(trackId) },
    { label: t('exportFx.menu'), icon: <FileAudio size={16} />, onClick: () => ui.openExport(trackId) },
    ...(track.album
      ? [{ label: t('menu.goToAlbum'), icon: <Disc3 size={16} />, onClick: () => ui.navigate({ type: 'album', album: track.album, artist: track.artist }) }]
      : []),
    ...(track.artist
      ? [{ label: t('menu.goToArtist'), icon: <Mic2 size={16} />, onClick: () => ui.navigate({ type: 'artist', artist: splitArtists(track.artist)[0] }) }]
      : []),
    { label: t('menu.showInFolder'), icon: <FolderOpen size={16} />, onClick: () => void window.velvet.library.reveal(track.path) }
  ]
  if (track.sourceUrl) {
    items.push({ label: t('menu.openSource'), icon: <ExternalLink size={16} />, onClick: () => void window.velvet.app.openExternal(track.sourceUrl!) })
  }
  items.push({ separator: true })
  if (playlistId !== undefined && playlistIndex !== undefined) {
    items.push({
      label: t('menu.removeFromPlaylist'),
      icon: <X size={16} />,
      onClick: () => lib.removeFromPlaylist(playlistId, playlistIndex)
    })
  }
  items.push({
    label: t('menu.removeFromLibrary'),
    icon: <Trash2 size={16} />,
    danger: true,
    onClick: () =>
      ui.askConfirm({
        title: t('confirmRemove.title', { name: trackTitle(track, t) }),
        text: t('confirmRemove.text'),
        danger: true,
        onConfirm: () => {
          if (usePlayer.getState().currentId === trackId) usePlayer.getState().next()
          lib.removeTracks([trackId])
        }
      })
  })
  return items
}

/** Context menu for several selected rows. */
export function multiTrackMenu(opts: { trackIds: string[]; t: TFunction; playlistId?: string; playlistIndexes?: number[] }): MenuItem[] {
  const { trackIds, t, playlistId, playlistIndexes } = opts
  const lib = useLibrary.getState()
  const player = usePlayer.getState()
  const ui = useUi.getState()
  const n = trackIds.length
  const allLiked = trackIds.every((id) => lib.tracks[id]?.liked)
  const items: MenuItem[] = [
    { label: t('selection.play', { count: n }), icon: <Play size={16} />, onClick: () => void player.playQueue(trackIds, 0) },
    { label: t('menu.playNext'), icon: <ListPlus size={16} />, onClick: () => player.playNext(trackIds) },
    { label: t('menu.addToQueue'), icon: <ListEnd size={16} />, onClick: () => player.enqueue(trackIds) },
    { separator: true },
    {
      label: t('menu.addToPlaylist'),
      icon: <ListMusic size={16} />,
      children: [
        { label: t('menu.newPlaylist'), icon: <Plus size={16} />, onClick: () => newPlaylistWith(trackIds, t) },
        ...(lib.playlists.length ? [{ separator: true } as MenuItem] : []),
        ...lib.playlists.map((p) => ({ label: p.name, disabled: p.id === playlistId, onClick: () => addToPlaylistToast(p.id, trackIds, t) }))
      ]
    },
    {
      label: allLiked ? t('liked.removeAll') : t('liked.addAll'),
      icon: <Heart size={16} />,
      onClick: () => {
        const now = Date.now()
        for (const id of trackIds) lib.updateTrack(id, allLiked ? { liked: false, likedAt: undefined } : { liked: true, likedAt: now })
      }
    },
    {
      label: t('menu.preset'),
      icon: <SlidersHorizontal size={16} />,
      children: [
        { label: t('menu.presetNone'), onClick: () => trackIds.forEach((id) => lib.updateTrack(id, { presetId: undefined })) },
        { separator: true },
        ...allPresets().map((p) => ({ label: presetLabel(p, t), onClick: () => trackIds.forEach((id) => lib.updateTrack(id, { presetId: p.id })) }))
      ]
    },
    { separator: true }
  ]
  if (playlistId && playlistIndexes?.length) {
    items.push({
      label: t('menu.removeFromPlaylist'),
      icon: <X size={16} />,
      onClick: () => {
        // remove from the end so earlier indexes stay valid
        for (const i of [...playlistIndexes].sort((a, b) => b - a)) useLibrary.getState().removeFromPlaylist(playlistId, i)
      }
    })
  }
  items.push({
    label: t('selection.removeFromLibrary', { count: n }),
    icon: <Trash2 size={16} />,
    danger: true,
    onClick: () =>
      ui.askConfirm({
        title: t('selection.removeConfirm', { count: n }),
        text: t('confirmRemove.text'),
        danger: true,
        onConfirm: () => {
          const cur = usePlayer.getState().currentId
          if (cur && trackIds.includes(cur)) usePlayer.getState().stop()
          useLibrary.getState().removeTracks(trackIds)
        }
      })
  })
  return items
}
