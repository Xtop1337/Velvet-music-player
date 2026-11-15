import type { HistoryEntry, Track } from '@shared/types'
import { trackFamily, type GenreFamily } from './genres'
import { trackKey } from './recommend'

const DAY = 86_400_000

/**
 * A rating of a song: 👍 / 👎 pressed by the user (weight 1), or what playback itself says
 * (weight 0.3: a suggested song played to the end, or skipped within seconds).
 */
export interface Feedback {
  key: string
  artist: string
  title?: string
  weight: number
  at: number
  /** the song's genre family, when known */
  family?: GenreFamily | null
  /** the song's page (a liked song can start the wave) */
  url?: string
}
export type Dislike = Feedback

export interface Ratings {
  likes: Feedback[]
  dislikes: Feedback[]
}

export interface Weighted {
  name: string
  weight: number
}

export interface TasteProfile {
  /** the user's artists, strongest first */
  artists: Weighted[]
  genres: Weighted[]
  /** genre families with their share of the taste (0..1, summing to 1), biggest first */
  families: Map<GenreFamily, number>
  /** the family each artist (lower-cased) mostly plays in the library */
  artistFamily: Map<string, GenreFamily>
  /** artists turned down often enough to never be suggested */
  excludeArtists: string[]
  /** songs not to suggest: turned down, or already in the library */
  excludeKeys: string[]
  /** songs the user turned down (👎), including their own */
  refused: string[]
}

/** An artist turned down this much (two "Not interested") is no longer suggested. */
export const ARTIST_BAN = 2

export function splitArtistNames(artist: string): string[] {
  return artist
    .split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)
    .map((a) => a.trim())
    .filter(Boolean)
}

export function mainArtist(artist: string): string {
  return (splitArtistNames(artist)[0] ?? '').toLowerCase()
}

function decay(age: number, halfLifeDays: number): number {
  return Math.pow(0.5, Math.max(0, age) / (halfLifeDays * DAY))
}

/**
 * How much each track says about the user's taste — over the *whole* library, not a few seeds:
 * listening time (recent counts more), skips (minus), likes, play counts, new additions, and a
 * little for simply being in the library.
 */
export function trackWeights(tracks: Record<string, Track>, history: HistoryEntry[], now = Date.now()): Map<string, number> {
  const w = new Map<string, number>()
  const add = (id: string, v: number): void => {
    if (tracks[id] && !tracks[id].stream) w.set(id, (w.get(id) ?? 0) + v)
  }
  for (const t of Object.values(tracks)) {
    if (t.stream) continue
    add(t.id, 0.15)
    if (t.liked) add(t.id, 3 + (t.likedAt && now - t.likedAt < 60 * DAY ? 2 : 0))
    if (t.playCount) add(t.id, Math.min(4, Math.log2(1 + t.playCount)))
    if (now - t.addedAt < 30 * DAY) add(t.id, 1)
  }
  for (const h of history) {
    const t = tracks[h.t]
    if (!t) continue
    const age = now - h.at
    const short = t.duration > 0 && t.duration < 60
    if (h.s >= 30 || (short && h.s >= t.duration / 2)) add(h.t, (Math.min(h.s, 600) / 60) * decay(age, 30))
    else if (h.s < 20 && !short) add(h.t, -0.3 * decay(age, 30))
  }
  return w
}

function asRatings(r: Feedback[] | Ratings): Ratings {
  return Array.isArray(r) ? { likes: [], dislikes: r } : r
}

/**
 * The user's taste: artists, genre families and what not to suggest. Built from the whole
 * library and listening history, then shifted by 👍 (more of the artist and the family) and
 * 👎 (the song never again, less of the artist, a little less of the family).
 */
export function buildProfile(tracks: Record<string, Track>, history: HistoryEntry[], ratings: Feedback[] | Ratings, now = Date.now()): TasteProfile {
  const { likes, dislikes } = asRatings(ratings)
  const weights = trackWeights(tracks, history, now)
  const artists = new Map<string, { name: string; weight: number }>()
  const genres = new Map<string, number>()
  const families = new Map<GenreFamily, number>()
  const perArtist = new Map<string, Map<GenreFamily, number>>()
  const addFamily = (f: GenreFamily | null | undefined, v: number): void => {
    if (f && f !== 'other') families.set(f, (families.get(f) ?? 0) + v)
  }
  const addArtist = (name: string, v: number): void => {
    const k = name.toLowerCase()
    if (!k) return
    const cur = artists.get(k) ?? { name, weight: 0 }
    cur.weight += v
    artists.set(k, cur)
  }
  for (const [id, v] of weights) {
    const t = tracks[id]
    const names = splitArtistNames(t.artist)
    names.forEach((name, i) => addArtist(name, v * (i === 0 ? 1 : 0.5)))
    if (t.genre) genres.set(t.genre, (genres.get(t.genre) ?? 0) + v)
    const family = trackFamily(t)
    if (v > 0) addFamily(family, v)
    if (family && names[0] && v > 0) {
      const k = names[0].toLowerCase()
      const m = perArtist.get(k) ?? new Map<GenreFamily, number>()
      m.set(family, (m.get(family) ?? 0) + v)
      perArtist.set(k, m)
    }
  }
  // the scale of one explicit rating: about a much-played favourite
  for (const l of likes) {
    const d = decay(now - l.at, 120)
    addArtist(splitArtistNames(l.artist)[0] ?? '', 3 * l.weight * d)
    addFamily(l.family, 2.5 * l.weight * d)
  }
  const banned = new Map<string, number>()
  for (const d of dislikes) {
    const k = mainArtist(d.artist)
    if (!k) continue
    banned.set(k, (banned.get(k) ?? 0) + d.weight)
    const a = artists.get(k)
    if (a) a.weight -= 2 * d.weight
    if (d.family && families.has(d.family)) families.set(d.family, Math.max(0, families.get(d.family)! - 0.8 * d.weight * decay(now - d.at, 120)))
  }
  // a liked artist is not banned by older refusals
  for (const l of likes) if (l.weight >= 1) banned.delete(mainArtist(l.artist))
  // a song turned down ("Not interested") is never suggested again; quick skips only lower its artist
  const excludeKeys = new Set(dislikes.filter((d) => d.weight >= 1).map((d) => d.key))
  for (const t of Object.values(tracks)) if (!t.stream) excludeKeys.add(trackKey(t.artist, t.title))
  const total = [...families.values()].reduce((s, v) => s + v, 0)
  const shares = new Map<GenreFamily, number>(
    [...families.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([f, v]) => [f, v / (total || 1)])
  )
  const artistFamily = new Map<string, GenreFamily>()
  for (const [k, m] of perArtist) artistFamily.set(k, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0])
  return {
    artists: [...artists.values()].filter((a) => a.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 30),
    genres: [...genres.entries()].map(([name, weight]) => ({ name, weight })).filter((g) => g.weight > 0).sort((a, b) => b.weight - a.weight),
    families: shares,
    artistFamily,
    excludeArtists: [...banned.entries()].filter(([, v]) => v >= ARTIST_BAN).map(([k]) => k),
    excludeKeys: [...excludeKeys],
    refused: dislikes.filter((d) => d.weight >= 1).map((d) => d.key)
  }
}
