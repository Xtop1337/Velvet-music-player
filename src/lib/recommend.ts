import type { HistoryEntry, RecommendSeed, SearchResult, Track } from '@shared/types'

const DAY = 86_400_000

/** "Øneheart, reidenshi — Snowfall (Slowed)" → "øneheart|snowfall slowed" (same rule as recommend.rs). */
export function trackKey(artist: string, title: string): string {
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  return `${norm(artist.split(/[,&]/)[0] ?? '')}|${norm(title)}`
}

function primaryArtist(t: Track): string {
  return (t.artist.split(/[,&]/)[0] ?? '').trim().toLowerCase()
}

/**
 * How much a track says about the user's taste right now: listening in the last 30 days
 * (minutes, fading with age), likes, older plays and new additions.
 */
export function tasteScores(tracks: Record<string, Track>, history: HistoryEntry[], now = Date.now()): Map<string, number> {
  const scores = new Map<string, number>()
  const add = (id: string, v: number): void => {
    if (tracks[id]) scores.set(id, (scores.get(id) ?? 0) + v)
  }
  for (const h of history) {
    const age = now - h.at
    if (age < 0 || age > 30 * DAY) continue
    add(h.t, (h.s / 60) * (1 - age / (45 * DAY)))
  }
  for (const t of Object.values(tracks)) {
    if (t.liked) add(t.id, 4 + (t.likedAt && now - t.likedAt < 30 * DAY ? 3 : 0))
    if (t.playCount) add(t.id, Math.min(5, t.playCount * 0.3))
    if (now - t.addedAt < 14 * DAY) add(t.id, 1.5)
  }
  return scores
}

/**
 * Tracks to start recommendations from: the user's favourites of the moment, one per artist.
 * `round` 0 takes the very top; each refresh (`round` > 0) draws another mix from the top few,
 * so "Refresh" brings new suggestions.
 */
export function pickSeeds(
  tracks: Record<string, Track>,
  history: HistoryEntry[],
  opts: { count?: number; round?: number; now?: number; random?: () => number } = {}
): Track[] {
  const { count = 3, round = 0, now = Date.now(), random = Math.random } = opts
  const scores = tasteScores(tracks, history, now)
  let ranked = [...scores.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([id]) => tracks[id])
  if (!ranked.length) {
    // nothing listened or liked yet: the newest additions
    ranked = Object.values(tracks).sort((a, b) => b.addedAt - a.addedAt)
  }
  const pool: Track[] = []
  const artists = new Set<string>()
  for (const t of ranked) {
    if (!t.title && !t.artist) continue
    const a = primaryArtist(t)
    if (a && artists.has(a)) continue
    if (a) artists.add(a)
    pool.push(t)
    if (pool.length >= Math.max(count * 4, 12)) break
  }
  if (round === 0 || pool.length <= count) return pool.slice(0, count)
  // a weighted draw that still favours the top of the pool
  const left = pool.map((t, i) => ({ t, w: 1 / (i + 2) }))
  const out: Track[] = []
  while (out.length < count && left.length) {
    const total = left.reduce((s, x) => s + x.w, 0)
    let r = random() * total
    let i = 0
    while (i < left.length - 1 && r >= left[i].w) {
      r -= left[i].w
      i++
    }
    out.push(left.splice(i, 1)[0].t)
  }
  return out
}

export function toSeed(t: Track): RecommendSeed {
  return { artist: t.artist, title: t.title, url: t.sourceUrl }
}

/** Drops suggestions the user already has (same song, or imported from the same link). */
export function withoutKnown(results: SearchResult[], tracks: Record<string, Track>): SearchResult[] {
  const keys = new Set<string>()
  const urls = new Set<string>()
  for (const t of Object.values(tracks)) {
    keys.add(trackKey(t.artist, t.title))
    if (t.sourceUrl) urls.add(t.sourceUrl)
  }
  return results.filter((r) => !urls.has(r.url) && !keys.has(trackKey(r.artist, r.title)))
}
