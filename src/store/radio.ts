import i18n from 'i18next'
import { create } from 'zustand'
import type { SearchResult, Track } from '@shared/types'
import { logUi } from '@renderer/lib/diag'
import { trackFamily, type GenreFamily } from '@renderer/lib/genres'
import { localRadio } from '@renderer/lib/radio'
import { trackKey } from '@renderer/lib/recommend'
import { buildProfile, trackWeights, type TasteProfile } from '@renderer/lib/taste'
import { artistsForMode, blendWave, ownCount, ownPicks, pickWaveSeeds, rankCandidates, seedLabel, WAVE_MODES, type WaveMode, type WaveSeed } from '@renderer/lib/wave'
import { useLibrary } from './library'
import { usePlayer } from './player'
import { useStats } from './stats'
import { useTaste } from './taste'
import { useUi } from './ui'

export type Service = 'soundcloud' | 'youtube'
/** Where the wave finds new songs: one service, or whichever most of the library came from. */
export type WaveSource = 'auto' | Service

const SOURCE_KEY = 'velvet.waveSource'
const MODE_KEY = 'velvet.waveMode'

function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null
    return v && allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}

function remember(key: string, v: string): void {
  try {
    localStorage.setItem(key, v)
  } catch {
    // a convenience only
  }
}

/** "Auto": the service most of the user's downloads came from (YouTube when there are none). */
export function resolveService(pref: WaveSource, tracks: Record<string, Track>): Service {
  if (pref !== 'auto') return pref
  let sc = 0
  let yt = 0
  for (const t of Object.values(tracks)) {
    if (t.stream) continue
    if (t.source === 'soundcloud') sc++
    else if (t.source === 'youtube' || t.source === 'spotify') yt++
  }
  return sc > yt ? 'soundcloud' : 'youtube'
}

function isPage(url: string | undefined): boolean {
  return !!url && /youtube\.com|youtu\.be|soundcloud\.com/.test(url)
}

/** A song suggested online as a playable track (not saved unless downloaded). */
export function streamTrack(r: SearchResult, prefer: Service = 'youtube', family?: GenreFamily | null): Track {
  const page = isPage(r.url) ? r.url : undefined
  return {
    id: `stream:${r.id}`,
    path: '',
    title: r.title,
    artist: r.artist,
    album: r.album ?? '',
    duration: r.duration,
    coverUrl: r.coverBig ?? r.thumbnail,
    source: page && /soundcloud\.com/.test(page) ? 'soundcloud' : 'youtube',
    addedAt: Date.now(),
    // the family id reads as a genre ("phonk", "funk"…), so the track keeps its genre while it plays
    genre: r.genre ?? family ?? undefined,
    stream: { link: r.url, preview: r.preview, prefer, page }
  }
}

/** Library tracks for suggested songs the user already has; new ones become stream tracks. */
export function toQueueIds(results: SearchResult[], prefer: Service = 'youtube', families?: Map<string, GenreFamily | null>): string[] {
  const lib = useLibrary.getState()
  const byKey = new Map<string, string>()
  for (const id of lib.order) {
    const t = lib.tracks[id]
    if (t) byKey.set(trackKey(t.artist, t.title), id)
  }
  const fresh: Track[] = []
  const ids = results.map((r) => {
    const local = byKey.get(trackKey(r.artist, r.title))
    if (local) return local
    const t = streamTrack(r, prefer, families?.get(r.id))
    fresh.push(t)
    return t.id
  })
  lib.addStreamTracks(fresh)
  return ids
}

interface RadioState {
  /** what the radio plays like: one song, or the whole taste ("My wave") */
  active: { kind: 'track' | 'wave'; label: string; seedId?: string } | null
  loading: boolean
  /** the radio could only use the library (no internet) */
  offline: boolean
  /** the wave's settings (remembered) */
  source: WaveSource
  mode: WaveMode
  setSource: (s: WaveSource) => void
  setMode: (m: WaveMode) => void
  start: (seed: Track | 'wave') => Promise<void>
  stop: () => void
  /** 👎 for the playing song: remembered, and the next one starts */
  dislikeCurrent: () => void
  /** 👍 for the playing song (pressing again takes it back) */
  likeCurrent: () => void
}

let own = false
let fetchingMore = false
/** seeds used lately (so each batch starts from other songs) */
const usedSeeds = new Set<string>()
/** every start gets a number: answers of an older start are dropped */
let session = 0

