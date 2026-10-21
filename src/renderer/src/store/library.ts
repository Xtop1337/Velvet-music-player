import { create } from 'zustand'
import type { LibraryData, Playlist, Track } from '@shared/types'
import { uid } from '@renderer/lib/format'

interface LibraryState {
  tracks: Record<string, Track>
  /** Track ids, newest first. */
  order: string[]
  playlists: Playlist[]
  loaded: boolean
  missing: Set<string>
  load: () => Promise<void>
  addTracks: (tracks: Track[]) => number
  updateTrack: (id: string, patch: Partial<Track>) => void
  toggleLike: (id: string) => void
  removeTracks: (ids: string[]) => void
  createPlaylist: (name: string, trackIds?: string[]) => string
  renamePlaylist: (id: string, name: string) => void
  deletePlaylist: (id: string) => void
  setPlaylistCover: (id: string, coverPath?: string) => void
  addToPlaylist: (id: string, trackIds: string[]) => number
  removeFromPlaylist: (id: string, index: number) => void
  movePlaylistTrack: (id: string, from: number, to: number) => void
}

let saveTimer: number | null = null

function snapshot(): LibraryData {
  const s = useLibrary.getState()
  return { version: 1, tracks: s.order.map((id) => s.tracks[id]).filter(Boolean), playlists: s.playlists }
}

export const useLibrary = create<LibraryState>((set, get) => ({
  tracks: {},
  order: [],
  playlists: [],
  loaded: false,
  missing: new Set(),
  load: async () => {
    const data = await window.velvet.store.load<LibraryData>('library')
    const tracks: Record<string, Track> = {}
    const order: string[] = []
    for (const t of data?.tracks ?? []) {
      if (tracks[t.id]) continue
      tracks[t.id] = t
      order.push(t.id)
    }
    set({ tracks, order, playlists: data?.playlists ?? [], loaded: true })
    const exists = await window.velvet.library.exists(order.map((id) => tracks[id].path))
    set({ missing: new Set(order.filter((_, i) => !exists[i])) })
  },
  addTracks: (incoming) => {
    const { tracks, order, missing } = get()
    const next = { ...tracks }
    const fresh: string[] = []
    const nextMissing = new Set(missing)
    for (const t of incoming) {
      nextMissing.delete(t.id)
      if (next[t.id]) {
        // re-imported file: refresh technical fields, keep the user's edits
        next[t.id] = { ...next[t.id], duration: next[t.id].duration || t.duration, path: t.path }
        if (t.source !== 'local') next[t.id] = { ...next[t.id], ...t, addedAt: next[t.id].addedAt }
        continue
      }
      next[t.id] = t
      fresh.push(t.id)
    }
    set({ tracks: next, order: [...fresh.reverse(), ...order], missing: nextMissing })
    return fresh.length
  },
  updateTrack: (id, patch) => {
    const t = get().tracks[id]
    if (!t) return
    set({ tracks: { ...get().tracks, [id]: { ...t, ...patch } } })
  },
  toggleLike: (id) => {
    const t = get().tracks[id]
    if (!t) return
    get().updateTrack(id, t.liked ? { liked: false, likedAt: undefined } : { liked: true, likedAt: Date.now() })
  },
  removeTracks: (ids) => {
    const drop = new Set(ids)
    const tracks = { ...get().tracks }
    for (const id of ids) delete tracks[id]
    set({
      tracks,
      order: get().order.filter((id) => !drop.has(id)),
      playlists: get().playlists.map((p) => ({ ...p, trackIds: p.trackIds.filter((id) => !drop.has(id)) }))
    })
  },
  createPlaylist: (name, trackIds = []) => {
    const id = uid()
    set({ playlists: [...get().playlists, { id, name, trackIds: [...trackIds], createdAt: Date.now() }] })
    return id
  },
  renamePlaylist: (id, name) =>
    set({ playlists: get().playlists.map((p) => (p.id === id ? { ...p, name } : p)) }),
  deletePlaylist: (id) => set({ playlists: get().playlists.filter((p) => p.id !== id) }),
  setPlaylistCover: (id, coverPath) =>
    set({ playlists: get().playlists.map((p) => (p.id === id ? { ...p, coverPath } : p)) }),
  addToPlaylist: (id, trackIds) => {
    let added = 0
    set({
      playlists: get().playlists.map((p) => {
        if (p.id !== id) return p
        const have = new Set(p.trackIds)
        const extra = trackIds.filter((t) => !have.has(t))
        added = extra.length
        return { ...p, trackIds: [...p.trackIds, ...extra] }
      })
    })
    return added
  },
  removeFromPlaylist: (id, index) =>
    set({
      playlists: get().playlists.map((p) =>
        p.id === id ? { ...p, trackIds: p.trackIds.filter((_, i) => i !== index) } : p
      )
    }),
  movePlaylistTrack: (id, from, to) =>
    set({
      playlists: get().playlists.map((p) => {
        if (p.id !== id) return p
        const ids = [...p.trackIds]
        const [moved] = ids.splice(from, 1)
        ids.splice(to, 0, moved)
        return { ...p, trackIds: ids }
      })
    })
}))

useLibrary.subscribe((state, prev) => {
  // the load itself is not a change worth writing back
  if (!state.loaded || !prev.loaded) return
  if (state.tracks === prev.tracks && state.order === prev.order && state.playlists === prev.playlists) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void window.velvet.store.save('library', snapshot())
  }, 500)
})

window.addEventListener('beforeunload', () => {
  if (saveTimer && useLibrary.getState().loaded) window.velvet.store.saveSync('library', snapshot())
})
