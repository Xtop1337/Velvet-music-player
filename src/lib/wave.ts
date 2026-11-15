import type { SearchResult, Track } from '@shared/types'
import { genreFamily, keywordFamily, tasteFit, trackFamily, type GenreFamily } from './genres'
import { trackKey } from './recommend'
import { mainArtist, type Feedback, type TasteProfile } from './taste'

/** How far the wave may stray from the user's main genres. */
export type WaveMode = 'favorite' | 'balance' | 'discover'
export const WAVE_MODE_IDS: WaveMode[] = ['favorite', 'balance', 'discover']

export const WAVE_MODES: Record<WaveMode, { own: number; minFit: number; familiar: number }> = {
  /** mostly the user's own songs; new ones only from the main genre and its closest neighbours */
  favorite: { own: 0.6, minFit: 0.8, familiar: 0.5 },
  balance: { own: 0.35, minFit: 0.35, familiar: 0.3 },
  /** mostly new songs, neighbouring genres welcome */
  discover: { own: 0.15, minFit: 0, familiar: 0.1 }
}

/** How well a song with an unknown genre is assumed to fit. */
const UNKNOWN_FIT = 0.5

export interface WaveSeed {
  artist: string
  title: string
  url?: string
  family: GenreFamily | null
  /** library track id, when the seed is one */
  id?: string
}

/** The label the backend puts into `because` for songs found from a seed (same rule as `seed_label`). */
export function seedLabel(s: { artist: string; title: string }): string {
  return s.artist.trim() ? `${s.artist.trim()} — ${s.title.trim()}` : s.title.trim()
}

function fitOf(family: GenreFamily | null, profile: TasteProfile): number {
  if (!profile.families.size) return 1
  return family ? tasteFit(family, profile.families) : UNKNOWN_FIT
}

function onService(url: string | undefined, service: 'soundcloud' | 'youtube'): boolean {
  if (!url) return false
  return service === 'soundcloud' ? /soundcloud\.com/.test(url) : /youtube\.com|youtu\.be/.test(url)
}

/**
 * The songs a batch of the wave starts from: the user's strongest songs of the genres the mode
 * allows, one per artist, a different handful each time (`avoid` = seeds used lately). Songs
 * liked in the wave itself (`liked`) join in, so the wave follows what was just approved.
 */
export function pickWaveSeeds(
  tracks: Record<string, Track>,
  weights: Map<string, number>,
  profile: TasteProfile,
  mode: WaveMode,
  opts: { count?: number; service?: 'soundcloud' | 'youtube'; avoid?: Set<string>; liked?: Feedback[]; random?: () => number; now?: number } = {}
): WaveSeed[] {
  const { count = 4, service = 'youtube', avoid = new Set<string>(), liked = [], random = Math.random, now = Date.now() } = opts
  const minFit = WAVE_MODES[mode].minFit
  interface Cand extends WaveSeed {
    score: number
    fit: number
  }
  const cands: Cand[] = []
  for (const [id, w] of weights) {
    const t = tracks[id]
    if (!t || t.stream || w <= 0 || (!t.title && !t.artist)) continue
    const family = trackFamily(t)
    const fit = fitOf(family, profile)
    cands.push({
      id,
      artist: t.artist,
      title: t.title,
      url: t.sourceUrl,
      family,
      fit,
      score: w * (0.25 + fit) * (onService(t.sourceUrl, service) ? 1.4 : 1) * (0.6 + random() * 0.8)
    })
  }
  // 👍 in the wave within the last two weeks: strong seeds, and they already have a page
  for (const l of liked) {
    if (l.weight < 1 || !l.title || now - l.at > 14 * 86_400_000) continue
    const family = l.family ?? null
    const fit = fitOf(family, profile)
    cands.push({ artist: l.artist, title: l.title, url: l.url, family, fit, score: 4 * (0.25 + fit) * (onService(l.url, service) ? 1.4 : 1) * (0.6 + random() * 0.8) })
  }
  const pick = (threshold: number, used: Set<string>, out: Cand[]): void => {
    for (const c of [...cands].sort((a, b) => b.score - a.score)) {
      if (out.length >= count) return
      const key = trackKey(c.artist, c.title)
      const artist = mainArtist(c.artist)
      if (c.fit < threshold || avoid.has(key) || used.has(key) || (artist && used.has(`a:${artist}`))) continue
      used.add(key)
      if (artist) used.add(`a:${artist}`)
      out.push(c)
    }
  }
  const out: Cand[] = []
  const used = new Set<string>()
  pick(minFit, used, out)
  // a small library may not have enough songs of the main genre that weren't used lately
  if (out.length < Math.min(2, count)) {
    avoid.clear()
    pick(minFit, used, out)
  }
  if (!out.length) pick(0, used, out)
  return out.map(({ score: _s, fit: _f, ...seed }) => seed)
}

