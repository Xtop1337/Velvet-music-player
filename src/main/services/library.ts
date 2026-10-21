import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { parseFile } from 'music-metadata'
import { AUDIO_EXTENSIONS } from '@shared/defaults'
import type { Track, TrackSource } from '@shared/types'
import { saveCoverBuffer } from './covers'

export function trackIdForPath(file: string): string {
  return createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 16)
}

export function isAudioFile(file: string): boolean {
  return AUDIO_EXTENSIONS.includes(extname(file).slice(1).toLowerCase())
}

async function collect(entry: string, out: string[], depth = 0): Promise<void> {
  if (depth > 12) return
  let info
  try {
    info = await stat(entry)
  } catch {
    return
  }
  if (info.isDirectory()) {
    const children = await readdir(entry).catch(() => [] as string[])
    for (const child of children) {
      if (child.startsWith('.')) continue
      await collect(join(entry, child), out, depth + 1)
    }
  } else if (info.isFile() && isAudioFile(entry)) {
    out.push(entry)
  }
}

/** Guesses "Artist - Title" from a file name when tags are missing. */
export function guessFromFileName(file: string): { title: string; artist: string } {
  const name = basename(file, extname(file)).replace(/_/g, ' ').trim()
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(name)
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: name }
}

export async function readTrack(file: string, source: TrackSource = 'local'): Promise<Track> {
  const guess = guessFromFileName(file)
  const track: Track = {
    id: trackIdForPath(file),
    path: file,
    title: guess.title,
    artist: guess.artist,
    album: '',
    duration: 0,
    source,
    addedAt: Date.now()
  }
  try {
    const meta = await parseFile(file, { duration: true })
    const c = meta.common
    if (c.title) track.title = c.title
    const artist = c.artists?.length ? c.artists.join(', ') : c.artist
    if (artist) track.artist = artist
    if (c.album) track.album = c.album
    if (c.track?.no) track.trackNo = c.track.no
    if (c.year) track.year = c.year
    track.duration = meta.format.duration ?? 0
    const pic = c.picture?.find((p) => /front|cover/i.test(p.type ?? '')) ?? c.picture?.[0]
    if (pic?.data?.length) track.coverPath = saveCoverBuffer(pic.data, pic.format || 'image/jpeg')
  } catch {
    // unreadable tags: keep the file-name guess, duration is filled in by the player
  }
  return track
}

export async function scanPaths(inputs: string[], onProgress?: (done: number, total: number) => void): Promise<Track[]> {
  const files: string[] = []
  for (const input of inputs) await collect(input, files)
  const unique = [...new Set(files)]
  const tracks: Track[] = []
  for (let i = 0; i < unique.length; i++) {
    tracks.push(await readTrack(unique[i]))
    onProgress?.(i + 1, unique.length)
  }
  return tracks
}