function ratings(): { likes: ReturnType<typeof useTaste.getState>['likes']; dislikes: ReturnType<typeof useTaste.getState>['dislikes'] } {
  const t = useTaste.getState()
  return { likes: t.likes, dislikes: t.dislikes }
}

function profileNow(): { profile: TasteProfile; weights: Map<string, number> } {
  const tracks = useLibrary.getState().tracks
  const history = useStats.getState().history
  return { profile: buildProfile(tracks, history, ratings()), weights: trackWeights(tracks, history) }
}

/** `trackKey`s of everything in the queue. */
function queuedKeys(): Set<string> {
  const tracks = useLibrary.getState().tracks
  const out = new Set<string>()
  for (const id of usePlayer.getState().queue) {
    const t = tracks[id]
    if (t) out.add(trackKey(t.artist, t.title))
  }
  return out
}

function setQueue(queue: string[], index: number): void {
  own = true
  usePlayer.setState({ queue, original: queue, index })
  own = false
}

interface Found {
  ids: string[]
  offline: boolean
}

/**
 * New songs for a set of seeds: the service's own "related" songs for each seed, plus songs of
 * artists similar to the user's (catalogue), ranked and filtered by genre for the mode.
 */
async function findNew(
  seeds: WaveSeed[],
  n: number,
  o: {
    service: Service
    fallback: boolean
    mode: WaveMode
    profile: TasteProfile
    families?: Map<GenreFamily, number>
    minFit?: number
    artists: { name: string; weight: number }[]
    /** the genre of songs found through an artist (radio by track: the seed's own) */
    artistFamily?: GenreFamily | null
  }
): Promise<Found> {
  const skip = queuedKeys()
  const excludeKeys = [...o.profile.excludeKeys, ...skip]
  const t0 = performance.now()
  const [native, catalogue] = await Promise.all([
    seeds.length
      ? window.velvet.search
          .waveCandidates({
            source: o.service,
            seeds: seeds.map((s) => ({ artist: s.artist, title: s.title, url: s.url })),
            excludeKeys,
            excludeArtists: o.profile.excludeArtists,
            fallback: o.fallback,
            limit: 60
          })
          .catch((e: unknown) => ({ results: [] as SearchResult[], error: String(e) }))
      : Promise.resolve({ results: [] as SearchResult[], error: undefined as string | undefined }),
    o.artists.length
      ? window.velvet.search
          .recommendFast({ source: o.service, artists: o.artists, excludeArtists: o.profile.excludeArtists, excludeKeys, familiar: WAVE_MODES[o.mode].familiar, limit: 30 })
          .catch((e: unknown) => ({ results: [] as SearchResult[], error: String(e) }))
      : Promise.resolve({ results: [] as SearchResult[], error: undefined as string | undefined })
  ])
  // the service's own related songs keep the genre best: two of them, then one from the catalogue
  const merged: SearchResult[] = []
  let a = 0
  let b = 0
  while (a < native.results.length || b < catalogue.results.length) {
    if (a < native.results.length) merged.push(native.results[a++])
    if (a < native.results.length) merged.push(native.results[a++])
    if (b < catalogue.results.length) merged.push(catalogue.results[b++])
  }
  const ranked = rankCandidates(merged, {
    profile: o.profile,
    mode: o.mode,
    seedFamilies: new Map<string, GenreFamily | null>([
      ...seeds.map((s): [string, GenreFamily | null] => [seedLabel(s), s.family]),
      ...(o.artistFamily ? o.artists.map((a): [string, GenreFamily | null] => [a.name, o.artistFamily!]) : [])
    ]),
    skip,
    families: o.families,
    minFit: o.minFit
  }).slice(0, n)
  logUi(
    'info',
    `wave: ${ranked.length} of ${merged.length} new songs in ${Math.round(performance.now() - t0)} ms (${o.service}, ${o.mode}; related ${native.results.length}${native.error ? ` [${native.error.slice(0, 80)}]` : ''}, catalogue ${catalogue.results.length}${catalogue.error ? ` [${catalogue.error}]` : ''})`
  )
  const families = new Map(ranked.map((r) => [r.result.id, r.family]))
  return { ids: toQueueIds(ranked.map((r) => r.result), o.service, families), offline: !native.results.length && !catalogue.results.length }
}

