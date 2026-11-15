import type { Track } from '@shared/types'
import { familyAffinity, trackFamily } from './genres'
import { trackKey } from './recommend'
import { splitArtistNames } from './taste'

/** Camelot "8A" → [8, 'A'] */
function camelot(c: string | undefined): [number, string] | null {
  const m = c ? /^(\d{1,2})([AB])$/i.exec(c.trim()) : null
  return m ? [Number(m[1]), m[2].toUpperCase()] : null
}

/** Keys that mix well: the same, ±1 on the wheel, or the relative major / minor. */
export function keysCompatible(a: string | undefined, b: string | undefined): boolean {
  const x = camelot(a)
  const y = camelot(b)
  if (!x || !y) return false
  if (x[0] === y[0]) return true
  const d = Math.abs(x[0] - y[0])
  return x[1] === y[1] && (d === 1 || d === 11)
}

/** Tempo closeness 0..1 (half / double tempo count as close too). */
export function tempoCloseness(a: number | undefined, b: number | undefined): number {
  if (!a || !b) return 0
  const d = Math.min(Math.abs(a - b), Math.abs(a - b * 2), Math.abs(a * 2 - b))
  return Math.max(0, 1 - d / 10)
}

/** How alike two tracks are, by what the library knows about them. */
export function similarity(seed: Track, t: Track): number {
  const sa = splitArtistNames(seed.artist).map((a) => a.toLowerCase())
  const ta = splitArtistNames(t.artist).map((a) => a.toLowerCase())
  let s = 0
  if (sa[0] && sa[0] === ta[0]) s += 0.6
  else if (ta.some((a) => sa.includes(a))) s += 0.4
  // the genre matters most: the same family, or a close one
  s += 1.2 * familyAffinity(trackFamily(seed), trackFamily(t))
  s += 0.6 * tempoCloseness(seed.bpm, t.bpm)
  if (keysCompatible(seed.camelot, t.camelot)) s += 0.4
  if (seed.year && t.year && Math.floor(seed.year / 10) === Math.floor(t.year / 10)) s += 0.3
  if (seed.energy !== undefined && t.energy !== undefined) s += 0.4 * (1 - Math.min(1, Math.abs(seed.energy - t.energy) * 2))
  return s
}

/**
 * The radio without the internet: songs from the library most like the seed, at most two per
 * artist, nothing turned down or already queued; a little randomness so it varies.
 */
export function localRadio(
  seed: Track,
  tracks: Record<string, Track>,
  opts: { n?: number; skip?: Set<string>; banned?: Set<string>; random?: () => number } = {}
): string[] {
  const { n = 25, skip = new Set(), banned = new Set(), random = Math.random } = opts
  const scored = Object.values(tracks)
    .filter((t) => t.id !== seed.id && !t.stream && !skip.has(t.id) && !skip.has(trackKey(t.artist, t.title)) && !banned.has(trackKey(t.artist, t.title)))
    .map((t) => ({ t, s: similarity(seed, t) + random() * 0.35 + (t.liked ? 0.15 : 0) }))
    .sort((a, b) => b.s - a.s)
  const per = new Map<string, number>()
  const out: string[] = []
  for (const { t } of scored) {
    if (out.length >= n) break
    const a = (splitArtistNames(t.artist)[0] ?? '').toLowerCase()
    const c = per.get(a) ?? 0
    if (c >= 2) continue
    per.set(a, c + 1)
    out.push(t.id)
  }
  return out
}
