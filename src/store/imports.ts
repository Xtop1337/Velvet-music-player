import { create } from 'zustand'
import type { ImportProgress, MatchMeta, Track, YtDlpStatus } from '@shared/types'
import { trackKey } from '@renderer/lib/recommend'
import { useLibrary } from './library'
import { useSettings } from './settings'

interface ImportState {
  jobs: ImportProgress[]
  ytdlp: YtDlpStatus | null
  installing: boolean
  /** `matched`: a song known by its metadata (its audio is looked up) */
  start: (url: string, matched?: MatchMeta) => Promise<string>
  cancel: (jobId: string) => void
  clearFinished: () => void
  refreshYtdlp: () => Promise<void>
  installYtdlp: () => Promise<void>
}

/** Songs (by `trackKey`) to like as soon as their download arrives. */
const likeOnArrival = new Set<string>()

/** Downloads a song from the internet (radio, mixes) into the library; `like` likes the copy. */
export function downloadStreamTrack(t: Track, like = false): Promise<string> | null {
  if (!t.stream) return null
  if (like) likeOnArrival.add(trackKey(t.artist, t.title))
  const url = t.stream.link ?? t.stream.page ?? ''
  if (!url) return null
  return useImports.getState().start(url, {
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    coverUrl: t.coverUrl,
    page: t.stream.page,
    prefer: t.stream.prefer
  })
}

/** Jobs whose finished tracks have already been turned into a playlist. */
const playlistMade = new Set<string>()

export const useImports = create<ImportState>((set, get) => ({
  jobs: [],
  ytdlp: null,
  installing: false,
  start: async (url, matched) => {
    const s = useSettings.getState().settings.importer
    const jobId = await window.velvet.importer.start({
      url,
      downloadDir: s.downloadDir,
      format: s.format,
      spotifyClientId: s.spotifyClientId,
      spotifyClientSecret: s.spotifyClientSecret,
      matched
    })
    return jobId
  },
  cancel: (jobId) => void window.velvet.importer.cancel(jobId),
  clearFinished: () => set({ jobs: get().jobs.filter((j) => j.state === 'resolving' || j.state === 'downloading') }),
  refreshYtdlp: async () => set({ ytdlp: await window.velvet.importer.ytdlpStatus() }),
  installYtdlp: async () => {
    set({ installing: true })
    try {
      set({ ytdlp: await window.velvet.importer.installYtdlp() })
    } finally {
      set({ installing: false })
    }
  }
}))

/** Wires main-process import events into the stores. Call once at startup. */
export function bindImportEvents(onFinished: (job: ImportProgress) => void): () => void {
  const offProgress = window.velvet.importer.onProgress((p) => {
    const jobs = useImports.getState().jobs
    const i = jobs.findIndex((j) => j.jobId === p.jobId)
    useImports.setState({ jobs: i < 0 ? [p, ...jobs] : jobs.map((j, k) => (k === i ? p : j)) })
    if ((p.state === 'done' || p.state === 'error') && !playlistMade.has(p.jobId)) {
      playlistMade.add(p.jobId)
      const create = useSettings.getState().settings.importer.createPlaylist
      if (create && p.kind && p.kind !== 'track' && p.trackIds.length) {
        useLibrary.getState().createPlaylist(p.title || 'Imported', p.trackIds)
      }
      onFinished(p)
    }
  })
  const offTrack = window.velvet.importer.onTrack((_jobId: string, track: Track) => {
    useLibrary.getState().addTracks([track])
    // a song from the internet liked while playing: the downloaded copy is liked too
    const key = trackKey(track.artist, track.title)
    if (likeOnArrival.delete(key)) useLibrary.getState().updateTrack(track.id, { liked: true, likedAt: Date.now() })
  })
  return () => {
    offProgress()
    offTrack()
  }
}

