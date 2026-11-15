import type { HistoryEntry, Track } from '@shared/types'
import { tasteFit, trackFamily, type GenreFamily } from './genres'
import { lastPlayed } from './forgotten'
import { similarity } from './radio'
import { splitArtistNames, trackWeights } from './taste'

const DAY = 86_400_000

export type Mood = 'energetic' | 'calm' | 'melancholic'

export interface DailyMix {
  id: string
  kind: 'genre' | 'artist' | 'mood'
  family?: GenreFamily
  mood?: Mood
  /** the artist an artist mix is built around */
  artist?: string
  /** artists the mix is about (for adding new songs like them) */
  artists: { name: string; weight: number }[]
  /** library tracks, in play order */
  trackIds: string[]
  /** songs from the internet added for the day (filled later) */
  newIds: string[]
}

/** Deterministic random numbers for a day: the same mixes all day, new ones tomorrow. */
export function seeded(seed: string): () => number {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function today(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function moodOf(t: Track): Mood | null {
  if (t.energy === undefined) return null
  const minor = /minor/i.test(t.key ?? '')
  if ((t.bpm ?? 0) >= 118 && t.energy >= 0.6) return 'energetic'
  if (minor && t.energy <= 0.6) return 'melancholic'
  if (t.energy <= 0.45 || ((t.bpm ?? 200) <= 95 && t.energy <= 0.55)) return 'calm'
  return null
}

/** Picks `n` ids at random, favouring higher weights, never the same twice. */
function weightedSample(ids: string[], weight: (id: string) => number, n: number, rnd: () => number): string[] {
  const pool = ids.map((id) => ({ id, w: Math.max(0.05, weight(id)) }))
  const out: string[] = []
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, p) => s + p.w, 0)
    let r = rnd() * total
    let i = 0
    while (i < pool.length - 1 && r >= pool[i].w) {
      r -= pool[i].w
      i++
    }
    out.push(pool.splice(i, 1)[0].id)
  }
  return out
}

/**
 * Reorders so no artist plays twice in a row whenever that is possible: each step takes the
 * artist with the most songs left (other than the previous one), keeping each artist's order.
 */
export function spread(ids: string[], tracks: Record<string, Track>): string[] {
  const artist = (id: string): string => (splitArtistNames(tracks[id]?.artist ?? '')[0] ?? '').toLowerCase()
  const queues = new Map<string, string[]>()
  ids.forEach((id) => {
    const a = artist(id)
    queues.set(a, [...(queues.get(a) ?? []), id])
  })
  const first = new Map(ids.map((id, i) => [id, i]))
  const out: string[] = []
  let prev: string | null = null
  while (out.length < ids.length) {
    let best: string | null = null
    for (const [a, q] of queues) {
      if (!q.length || a === prev) continue
      const bq = best === null ? null : queues.get(best)!
      if (!bq || q.length > bq.length || (q.length === bq.length && first.get(q[0])! < first.get(bq[0])!)) best = a
    }
    // only the previous artist is left: it has to repeat
    if (best === null) best = prev!
    out.push(queues.get(best)!.shift()!)
    prev = best
  }
  return out
}

function topArtists(ids: string[], tracks: Record<string, Track>, w: Map<string, number>, n = 6): { name: string; weight: number }[] {
  const m = new Map<string, { name: string; weight: number }>()
  for (const id of ids) {
    const name = splitArtistNames(tracks[id].artist)[0]
    if (!name) continue
    const cur = m.get(name.toLowerCase()) ?? { name, weight: 0 }
    cur.weight += (w.get(id) ?? 0) + 0.1
    m.set(name.toLowerCase(), cur)
  }
  return [...m.values()].sort((a, b) => b.weight - a.weight).slice(0, n)
}

/**
 * Up to 6 daily mixes from the library: the user's main genres (or, without genre tags, their
 * main artists with similar songs), plus moods once enough tracks are analysed. Favourites come
 * up more often, songs not played for a month get a nudge, and everything changes each day.
 */
