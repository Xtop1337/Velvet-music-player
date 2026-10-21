import type { SearchResult, SearchSource } from '@shared/types'
import { splitArtistTitle } from './matcher'
import { requireYtDlp, ytdlpJson } from './ytdlp'

interface Entry {
  id?: string
  title?: string
  url?: string
  webpage_url?: string
  uploader?: string
  channel?: string
  artist?: string
  duration?: number
  thumbnail?: string
  thumbnails?: { url: string; width?: number }[]
}

function bestThumb(e: Entry): string | undefined {
  if (e.thumbnail) return e.thumbnail
  const list = [...(e.thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  return list.find((t) => (t.width ?? 0) <= 640)?.url ?? list[0]?.url
}

/** Turns yt-dlp search entries into result cards (exported for tests). */
export function toResults(entries: Entry[], source: SearchSource): SearchResult[] {
  return entries
    .filter((e) => (e.webpage_url || e.url) && e.title)
    .map((e) => {
      const uploader = e.channel ?? e.uploader ?? ''
      const split = splitArtistTitle(e.title!, uploader.replace(/ - Topic$/, ''), e.artist)
      return {
        id: `${source}:${e.id ?? e.url}`,
        title: split.title,
        artist: split.artist,
        duration: e.duration ?? 0,
        url: e.webpage_url ?? e.url!,
        thumbnail: bestThumb(e),
        source
      }
    })
}

export async function search(query: string, source: SearchSource, limit = 20): Promise<SearchResult[]> {
  const q = query.trim()
  if (!q) return []
  const bin = await requireYtDlp()
  const prefix = source === 'soundcloud' ? 'scsearch' : 'ytsearch'
  const flat = await ytdlpJson<{ entries?: Entry[] }>(bin, ['--flat-playlist', `${prefix}${limit}:${q}`])
  let results = toResults(flat.entries ?? [], source)
  // SoundCloud flat results can come back without titles: resolve a smaller page fully
  if (!results.length && (flat.entries?.length ?? 0) > 0) {
    const full = await ytdlpJson<{ entries?: Entry[] }>(bin, [`${prefix}${Math.min(limit, 10)}:${q}`], 120000)
    results = toResults(full.entries ?? [], source)
  }
  return results
}

/** Direct audio stream URL for previewing a result before downloading it. */
export async function previewUrl(url: string): Promise<string> {
  const bin = await requireYtDlp()
  const info = await ytdlpJson<{ url?: string; requested_formats?: { url: string }[] }>(bin, [
    '--no-playlist',
    '-f',
    'bestaudio[protocol^=http][ext=m4a]/bestaudio[protocol^=http][ext=mp3]/bestaudio[protocol^=http]/bestaudio',
    url
  ])
  const direct = info.url ?? info.requested_formats?.[0]?.url
  if (!direct) throw new Error('no stream')
  return direct
}