export interface RankContext {
  profile: TasteProfile
  mode: WaveMode
  /** seed label → the seed's family (songs found from a seed are taken to share its genre) */
  seedFamilies: Map<string, GenreFamily | null>
  /** `trackKey`s already in the queue or shown */
  skip?: Set<string>
  /** the taste to fit instead of the profile's (radio by track: the seed's family only) */
  families?: Map<GenreFamily, number>
  minFit?: number
  random?: () => number
}

/**
 * The genre family of a suggested song: named in its own title / genre if possible, otherwise
 * that of the seed (or the user's artist) it was found from.
 */
export function candidateFamily(r: SearchResult, ctx: Pick<RankContext, 'seedFamilies' | 'profile'>): GenreFamily | null {
  const tagged = genreFamily(r.genre)
  if (tagged === 'phonk' || tagged === 'funk') return tagged
  const worded = keywordFamily(`${r.title} ${r.artist}`)
  if (worded) return worded
  if (tagged && tagged !== 'other') return tagged
  // an artist the user already has plays what they play in the library
  const own = ctx.profile.artistFamily.get(mainArtist(r.artist))
  if (own) return own
  if (r.because) {
    const fromSeed = ctx.seedFamilies.get(r.because)
    if (fromSeed) return fromSeed
    const fromArtist = ctx.profile.artistFamily.get(mainArtist(r.because))
    if (fromArtist) return fromArtist
  }
  return null
}

/**
 * Orders suggested songs for the wave / "New for you" and drops the ones that don't belong:
 * rated 👎, already owned or queued, by a banned artist, or of a genre the mode doesn't allow.
 * Songs closer to the taste and earlier in their source list come first; at most two per artist,
 * never the same artist twice in a row when that can be avoided.
 */
export function rankCandidates(cands: SearchResult[], ctx: RankContext): { result: SearchResult; family: GenreFamily | null; fit: number }[] {
  const { profile, mode, random = Math.random } = ctx
  const families = ctx.families ?? profile.families
  const minFit = ctx.minFit ?? WAVE_MODES[mode].minFit
  const excluded = new Set(profile.excludeKeys)
  const banned = new Set(profile.excludeArtists)
  const artistWeight = new Map(profile.artists.map((a) => [a.name.toLowerCase(), a.weight]))
  const topArtist = profile.artists[0]?.weight || 1
  const seen = new Set(ctx.skip ?? [])
  const scored: { result: SearchResult; family: GenreFamily | null; fit: number; score: number; artist: string }[] = []
  cands.forEach((r, i) => {
    const key = trackKey(r.artist, r.title)
    const artist = mainArtist(r.artist)
    if (seen.has(key) || excluded.has(key) || banned.has(artist)) return
    seen.add(key)
    const family = candidateFamily(r, ctx)
    const fit = !families.size ? 1 : family ? tasteFit(family, families) : UNKNOWN_FIT
    if (fit < minFit) return
    const known = (artistWeight.get(artist) ?? 0) / topArtist
    const score = (0.35 + fit) * (1 + 0.5 * known) * (1 / (1 + 0.025 * i)) * (0.85 + random() * 0.3)
    scored.push({ result: r, family, fit, score, artist })
  })
  scored.sort((a, b) => b.score - a.score)
  const per = new Map<string, number>()
  const kept = scored.filter((s) => {
    const n = per.get(s.artist) ?? 0
    if (s.artist && n >= 2) return false
    per.set(s.artist, n + 1)
    return true
  })
  // no artist twice in a row
  const out: typeof kept = []
  const rest = [...kept]
  while (rest.length) {
    const prev = out.length ? out[out.length - 1].artist : null
    const i = rest.findIndex((s) => !s.artist || s.artist !== prev)
    out.push(rest.splice(i < 0 ? 0 : i, 1)[0])
  }
  return out.map(({ result, family, fit }) => ({ result, family, fit }))
}

