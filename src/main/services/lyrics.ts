import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFile } from 'music-metadata'
import { toLrc } from '@shared/lrc'
import type { LyricsQuery, LyricsResult } from '@shared/types'
import { paths } from './paths'

const RETRY_EMPTY_MS = 7 * 86_400_000
const UA = 'Velvet music player (https://github.com/)'

function cacheFile(trackId: string): string {
  const dir = join(paths.cache, 'lyrics')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${trackId.replace(/[^a-z0-9]/gi, '')}.json`)
}

async function fromTags(path: string): Promise<LyricsResult | null> {
  try {
    const meta = await parseFile(path, { skipCovers: true })
    for (const l of meta.common.lyrics ?? []) {
      if (l.syncText?.length) return { synced: toLrc(l.syncText), source: 'tags' }
      if (l.text?.trim()) return { plain: l.text.trim(), source: 'tags' }
    }
  } catch {
    // unreadable file
  }
  return null
}

interface LrclibRow {
  plainLyrics?: string | null
  syncedLyrics?: string | null
  instrumental?: boolean
  duration?: number
}

/** Exported for tests: picks the best LRCLIB search hit. */
export function pickLrclib(rows: LrclibRow[], duration: number): LrclibRow | null {
  const usable = rows.filter((r) => r.syncedLyrics || r.plainLyrics || r.instrumental)
  if (!usable.length) return null
  const score = (r: LrclibRow): number =>
    (r.syncedLyrics ? 10 : 0) - (duration && r.duration ? Math.min(10, Math.abs(r.duration - duration)) : 0)
  return usable.sort((a, b) => score(b) - score(a))[0]
}

function toResult(r: LrclibRow | null): LyricsResult {
  if (!r) return { source: 'none' }
  if (r.instrumental && !r.syncedLyrics && !r.plainLyrics) return { source: 'lrclib', instrumental: true }
  return { synced: r.syncedLyrics ?? undefined, plain: r.plainLyrics ?? undefined, source: 'lrclib' }
}

async function fromLrclib(q: LyricsQuery): Promise<LyricsResult> {
  const headers = { 'User-Agent': UA }
  const base = 'https://lrclib.net/api'
  const params = new URLSearchParams({ track_name: q.title, artist_name: q.artist })
  if (q.album) params.set('album_name', q.album)
  if (q.duration) params.set('duration', String(Math.round(q.duration)))
  const exact = await fetch(`${base}/get?${params}`, { headers })
  if (exact.ok) {
    const r = toResult((await exact.json()) as LrclibRow)
    if (r.source !== 'none') return r
  } else if (exact.status !== 404) {
    throw new Error(`LRCLIB HTTP ${exact.status}`)
  }
  const search = await fetch(`${base}/search?${new URLSearchParams({ track_name: q.title, artist_name: q.artist })}`, { headers })
  if (!search.ok) throw new Error(`LRCLIB HTTP ${search.status}`)
  return toResult(pickLrclib((await search.json()) as LrclibRow[], q.duration))
}

export async function getLyrics(q: LyricsQuery): Promise<LyricsResult> {
  const file = cacheFile(q.trackId)
  if (!q.force && existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as LyricsResult & { at: number }
      if (cached.source !== 'none' || Date.now() - cached.at < RETRY_EMPTY_MS) return cached
    } catch {
      // corrupted cache
    }
  }
  let result = await fromTags(q.path)
  if (!result && q.title) {
    try {
      result = await fromLrclib(q)
    } catch (e) {
      // offline: don't cache, report the error
      return { source: 'none', error: e instanceof Error ? e.message : String(e) }
    }
  }
  result ??= { source: 'none' }
  writeFileSync(file, JSON.stringify({ ...result, at: Date.now() }))
  return result
}
