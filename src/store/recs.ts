import { create } from 'zustand'
import type { MatchMeta, SearchResult, SearchSource, SpotifyKeys } from '@shared/types'
import { logUi } from '@renderer/lib/diag'
import { trackKey } from '@renderer/lib/recommend'
import { buildProfile, trackWeights } from '@renderer/lib/taste'
import { artistsForMode, pickWaveSeeds, rankCandidates, seedLabel, type WaveSeed } from '@renderer/lib/wave'
import { useImports } from './imports'
import { useLibrary } from './library'
import { useSettings } from './settings'
import { useStats } from './stats'
import { useTaste } from './taste'

const FRESH_MS = 6 * 3600_000
const KEY = (s: SearchSource): string => `velvet.recs2.${s}`

export interface RecBatch {
  at: number
  results: SearchResult[]
  error: string
  /** the user's artists and songs the list was built from */
  basedOn: string[]
  /** ids of the songs in the user's own main genres (the rest are neighbouring genres) */
  close: string[]
}

interface RecsState {
  batches: Partial<Record<SearchSource, RecBatch>>
  loading: Partial<Record<SearchSource, boolean>>
  /** loads (or refreshes) the list for a service; quick when cached */
  load: (source: SearchSource, fresh?: boolean) => Promise<void>
}

function spotifyKeys(): SpotifyKeys | null {
  const s = useSettings.getState().settings.importer
  return s.spotifyClientId.trim() && s.spotifyClientSecret.trim() ? { clientId: s.spotifyClientId.trim(), clientSecret: s.spotifyClientSecret.trim() } : null
}

function cachedBatch(source: SearchSource): RecBatch | undefined {
  try {
    const b = JSON.parse(localStorage.getItem(KEY(source)) ?? 'null') as RecBatch | null
    return b && Array.isArray(b.results) && Array.isArray(b.close) ? b : undefined
  } catch {
    return undefined
  }
}

function keep(source: SearchSource, b: RecBatch): void {
  try {
    localStorage.setItem(KEY(source), JSON.stringify({ ...b, results: b.results.slice(0, 80) }))
  } catch {
    // a convenience only
  }
}

/** Two songs the service itself relates to the user's songs, then one from the catalogue. */
export function blend(native: SearchResult[], catalogue: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  const push = (r: SearchResult | undefined): void => {
    if (!r) return
    const k = trackKey(r.artist, r.title)
    if (seen.has(k)) return
    seen.add(k)
    out.push(r)
  }
  let a = 0
  let b = 0
  while (a < native.length || b < catalogue.length) {
    push(native[a++])
    push(native[a++])
    push(catalogue[b++])
  }
  return out
}

