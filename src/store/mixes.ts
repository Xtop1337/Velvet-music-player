import { create } from 'zustand'
import type { SearchResult, Track } from '@shared/types'
import { logUi } from '@renderer/lib/diag'
import { trackFamily, type GenreFamily } from '@renderer/lib/genres'
import { buildDailyMixes, seeded, today, type DailyMix } from '@renderer/lib/mixes'
import { rankCandidates, seedLabel, type WaveSeed } from '@renderer/lib/wave'
import { buildProfile } from '@renderer/lib/taste'
import { useLibrary } from './library'
import { resolveService, toQueueIds, useRadio } from './radio'
import { blend } from './recs'
import { useStats } from './stats'
import { useTaste } from './taste'

/** Bumped when the way mixes are built changes, so saved ones are rebuilt after an update. */
const VERSION = 2

interface Saved {
  v?: number
  date: string
  mixes: DailyMix[]
  /** the day's new songs, so they survive a restart */
  streams: Track[]
}

interface MixesState {
  date: string
  mixes: DailyMix[]
  loaded: boolean
  filling: Record<string, boolean>
  /** builds today's mixes (keeps them if already built today) */
  ensure: () => Promise<void>
  /** adds the day's new songs to a mix (once a day) */
  fillNew: (id: string) => Promise<void>
}

let saveTimer: number | null = null

function onService(url: string | undefined, service: 'soundcloud' | 'youtube'): boolean {
  if (!url) return false
  return service === 'soundcloud' ? /soundcloud\.com/.test(url) : /youtube\.com|youtu\.be/.test(url)
}

function save(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    const { date, mixes } = useMixes.getState()
    const tracks = useLibrary.getState().tracks
    const streams = mixes.flatMap((m) => m.newIds).map((id) => tracks[id]).filter((t): t is Track => !!t && !!t.stream)
    void window.velvet.store.save('mixes', { v: VERSION, date, mixes, streams } satisfies Saved)
  }, 600)
}

export const useMixes = create<MixesState>((set, get) => ({
  date: '',
  mixes: [],
  loaded: false,
  filling: {},
  ensure: async () => {
    const date = today()
    if (get().loaded && get().date === date) return
    const saved = await window.velvet.store.load<Saved>('mixes').catch(() => null)
    const lib = useLibrary.getState()
    if (saved && saved.v === VERSION && saved.date === date && Array.isArray(saved.mixes)) {
      lib.addStreamTracks(saved.streams ?? [])
      set({ date, mixes: saved.mixes, loaded: true })
      return
    }
    const mixes = buildDailyMixes(lib.tracks, useStats.getState().history, { date })
    set({ date, mixes, loaded: true })
    save()
  },
  fillNew: async (id) => {
    const mix = get().mixes.find((m) => m.id === id)
    if (!mix || mix.newIds.length || get().filling[id] || !mix.artists.length) return
    set({ filling: { ...get().filling, [id]: true } })
    try {
      const lib = useLibrary.getState()
      const taste = useTaste.getState()
      const profile = buildProfile(lib.tracks, useStats.getState().history, { likes: taste.likes, dislikes: taste.dislikes })
      const want = Math.max(4, Math.round(mix.trackIds.length * 0.3))
      const service = resolveService(useRadio.getState().source, lib.tracks)
      // new songs come from the songs of this very mix, and must be of the mix's own genre
      const mixTracks = mix.trackIds.map((x) => lib.tracks[x]).filter(Boolean)
      const day = seeded(`${get().date}:${id}`)
      const seeds: WaveSeed[] = [...mixTracks]
        .map((t) => ({ t, r: day() * (onService(t.sourceUrl, service) ? 1.5 : 1) }))
        .sort((a, b) => b.r - a.r)
        .slice(0, 3)
        .map(({ t }) => ({ artist: t.artist, title: t.title, url: t.sourceUrl, family: mix.family ?? trackFamily(t), id: t.id }))
      const families = new Map<GenreFamily, number>()
      for (const t of mixTracks) {
        const f = mix.family ?? trackFamily(t)
        if (f) families.set(f, (families.get(f) ?? 0) + 1)
      }
      const excludeKeys = profile.excludeKeys
      const [native, catalogue] = await Promise.all([
        window.velvet.search
          .waveCandidates({ source: service, seeds: seeds.map((s) => ({ artist: s.artist, title: s.title, url: s.url })), excludeKeys, excludeArtists: profile.excludeArtists, fallback: true, limit: 40 })
          .catch((e: unknown) => ({ results: [] as SearchResult[], error: String(e) })),
        window.velvet.search
          .recommendFast({ source: service, artists: mix.artists, excludeArtists: profile.excludeArtists, excludeKeys, familiar: 0.25, limit: want * 2 })
          .catch((e: unknown) => ({ results: [] as SearchResult[], error: String(e) }))
      ])
      if (native.error || catalogue.error) logUi('warn', `daily mix ${id}: ${native.error ?? ''} ${catalogue.error ?? ''}`.trim())
      const ranked = rankCandidates(blend(native.results, catalogue.results), {
        profile,
        mode: 'favorite',
        seedFamilies: new Map(seeds.map((s) => [seedLabel(s), s.family])),
        families,
        minFit: families.size ? 0.8 : 0
      }).slice(0, want)
      const fams = new Map(ranked.map((r) => [r.result.id, r.family]))
      const newIds = toQueueIds(ranked.map((r) => r.result), service, fams).filter((x) => !mix.trackIds.includes(x))
      set({ mixes: get().mixes.map((m) => (m.id === id ? { ...m, newIds } : m)) })
      save()
    } finally {
      set({ filling: { ...get().filling, [id]: false } })
    }
  }
}))
