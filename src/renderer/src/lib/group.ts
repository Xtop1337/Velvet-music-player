import type { Track } from '@shared/types'

export interface AlbumGroup {
  key: string
  album: string
  artist: string
  trackIds: string[]
  coverPath?: string
  year?: number
  duration: number
}

export interface ArtistGroup {
  name: string
  trackIds: string[]
  albums: number
  coverPath?: string
  plays: number
}

export function albumKey(album: string, artist: string): string {
  return `${album.trim().toLowerCase()}|${artist.trim().toLowerCase()}`
}

/** "A, B & C feat. D" → ["A", "B", "C", "D"] */
export function splitArtists(artist: string): string[] {
  return artist
    .split(/\s*[,;/]\s*|\s+&\s+|\s+(?:feat\.?|ft\.?|featuring|x)\s+/i)
    .map((a) => a.trim())
    .filter(Boolean)
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = ''
  let n = 0
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c]
  return best
}

export function byTrackNo(tracks: Record<string, Track>) {
  return (a: string, b: string): number => {
    const ta = tracks[a]
    const tb = tracks[b]
    return (ta.trackNo ?? 1e9) - (tb.trackNo ?? 1e9) || ta.title.localeCompare(tb.title)
  }
}

/** Groups tracks by album name; the album artist is the most frequent primary artist. */
export function groupAlbums(ids: string[], tracks: Record<string, Track>): AlbumGroup[] {
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const t = tracks[id]
    if (!t?.album.trim()) continue
    const k = t.album.trim().toLowerCase()
    groups.set(k, [...(groups.get(k) ?? []), id])
  }
  const out: AlbumGroup[] = []
  for (const list of groups.values()) {
    const first = tracks[list[0]]
    const artists = list.map((id) => splitArtists(tracks[id].artist)[0] ?? '')
    const distinct = new Set(artists.filter(Boolean))
    const artist = distinct.size > 3 ? 'Various Artists' : mostCommon(artists)
    const sorted = [...list].sort(byTrackNo(tracks))
    out.push({
      key: albumKey(first.album, artist),
      album: first.album.trim(),
      artist,
      trackIds: sorted,
      coverPath: sorted.map((id) => tracks[id].coverPath).find(Boolean),
      year: list.map((id) => tracks[id].year).find(Boolean),
      duration: list.reduce((s, id) => s + (tracks[id].duration || 0), 0)
    })
  }
  return out.sort((a, b) => a.album.localeCompare(b.album))
}

export function groupArtists(ids: string[], tracks: Record<string, Track>): ArtistGroup[] {
  const groups = new Map<string, { name: string; ids: string[] }>()
  for (const id of ids) {
    const t = tracks[id]
    if (!t?.artist.trim()) continue
    for (const name of splitArtists(t.artist)) {
      const k = name.toLowerCase()
      const g = groups.get(k) ?? { name, ids: [] }
      g.ids.push(id)
      groups.set(k, g)
    }
  }
  return [...groups.values()]
    .map((g) => ({
      name: g.name,
      trackIds: g.ids,
      albums: new Set(g.ids.map((id) => tracks[id].album.trim().toLowerCase()).filter(Boolean)).size,
      coverPath: g.ids.map((id) => tracks[id].coverPath).find(Boolean),
      plays: g.ids.reduce((s, id) => s + (tracks[id].playCount ?? 0), 0)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function tracksOfArtist(name: string, ids: string[], tracks: Record<string, Track>): string[] {
  const k = name.toLowerCase()
  return ids.filter((id) => tracks[id] && splitArtists(tracks[id].artist).some((a) => a.toLowerCase() === k))
}

export type SortKey = 'added' | 'title' | 'artist' | 'album' | 'duration' | 'plays'

export function sortTracks(ids: string[], tracks: Record<string, Track>, key: SortKey, desc: boolean): string[] {
  if (key === 'added') return desc ? ids : [...ids].reverse()
  const val = (t: Track): string | number =>
    key === 'title' ? t.title : key === 'artist' ? t.artist : key === 'album' ? t.album : key === 'duration' ? t.duration : (t.playCount ?? 0)
  const sorted = [...ids].sort((a, b) => {
    const va = val(tracks[a])
    const vb = val(tracks[b])
    const c = typeof va === 'number' ? va - (vb as number) : va.localeCompare(vb as string, undefined, { sensitivity: 'base' })
    return c || tracks[a].title.localeCompare(tracks[b].title)
  })
  return desc ? sorted.reverse() : sorted
}