/** A batch of the wave: new songs for fresh seeds, blended with the user's own. */
async function waveBatch(n: number): Promise<Found> {
  const { source, mode } = useRadio.getState()
  const tracks = useLibrary.getState().tracks
  const { profile, weights } = profileNow()
  const service = resolveService(source, tracks)
  const seeds = pickWaveSeeds(tracks, weights, profile, mode, { service, avoid: usedSeeds, liked: useTaste.getState().likes })
  seeds.forEach((s) => usedSeeds.add(trackKey(s.artist, s.title)))
  const mine = ownCount(n, mode)
  const found = await findNew(seeds, n - mine, { service, fallback: source === 'auto', mode, profile, artists: artistsForMode(profile, mode).slice(0, 12) })
  const skip = new Set([...usePlayer.getState().queue, ...found.ids])
  // without new songs the wave goes on with the user's own
  const ownIds = ownPicks(tracks, weights, profile, mode, found.ids.length ? mine : n, { skip })
  return { ids: blendWave(ownIds, found.ids, found.ids.length ? WAVE_MODES[mode].own : 1), offline: found.offline }
}

/** Songs like one song (radio by track): strictly its genre when that is known. */
async function similarTo(seed: Track, n: number): Promise<Found> {
  const { source } = useRadio.getState()
  const tracks = useLibrary.getState().tracks
  const { profile } = profileNow()
  const family = trackFamily(seed)
  const service: Service = seed.stream?.page ? (/soundcloud\.com/.test(seed.stream.page) ? 'soundcloud' : 'youtube') : resolveService(source, tracks)
  const s: WaveSeed = { artist: seed.artist, title: seed.title, url: seed.stream?.page ?? seed.sourceUrl, family, id: seed.id }
  const artist = seed.artist.split(/,|&/)[0]?.trim()
  return findNew([s], n, {
    service,
    fallback: true,
    mode: 'favorite',
    profile,
    families: family ? new Map([[family, 1]]) : new Map(),
    minFit: family ? 0.8 : 0,
    artists: artist ? [{ name: artist, weight: 1 }] : [],
    artistFamily: family
  })
}

/** `trackKey`s the user turned down. */
function disliked(): Set<string> {
  return new Set(useTaste.getState().dislikes.filter((d) => d.weight >= 1).map((d) => d.key))
}

function rated(t: Track): { artist: string; title: string; genre?: string; url?: string } {
  return { artist: t.artist, title: t.title, genre: t.genre, url: t.stream?.page ?? t.sourceUrl }
}

export const useRadio = create<RadioState>((set, get) => ({
  active: null,
  loading: false,
  offline: false,
  source: remembered<WaveSource>(SOURCE_KEY, ['auto', 'soundcloud', 'youtube'], 'auto'),
  mode: remembered<WaveMode>(MODE_KEY, ['favorite', 'balance', 'discover'], 'favorite'),
  setSource: (source) => {
    remember(SOURCE_KEY, source)
    set({ source })
    if (get().active?.kind === 'wave') void get().start('wave')
  },
  setMode: (mode) => {
    remember(MODE_KEY, mode)
    set({ mode })
    if (get().active?.kind === 'wave') void get().start('wave')
  },
  start: async (seed) => {
    const restart = seed === 'wave' && get().active?.kind === 'wave'
    const mine = ++session
    usedSeeds.clear()
    if (seed === 'wave') {
      set({ active: { kind: 'wave', label: i18n.t('radio.wave') }, loading: true, offline: false })
      const tracks = useLibrary.getState().tracks
      const { profile, weights } = profileNow()
      const before = usePlayer.getState()
      let first: string[]
      if (restart && before.currentId) {
        // the mode or the source changed during the wave: the current song stays (playing or paused),
        // what follows is rebuilt
        first = [before.currentId]
        setQueue(first, 0)
      } else {
        // the user's own songs start at once; the new ones join as soon as they are found
        first = ownPicks(tracks, weights, profile, get().mode, 3)
        if (first.length) {
          setQueue(first, -1)
          void usePlayer.getState().jumpTo(0)
        }
      }
      const batch = await waveBatch(16)
      if (mine !== session) return
      if (!batch.ids.length && !first.length) {
        set({ active: null, loading: false })
        useUi.getState().toast(i18n.t('radio.empty'), 'info')
        return
      }
      const p = usePlayer.getState()
      // still the wave's opening songs: put the batch right after the one that plays
      if (first.length && p.queue.slice(0, first.length).join() === first.join()) {
        const head = p.queue.slice(0, Math.max(1, p.index + 1))
        setQueue([...head, ...batch.ids.filter((id) => !head.includes(id))], p.index)
      } else if (!first.length) {
        setQueue(batch.ids, -1)
        await usePlayer.getState().jumpTo(0)
      }
      set({ loading: false, offline: batch.offline })
      return
    }
    set({ active: { kind: 'track', label: `${seed.artist ? `${seed.artist} — ` : ''}${seed.title}`, seedId: seed.id }, loading: true, offline: false })
    if (!useLibrary.getState().tracks[seed.id]) useLibrary.getState().addStreamTracks([seed])
    const found = await similarTo(seed, 15)
    if (mine !== session) return
    let ids = found.ids
    let offline = false
    if (!ids.length) {
      offline = true
      ids = localRadio(seed, useLibrary.getState().tracks, { n: 25, banned: disliked() })
      if (!ids.length) {
        set({ active: null, loading: false })
        useUi.getState().toast(i18n.t('radio.empty'), 'info')
        return
      }
    }
    set({ loading: false, offline })
    if (offline) useUi.getState().toast(i18n.t('radio.offline'), 'info')
    // the seed may still be playing (started from "Now playing"): keep it going
    if (usePlayer.getState().currentId === seed.id) setQueue([seed.id, ...ids], 0)
    else {
      setQueue([seed.id, ...ids], -1)
      await usePlayer.getState().jumpTo(0)
    }
  },
  stop: () => {
    session++
    set({ active: null, loading: false })
  },
  dislikeCurrent: () => {
    const p = usePlayer.getState()
    const t = p.currentId ? useLibrary.getState().tracks[p.currentId] : undefined
    if (!t) return
    useTaste.getState().dislike(rated(t), 1)
    useUi.getState().toast(i18n.t('taste.noted'), 'info')
    void p.next()
  },
  likeCurrent: () => {
    const p = usePlayer.getState()
    const t = p.currentId ? useLibrary.getState().tracks[p.currentId] : undefined
    if (!t) return
    toggleLike(t)
  }
}))

