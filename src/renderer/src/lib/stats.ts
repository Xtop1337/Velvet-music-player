import type { HistoryEntry, Track } from '@shared/types'

export type Period = '7d' | '30d' | '365d' | 'all'

const DAY = 86_400_000

/** A listen counts after 30 s, or half of a short track. */
export function countsAsPlay(listenedSec: number, durationSec: number): boolean {
  return listenedSec >= 30 || (durationSec > 0 && listenedSec >= durationSec / 2)
}

export function periodStart(period: Period, now = Date.now()): number {
  if (period === 'all') return 0
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 365
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime() - (days - 1) * DAY
}

export interface RankRow {
  key: string
  label: string
  sub?: string
  plays: number
  seconds: number
  trackId?: string
}

export interface StatsSummary {
  seconds: number
  plays: number
  uniqueTracks: number
  topTracks: RankRow[]
  topArtists: RankRow[]
  topAlbums: RankRow[]
  /** listening minutes per bucket (day, or month for long ranges) */
  buckets: { start: number; label: string; minutes: number }[]
  bucketUnit: 'day' | 'month'
}

function rank(map: Map<string, RankRow>, n: number): RankRow[] {
  return [...map.values()].sort((a, b) => b.plays - a.plays || b.seconds - a.seconds).slice(0, n)
}

export function summarize(history: HistoryEntry[], tracks: Record<string, Track>, period: Period, locale: string, now = Date.now()): StatsSummary {
  const from = periodStart(period, now)
  const rows = history.filter((h) => h.at >= from && h.at <= now)
  const byTrack = new Map<string, RankRow>()
  const byArtist = new Map<string, RankRow>()
  const byAlbum = new Map<string, RankRow>()
  let seconds = 0
  const add = (map: Map<string, RankRow>, key: string, row: Omit<RankRow, 'plays' | 'seconds'>, s: number): void => {
    const r = map.get(key) ?? { ...row, plays: 0, seconds: 0 }
    r.plays++
    r.seconds += s
    map.set(key, r)
  }
  for (const h of rows) {
    seconds += h.s
    const t = tracks[h.t]
    if (!t) continue
    add(byTrack, t.id, { key: t.id, label: t.title, sub: t.artist, trackId: t.id }, h.s)
    if (t.artist) add(byArtist, t.artist.toLowerCase(), { key: t.artist, label: t.artist }, h.s)
    if (t.album) add(byAlbum, `${t.album}|${t.artist}`.toLowerCase(), { key: `${t.album}|${t.artist}`, label: t.album, sub: t.artist, trackId: t.id }, h.s)
  }

  // time buckets
  const first = from || (rows.length ? Math.min(...rows.map((r) => r.at)) : now)
  const span = (now - first) / DAY
  const bucketUnit: 'day' | 'month' = span > 92 ? 'month' : 'day'
  const buckets: StatsSummary['buckets'] = []
  const start = new Date(first)
  start.setHours(0, 0, 0, 0)
  if (bucketUnit === 'month') start.setDate(1)
  const fmt = new Intl.DateTimeFormat(locale, bucketUnit === 'day' ? { day: 'numeric', month: 'short' } : { month: 'short', year: '2-digit' })
  for (const d = new Date(start); d.getTime() <= now; bucketUnit === 'day' ? d.setDate(d.getDate() + 1) : d.setMonth(d.getMonth() + 1)) {
    buckets.push({ start: d.getTime(), label: fmt.format(d), minutes: 0 })
  }
  for (const h of rows) {
    let i = buckets.length - 1
    while (i > 0 && buckets[i].start > h.at) i--
    if (buckets[i]) buckets[i].minutes += h.s / 60
  }

  return {
    seconds,
    plays: rows.length,
    uniqueTracks: new Set(rows.map((r) => r.t)).size,
    topTracks: rank(byTrack, 10),
    topArtists: rank(byArtist, 8),
    topAlbums: rank(byAlbum, 6),
    buckets,
    bucketUnit
  }
}
