import type { HistoryEntry, Track } from '@shared/types'

const DAY = 86_400_000

/** When each track was last listened to (history, else the stored lastPlayed). */
export function lastPlayed(tracks: Record<string, Track>, history: HistoryEntry[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of Object.values(tracks)) if (t.lastPlayed) m.set(t.id, t.lastPlayed)
  for (const h of history) if ((m.get(h.t) ?? 0) < h.at) m.set(h.t, h.at)
  return m
}

/** Plays per track (listens of 30 s and more), from the history and stored counts. */
export function playCounts(tracks: Record<string, Track>, history: HistoryEntry[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const h of history) if (h.s >= 30) m.set(h.t, (m.get(h.t) ?? 0) + 1)
  for (const t of Object.values(tracks)) if ((t.playCount ?? 0) > (m.get(t.id) ?? 0)) m.set(t.id, t.playCount!)
  return m
}

/**
 * Songs the user loved (liked, or played 5+ times) but hasn't played for `days` days, most
 * loved first.
 */
export function forgottenTracks(tracks: Record<string, Track>, history: HistoryEntry[], opts: { now?: number; days?: number; limit?: number } = {}): string[] {
  const { now = Date.now(), days = 45, limit = 50 } = opts
  const last = lastPlayed(tracks, history)
  const plays = playCounts(tracks, history)
  const cut = now - days * DAY
  return Object.values(tracks)
    .filter((t) => !t.stream && t.addedAt <= cut)
    .filter((t) => t.liked || (plays.get(t.id) ?? 0) >= 5)
    .filter((t) => (last.get(t.id) ?? t.addedAt) <= cut)
    .map((t) => ({ id: t.id, love: (t.liked ? 5 : 0) + Math.min(10, plays.get(t.id) ?? 0), last: last.get(t.id) ?? t.addedAt }))
    .sort((a, b) => b.love - a.love || a.last - b.last)
    .slice(0, limit)
    .map((x) => x.id)
}