/** 👍 on / off for a song (suggested or playing). Returns the new state. */
export function toggleLike(t: Pick<Track, 'artist' | 'title' | 'genre' | 'sourceUrl' | 'stream'>): boolean {
  const taste = useTaste.getState()
  if (taste.rating(t.artist, t.title) === 1) {
    taste.undo(trackKey(t.artist, t.title))
    return false
  }
  taste.like({ artist: t.artist, title: t.title, genre: t.genre, url: t.stream?.page ?? t.sourceUrl }, 1)
  useUi.getState().toast(i18n.t('taste.liked'), 'success')
  return true
}

/** Endless: when a few songs are left, more are added (like the last one, or from the taste). */
async function more(): Promise<void> {
  const r = useRadio.getState()
  if (!r.active || fetchingMore) return
  fetchingMore = true
  const mine = session
  try {
    const p = usePlayer.getState()
    const tracks = useLibrary.getState().tracks
    let ids: string[] = []
    if (r.active.kind === 'wave') ids = (await waveBatch(14)).ids
    else {
      const cur = p.currentId ? tracks[p.currentId] : undefined
      if (cur) ids = (await similarTo(cur, 12)).ids
      if (!ids.length && cur) ids = localRadio(cur, tracks, { n: 15, skip: new Set(p.queue), banned: disliked() })
    }
    const now = usePlayer.getState()
    if (mine === session && ids.length && useRadio.getState().active) setQueue([...now.queue, ...ids.filter((id) => !now.queue.includes(id))], now.index)
  } finally {
    fetchingMore = false
  }
}

usePlayer.subscribe((s, prev) => {
  const r = useRadio.getState()
  if (!r.active) return
  // another album / playlist started: the radio is over
  if (!own && s.queue !== prev.queue && s.queue[0] !== prev.queue[0]) {
    useRadio.getState().stop()
    return
  }
  if (s.index !== prev.index && s.queue.length - s.index - 1 <= 3) void more()
  // a suggested song skipped within 30 s counts as a small "not interested"
  // (the user's own library songs aren't held against their artists)
  if (s.lastSkip && s.lastSkip !== prev.lastSkip && s.lastSkip.position < 30) {
    const t = useLibrary.getState().tracks[s.lastSkip.id]
    if (t?.stream) useTaste.getState().dislike(rated(t), 0.3)
  }
  // …and one played (almost) to its end as a small "like"
  if (s.currentId !== prev.currentId && prev.currentId && prev.duration > 0 && prev.position / prev.duration > 0.85) {
    const t = useLibrary.getState().tracks[prev.currentId]
    if (t?.stream) useTaste.getState().like(rated(t), 0.3)
  }
})
