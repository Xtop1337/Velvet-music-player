import { create } from 'zustand'
import type { GenreFamily } from '@renderer/lib/genres'
import { trackFamily } from '@renderer/lib/genres'
import { trackKey } from '@renderer/lib/recommend'
import { ARTIST_BAN, mainArtist, type Feedback, type Ratings } from '@renderer/lib/taste'

const MAX = 3000

/** What a rating is about. */
export interface Rated {
  artist: string
  title: string
  genre?: string
  family?: GenreFamily | null
  url?: string
}

interface TasteState extends Ratings {
  loaded: boolean
  load: () => Promise<void>
  /** 👍 (weight 1), or a suggestion played to the end (0.3). Takes back a 👎 of the same song. */
  like: (song: Rated, weight?: number) => void
  /** 👎 "Not interested" (1), or a quick skip of a suggestion (0.3). Takes back a 👍. */
  dislike: (song: Rated, weight?: number) => void
  /** removes the rating of a song (either kind) */
  undo: (key: string) => void
  clear: (which: 'likes' | 'dislikes' | 'all') => void
  /** 1 = 👍, -1 = 👎, 0 = not rated by the user */
  rating: (artist: string, title: string) => 1 | -1 | 0
  isDisliked: (artist: string, title: string) => boolean
  isArtistBanned: (artist: string) => boolean
}

let saveTimer: number | null = null

function entry(song: Rated, weight: number): Feedback {
  return {
    key: trackKey(song.artist, song.title),
    artist: song.artist,
    title: song.title,
    weight,
    at: Date.now(),
    family: song.family ?? trackFamily(song),
    url: song.url
  }
}

/** Adds `e` unless the song already has a rating at least as strong. */
function put(list: Feedback[], e: Feedback): Feedback[] {
  if (list.some((d) => d.key === e.key && d.weight >= e.weight)) return list
  return [...list.filter((d) => d.key !== e.key), e].slice(-MAX)
}

export const useTaste = create<TasteState>((set, get) => ({
  likes: [],
  dislikes: [],
  loaded: false,
  load: async () => {
    const data = await window.velvet.store.load<Partial<Ratings>>('taste').catch(() => null)
    set({ likes: Array.isArray(data?.likes) ? data!.likes : [], dislikes: Array.isArray(data?.dislikes) ? data!.dislikes : [], loaded: true })
  },
  like: (song, weight = 1) => {
    const e = entry(song, weight)
    const explicitNo = get().dislikes.some((d) => d.key === e.key && d.weight >= 1)
    // what playback implies never overrides what the user said
    if (weight < 1 && explicitNo) return
    set({ likes: put(get().likes, e), dislikes: get().dislikes.filter((d) => d.key !== e.key) })
  },
  dislike: (song, weight = 1) => {
    const e = entry(song, weight)
    const explicitYes = get().likes.some((d) => d.key === e.key && d.weight >= 1)
    if (weight < 1 && explicitYes) return
    set({ dislikes: put(get().dislikes, e), likes: get().likes.filter((d) => d.key !== e.key) })
  },
  undo: (key) => set({ likes: get().likes.filter((d) => d.key !== key), dislikes: get().dislikes.filter((d) => d.key !== key) }),
  clear: (which) => set({ ...(which !== 'dislikes' ? { likes: [] } : {}), ...(which !== 'likes' ? { dislikes: [] } : {}) }),
  rating: (artist, title) => {
    const key = trackKey(artist, title)
    if (get().likes.some((d) => d.key === key && d.weight >= 1)) return 1
    if (get().dislikes.some((d) => d.key === key && d.weight >= 1)) return -1
    return 0
  },
  isDisliked: (artist, title) => get().rating(artist, title) === -1,
  isArtistBanned: (artist) => {
    const k = mainArtist(artist)
    if (!k || get().likes.some((l) => l.weight >= 1 && mainArtist(l.artist) === k)) return false
    const sum = get().dislikes.reduce((s, d) => s + (mainArtist(d.artist) === k ? d.weight : 0), 0)
    return sum >= ARTIST_BAN
  }
}))

const snapshot = (): Ratings => ({ likes: useTaste.getState().likes, dislikes: useTaste.getState().dislikes })

useTaste.subscribe((s, prev) => {
  if (!s.loaded || !prev.loaded || (s.dislikes === prev.dislikes && s.likes === prev.likes)) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void window.velvet.store.save('taste', snapshot())
  }, 800)
})

window.addEventListener('velvet:flush', () => {
  if (saveTimer && useTaste.getState().loaded) window.velvet.store.saveSync('taste', snapshot())
})