export function buildDailyMixes(
  tracks: Record<string, Track>,
  history: HistoryEntry[],
  opts: { date?: string; now?: number; size?: number; max?: number } = {}
): DailyMix[] {
  const now = opts.now ?? Date.now()
  const date = opts.date ?? today(now)
  const size = opts.size ?? 20
  const max = opts.max ?? 6
  const rnd = seeded(date)
  const lib = Object.values(tracks).filter((t) => !t.stream)
  if (lib.length < 8) return []
  const w = trackWeights(tracks, history, now)
  const last = lastPlayed(tracks, history)
  const weight = (id: string): number => {
    const base = (w.get(id) ?? 0) + 0.3
    const quiet = now - (last.get(id) ?? tracks[id].addedAt) > 30 * DAY
    return base * (quiet ? 1.3 : 1) * (0.7 + rnd() * 0.6)
  }
  const mixes: DailyMix[] = []
  const make = (kind: DailyMix['kind'], pool: string[], extra: Partial<DailyMix>): void => {
    const picked = spread(weightedSample(pool, weight, size, rnd), tracks)
    mixes.push({ id: `${kind}:${extra.family ?? extra.mood ?? extra.artist ?? mixes.length}`, kind, artists: topArtists(picked, tracks, w), trackIds: picked, newIds: [], ...extra })
  }

  // genres
  const byFamily = new Map<GenreFamily, string[]>()
  // how much of the taste each family is (for the mood mixes below)
  const taste = new Map<GenreFamily, number>()
  for (const t of lib) {
    // the title counts too: "… PHONK", "MONTAGEM …" name the genre when the tag doesn't
    const f = trackFamily(t)
    if (!f || f === 'other') continue
    byFamily.set(f, [...(byFamily.get(f) ?? []), t.id])
    taste.set(f, (taste.get(f) ?? 0) + Math.max(0, w.get(t.id) ?? 0) + 0.1)
  }
  const families = [...byFamily.entries()]
    .filter(([, ids]) => ids.length >= 8)
    .map(([f, ids]) => ({ f, ids, score: ids.reduce((s, id) => s + (w.get(id) ?? 0), 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
  for (const { f, ids } of families) make('genre', ids, { family: f })

  // without enough genres: the main artists, each with the library songs most like them
  if (mixes.length < 3) {
    const artists = topArtists(lib.map((t) => t.id), tracks, w, 12)
    const used = new Set<string>()
    for (const a of artists) {
      if (mixes.length >= 4) break
      if (used.has(a.name.toLowerCase())) continue
      const own = lib.filter((t) => (splitArtistNames(t.artist)[0] ?? '').toLowerCase() === a.name.toLowerCase())
      if (!own.length) continue
      const seed = own.reduce((b, t) => ((w.get(t.id) ?? 0) > (w.get(b.id) ?? 0) ? t : b), own[0])
      const near = lib
        .filter((t) => t.id !== seed.id)
        .map((t) => ({ id: t.id, s: similarity(seed, t) }))
        .filter((x) => x.s > 0.25)
        .sort((x, y) => y.s - x.s)
        .slice(0, size * 2)
        .map((x) => x.id)
      const pool = [...new Set([...own.map((t) => t.id), ...near])]
      if (pool.length < 6) continue
      used.add(a.name.toLowerCase())
      make('artist', pool, { artist: a.name })
    }
  }

  // moods, when enough of the library is analysed
  const analysed = lib.filter((t) => t.energy !== undefined)
  if (analysed.length >= Math.max(10, lib.length * 0.3)) {
    for (const mood of ['energetic', 'calm', 'melancholic'] as const) {
      if (mixes.length >= max) break
      // a mood mix stays within the genres the user actually listens to
      const ids = analysed
        .filter((t) => moodOf(t) === mood)
        .filter((t) => {
          const f = trackFamily(t)
          return !taste.size || !f || tasteFit(f, taste) >= 0.35
        })
        .map((t) => t.id)
      if (ids.length >= 10) make('mood', ids, { mood })
    }
  }
  return mixes.slice(0, max)
}

/** Puts the new songs between the library ones (about one in four). */
export function withNewSongs(mix: DailyMix): string[] {
  const out: string[] = []
  let j = 0
  mix.trackIds.forEach((id, i) => {
    out.push(id)
    if (i % 3 === 2 && j < mix.newIds.length) out.push(mix.newIds[j++])
  })
  return [...out, ...mix.newIds.slice(j)]
}
