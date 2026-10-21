import { create } from 'zustand'
import type { ImportProgress, Track, YtDlpStatus } from '@shared/types'
import { useLibrary } from './library'
import { useSettings } from './settings'

interface ImportState {
  jobs: ImportProgress[]
  ytdlp: YtDlpStatus | null
  installing: boolean
  start: (url: string) => Promise<string>
  cancel: (jobId: string) => void
  clearFinished: () => void
  refreshYtdlp: () => Promise<void>
  installYtdlp: () => Promise<void>
}

/** Jobs whose finished tracks have already been turned into a playlist. */
const playlistMade = new Set<string>()

export const useImports = create<ImportState>((set, get) => ({
  jobs: [],
  ytdlp: null,
  installing: false,
  start: async (url) => {
    const s = useSettings.getState().settings.importer
    const jobId = await window.velvet.importer.start({
      url,
      downloadDir: s.downloadDir,
      format: s.format,
      spotifyClientId: s.spotifyClientId,
      spotifyClientSecret: s.spotifyClientSecret
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
  })
  return () => {
    offProgress()
    offTrack()
  }
}