/** Download info for a suggestion found through Deezer (its audio is looked up on the chosen service). */
export function matchFor(r: SearchResult, source: SearchSource): MatchMeta | undefined {
  if (!/deezer\.com\//.test(r.url)) return undefined
  return {
    title: r.title,
    artist: r.artist,
    album: r.album ?? '',
    duration: r.duration,
    coverUrl: r.coverBig ?? r.thumbnail,
    prefer: source === 'soundcloud' ? 'soundcloud' : 'youtube'
  }
}

/** Downloads a suggestion into the library. */
export function downloadSuggestion(r: SearchResult, source: SearchSource): Promise<string> {
  return useImports.getState().start(r.url, matchFor(r, source))
}

/** the latest request per service: older answers are dropped */
const seqs: Partial<Record<SearchSource, number>> = {}
/** seeds used by earlier refreshes, per service */
const used: Partial<Record<SearchSource, Set<string>>> = {}

export const useRecs = create<RecsState>((set, get) => ({
  batches: {},
  loading: {},
  load: async (source, fresh = false) => {
    const have = get().batches[source] ?? cachedBatch(source)
    if (have && !fresh) {
      set({ batches: { ...get().batches, [source]: have } })
      if (Date.now() - have.at < FRESH_MS) return
    }
    const id = (seqs[source] = (seqs[source] ?? 0) + 1)
    set({ loading: { ...get().loading, [source]: true } })
    const { tracks } = useLibrary.getState()
    const history = useStats.getState().history
    const taste = useTaste.getState()
    const profile = buildProfile(tracks, history, { likes: taste.likes, dislikes: taste.dislikes })
    const weights = trackWeights(tracks, history)
    const spotify = source === 'spotify' ? spotifyKeys() : null
    const finish = (b: RecBatch, done: boolean): void => {
      // a newer request for this service is running: it will set the list and the spinner
      if (id !== seqs[source]) return
      if (!b.error && done) keep(source, b)
      set({ batches: { ...get().batches, [source]: b }, ...(done ? { loading: { ...get().loading, [source]: false } } : {}) })
    }
    if (source === 'spotify' && !spotify) {
      finish({ at: Date.now(), results: [], error: 'spotify-keys', basedOn: [], close: [] }, true)
      return
    }
    // "New for you" looks a little wider than the user's main genre, but not anywhere
    const mode = 'balance' as const
    const service = source === 'soundcloud' ? 'soundcloud' : 'youtube'
    const avoid = (used[source] ??= new Set<string>())
    if (!fresh) avoid.clear()
    const seeds: WaveSeed[] = source === 'spotify' ? [] : pickWaveSeeds(tracks, weights, profile, mode, { service, avoid, liked: taste.likes })
    seeds.forEach((s) => avoid.add(trackKey(s.artist, s.title)))
    const seedFamilies = new Map(seeds.map((s) => [seedLabel(s), s.family]))
    let artists = artistsForMode(profile, mode)
    // each refresh starts from a slightly different mix of the user's artists
    if (fresh) artists = artists.map((a) => ({ ...a, weight: a.weight * (0.6 + Math.random() * 0.8) })).sort((a, b) => b.weight - a.weight)
    const basedOn = [...new Set([...seeds.map((s) => s.artist || s.title), ...artists.map((a) => a.name)])].filter(Boolean).slice(0, 5)
    const rank = (list: SearchResult[]): Pick<RecBatch, 'results' | 'close'> => {
      const ranked = rankCandidates(list, { profile, mode, seedFamilies })
      return { results: ranked.map((r) => r.result), close: ranked.filter((r) => r.fit >= 0.8).map((r) => r.result.id) }
    }
    const t0 = performance.now()
    const catalogueP = window.velvet.search
      .recommendFast({ source, artists: artists.slice(0, 12), excludeArtists: profile.excludeArtists, excludeKeys: profile.excludeKeys, familiar: 0.2, limit: 40, spotify })
      .catch((e: unknown) => ({ results: [] as SearchResult[], error: String(e) }))
    const nativeP: Promise<{ results: SearchResult[]; error?: string }> =
      source === 'spotify' || !seeds.length
        ? Promise.resolve({ results: [] })
        : window.velvet.search
            .waveCandidates({
              source: service,
              seeds: seeds.map((s) => ({ artist: s.artist, title: s.title, url: s.url })),
              excludeKeys: profile.excludeKeys,
              excludeArtists: profile.excludeArtists,
              fallback: false,
              limit: 60
            })
            .catch((e: unknown) => ({ results: [] as SearchResult[], error: String(e) }))
    // the catalogue answers in a second or two: show it, then add the service's own related songs
    const catalogue = await catalogueP
    logUi('info', `recommendations (${source}): catalogue ${catalogue.results.length} in ${Math.round(performance.now() - t0)} ms${catalogue.error ? `, ${catalogue.error}` : ''}`)
    if (source === 'spotify') {
      finish({ at: Date.now(), ...rank(catalogue.results), error: catalogue.error ?? '', basedOn }, true)
      return
    }
    if (catalogue.results.length) finish({ at: Date.now(), ...rank(catalogue.results), error: '', basedOn }, false)
    const native = await nativeP
    logUi('info', `recommendations (${source}): related ${native.results.length} in ${Math.round(performance.now() - t0)} ms${native.error ? `, ${native.error.slice(0, 120)}` : ''}`)
    const all = rank(blend(native.results, catalogue.results))
    finish({ at: Date.now(), ...all, error: all.results.length ? '' : (native.error ?? catalogue.error ?? ''), basedOn }, true)
  }
}))

/** Prepares the list in the background shortly after launch, so the page opens instantly. */
export function prefetchRecs(source: SearchSource): void {
  window.setTimeout(() => {
    const b = cachedBatch(source)
    if (useLibrary.getState().order.length && (!b || Date.now() - b.at > FRESH_MS)) void useRecs.getState().load(source)
  }, 12_000)
}