/**
 * The user's own songs for the wave: favourites of the genres the mode allows, picked at random
 * with their taste weight, one artist never twice in a row, nothing from `skip`.
 */
export function ownPicks(
  tracks: Record<string, Track>,
  weights: Map<string, number>,
  profile: TasteProfile,
  mode: WaveMode,
  n: number,
  opts: { skip?: Set<string>; families?: Map<GenreFamily, number>; minFit?: number; random?: () => number } = {}
): string[] {
  const { skip = new Set<string>(), random = Math.random } = opts
  const families = opts.families ?? profile.families
  const banned = new Set(profile.excludeArtists)
  // a song of the user's own that got a 👎 doesn't come back in the wave
  const refused = new Set(profile.refused)
  const pool = (minFit: number): { id: string; w: number; artist: string }[] => {
    const out: { id: string; w: number; artist: string }[] = []
    for (const [id, w] of weights) {
      const t = tracks[id]
      if (!t || t.stream || w <= 0 || skip.has(id) || banned.has(mainArtist(t.artist)) || refused.has(trackKey(t.artist, t.title))) continue
      const family = trackFamily(t)
      const fit = !families.size ? 1 : family ? tasteFit(family, families) : UNKNOWN_FIT
      if (fit < minFit) continue
      out.push({ id, w: w * (0.2 + fit), artist: mainArtist(t.artist) })
    }
    return out
  }
  let left = pool(opts.minFit ?? WAVE_MODES[mode].minFit)
  if (left.length < n) left = pool(0)
  const picked: { id: string; artist: string }[] = []
  while (picked.length < n && left.length) {
    const total = left.reduce((s, x) => s + x.w, 0)
    let r = random() * total
    let i = 0
    while (i < left.length - 1 && r >= left[i].w) {
      r -= left[i].w
      i++
    }
    picked.push(left.splice(i, 1)[0])
  }
  const out: string[] = []
  const rest = [...picked]
  while (rest.length) {
    const prev = out.length ? picked.find((p) => p.id === out[out.length - 1])?.artist : null
    const i = rest.findIndex((p) => !p.artist || p.artist !== prev)
    out.push(rest.splice(i < 0 ? 0 : i, 1)[0].id)
  }
  return out
}

/** Interleaves the user's own songs with new ones so that about `ownShare` of the result is own. */
export function blendWave(own: string[], fresh: string[], ownShare: number): string[] {
  const out: string[] = []
  let a = 0
  let b = 0
  let debt = 0
  while (a < own.length || b < fresh.length) {
    debt += ownShare
    if ((debt >= 1 || b >= fresh.length) && a < own.length) {
      out.push(own[a++])
      debt -= 1
    } else if (b < fresh.length) {
      out.push(fresh[b++])
    } else {
      out.push(own[a++])
    }
  }
  return out
}

/** How many of `n` songs should be the user's own in this mode. */
export function ownCount(n: number, mode: WaveMode): number {
  return Math.round(n * WAVE_MODES[mode].own)
}

/** The artists to ask the catalogue about: the user's strongest ones in the allowed genres. */
export function artistsForMode(profile: TasteProfile, mode: WaveMode, families?: Map<GenreFamily, number>): { name: string; weight: number }[] {
  const fams = families ?? profile.families
  const minFit = WAVE_MODES[mode].minFit
  const fits = profile.artists.filter((a) => {
    const f = profile.artistFamily.get(a.name.toLowerCase())
    const fit = !fams.size ? 1 : f ? tasteFit(f, fams) : UNKNOWN_FIT
    return fit >= minFit
  })
  return fits.length ? fits : profile.artists
}
