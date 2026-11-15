import { useEffect } from 'react'
import { create } from 'zustand'
import type { AnalysisResult, Track } from '@shared/types'
import { trackFamily } from '@renderer/lib/genres'
import { useLibrary } from '@renderer/store/library'
import { useSettings } from '@renderer/store/settings'

/** Progress of the background analysis (Settings shows it). */
export const useAnalysisProgress = create<{ done: number; total: number }>(() => ({ done: 0, total: 0 }))

/** Tracks the analysis hasn't seen yet (files only, not tracks from the internet). */
export function needsAnalysis(t: Track, missing: Set<string>): boolean {
  return !t.analyzedAt && !t.stream && !!t.path && !missing.has(t.id)
}

/** What a result changes on the track: tag / user values win over detected ones. */
export function analysisPatch(t: Track, r: AnalysisResult, now = Date.now()): Partial<Track> {
  const patch: Partial<Track> = { analyzedAt: now }
  if (r.bpm && !t.bpm) patch.bpm = Math.round(r.bpm * 10) / 10
  if (r.key && !t.key) {
    patch.key = r.key
    patch.camelot = r.camelot
  }
  if (r.energy !== undefined) patch.energy = r.energy
  if (r.genre && !t.genre) patch.genre = r.genre
  if (r.year && !t.year) patch.year = r.year
  return patch
}

/**
 * Works through the library in the background: BPM, key and energy for every track (new ones
 * as they arrive), starting a little after launch so it never competes with the first screen.
 */
/** Tracks to look up online for genre / year (once each). */
export function needsLookup(t: Track): boolean {
  return !t.stream && !t.lookedUpAt && !needsPageGenre(t) && (!t.genre || !t.year) && !!(t.artist && t.title)
}

/** Songs downloaded from SoundCloud whose page hasn't been asked for its genre yet. */
export function needsPageGenre(t: Track): boolean {
  return !t.stream && !t.pageGenreAt && !!t.sourceUrl && /^https:\/\/soundcloud\.com\//.test(t.sourceUrl) && !trackFamilyKnown(t)
}

/** The genre is already precise (a tag or the title names phonk / funk…). */
function trackFamilyKnown(t: Track): boolean {
  const f = trackFamily(t)
  return f === 'phonk' || f === 'funk'
}

export function useAnalysis(): void {
  const enabled = useSettings((s) => s.settings.analysis.enabled)
  const lookup = useSettings((s) => s.settings.analysis.lookupOnline)
  const settingsLoaded = useSettings((s) => s.loaded)
  const libLoaded = useLibrary((s) => s.loaded)

  useEffect(() => {
    const offResult = window.velvet.analysis.onResult((r) => {
      const t = useLibrary.getState().tracks[r.id]
      if (t) useLibrary.getState().updateTrack(r.id, analysisPatch(t, r))
    })
    const offProgress = window.velvet.analysis.onProgress((p) => useAnalysisProgress.setState(p))
    const offMeta = window.velvet.meta.onResult((r) => {
      const t = useLibrary.getState().tracks[r.id]
      if (!t) return
      const patch: Partial<Track> = r.fromPage ? { pageGenreAt: Date.now() } : { lookedUpAt: Date.now() }
      // the genre from the song's own page is the precise one: it replaces a catalogue's guess
      if (r.genre && (r.fromPage || !t.genre)) patch.genre = r.genre
      if (r.year && !t.year) patch.year = r.year
      useLibrary.getState().updateTrack(r.id, patch)
    })
    return () => {
      offResult()
      offProgress()
      offMeta()
    }
  }, [])

  // genre / year from the internet for tracks whose tags lack them
  useEffect(() => {
    if (!lookup || !settingsLoaded || !libLoaded) return
    const asked = new Set<string>()
    const queue = (): void => {
      const { tracks, order } = useLibrary.getState()
      const items = order
        .map((id) => tracks[id])
        // after the tags were read by the analysis (they may have the genre)
        .filter((t) => t && !asked.has(t.id) && (t.analyzedAt || !enabled) && needsLookup(t))
        .slice(0, 400)
        .map((t): { id: string; artist?: string; title?: string; page?: string } => ({ id: t.id, artist: t.artist, title: t.title }))
      // SoundCloud downloads: the page knows the genre better than the catalogue (a few per minute)
      const pages = order
        .map((id) => tracks[id])
        .filter((t) => t && !asked.has(t.id) && needsPageGenre(t))
        .slice(0, 8)
        .map((t) => ({ id: t.id, page: t.sourceUrl }))
      items.push(...pages)
      items.forEach((i) => asked.add(i.id))
      if (items.length) void window.velvet.meta.lookup(items)
    }
    const first = window.setTimeout(queue, 20_000)
    const every = window.setInterval(queue, 60_000)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [lookup, enabled, settingsLoaded, libLoaded])

  useEffect(() => {
    if (!enabled || !settingsLoaded || !libLoaded) {
      if (settingsLoaded && !enabled) void window.velvet.analysis.cancel()
      return
    }
    const queued = new Set<string>()
    const queue = (): void => {
      const { tracks, order, missing } = useLibrary.getState()
      const items = order
        .map((id) => tracks[id])
        .filter((t) => t && !queued.has(t.id) && needsAnalysis(t, missing))
        .map((t) => ({ id: t.id, path: t.path }))
      items.forEach((i) => queued.add(i.id))
      if (items.length) void window.velvet.analysis.start(items)
    }
    const first = window.setTimeout(queue, 6000)
    // new tracks (imports, added folders)
    const off = useLibrary.subscribe((s, prev) => {
      if (s.order !== prev.order) window.setTimeout(queue, 1500)
    })
    return () => {
      clearTimeout(first)
      off()
    }
  }, [enabled, settingsLoaded, libLoaded])
}
