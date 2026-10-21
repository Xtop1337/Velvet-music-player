import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DiscordStatus, ExportOptions, ExportProgress, ImportOptions, ImportProgress, LyricsQuery, LyricsResult, NowPlayingPayload, PlayerCommand, RemoteState, AppPrefs, SearchResult, UpdateStatus, SearchSource, Track, YtDlpStatus } from '../shared/types'

type Unsubscribe = () => void

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): Unsubscribe {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  app: {
    info: (): Promise<{ platform: string; version: string; defaultDownloads: string }> => ipcRenderer.invoke('app:info'),
    setWindowTheme: (colors: { bg: string; fg: string }): Promise<void> => ipcRenderer.invoke('window:theme', colors),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url)
  },
  store: {
    load: <T>(name: string): Promise<T | null> => ipcRenderer.invoke('store:load', name),
    save: (name: string, data: unknown): Promise<void> => ipcRenderer.invoke('store:save', name, data),
    saveSync: (name: string, data: unknown): void => void ipcRenderer.sendSync('store:save-sync', name, data)
  },
  library: {
    pick: (kind: 'files' | 'folder'): Promise<Track[]> => ipcRenderer.invoke('library:pick', kind),
    scan: (paths: string[]): Promise<Track[]> => ipcRenderer.invoke('library:scan', paths),
    exists: (paths: string[]): Promise<boolean[]> => ipcRenderer.invoke('library:exists', paths),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('library:reveal', path),
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    onScanProgress: (cb: (done: number, total: number) => void): Unsubscribe => on('library:scan-progress', cb)
  },
  tags: {
    write: (t: { path: string; title: string; artist: string; album: string; coverPath?: string; clearCover?: boolean; lyrics?: string }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('tags:write', t)
  },
  covers: {
    pick: (): Promise<string | null> => ipcRenderer.invoke('cover:pick'),
    fromUrl: (url: string): Promise<string> => ipcRenderer.invoke('cover:url', url),
    fromClipboard: (): Promise<string | null> => ipcRenderer.invoke('cover:clipboard')
  },
  dialog: {
    pickDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir'),
    pickVideo: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickVideo')
  },
  discord: {
    configure: (opts: { enabled: boolean; clientId: string; showSpeed: boolean; showButtons: boolean; lookupCovers: boolean }): Promise<void> =>
      ipcRenderer.invoke('discord:configure', opts),
    update: (p: NowPlayingPayload | null): Promise<void> => ipcRenderer.invoke('discord:update', p),
    status: (): Promise<DiscordStatus> => ipcRenderer.invoke('discord:status'),
    onStatus: (cb: (status: DiscordStatus, user?: string) => void): Unsubscribe => on('discord:status', cb),
    onCover: (cb: (trackId: string, url: string) => void): Unsubscribe => on('discord:cover', cb)
  },
  exporter: {
    start: (o: ExportOptions): Promise<ExportProgress> => ipcRenderer.invoke('export:start', o),
    onProgress: (cb: (p: ExportProgress) => void): Unsubscribe => on('export:progress', cb)
  },
  search: {
    query: (q: string, source: SearchSource): Promise<{ results: SearchResult[]; error?: string }> => ipcRenderer.invoke('search:query', q, source),
    preview: (url: string): Promise<string> => ipcRenderer.invoke('search:preview', url)
  },
  remote: {
    pushState: (s: RemoteState): void => ipcRenderer.send('player:state', s),
    command: (c: PlayerCommand): void => ipcRenderer.send('player:command', c),
    onCommand: (cb: (c: PlayerCommand) => void): Unsubscribe => on('player:command', cb),
    onState: (cb: (s: RemoteState) => void): Unsubscribe => on('player:state', cb),
    setPrefs: (p: AppPrefs): Promise<void> => ipcRenderer.invoke('app:prefs', p),
    toggleMini: (): Promise<void> => ipcRenderer.invoke('mini:toggle'),
    closeSelf: (): Promise<void> => ipcRenderer.invoke('mini:close'),
    onMiniClosed: (cb: () => void): Unsubscribe => on('mini:closed', cb)
  },
  updates: {
    configure: (auto: boolean): Promise<void> => ipcRenderer.invoke('update:configure', auto),
    check: (): Promise<void> => ipcRenderer.invoke('update:check'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
    onStatus: (cb: (s: UpdateStatus) => void): Unsubscribe => on('update:status', cb)
  },
  lyrics: {
    get: (q: LyricsQuery): Promise<LyricsResult> => ipcRenderer.invoke('lyrics:get', q)
  },
  importer: {
    start: (opts: ImportOptions): Promise<string> => ipcRenderer.invoke('import:start', opts),
    cancel: (jobId: string): Promise<void> => ipcRenderer.invoke('import:cancel', jobId),
    ytdlpStatus: (): Promise<YtDlpStatus> => ipcRenderer.invoke('ytdlp:status'),
    installYtdlp: (): Promise<YtDlpStatus> => ipcRenderer.invoke('ytdlp:install'),
    onProgress: (cb: (p: ImportProgress) => void): Unsubscribe => on('import:progress', cb),
    onTrack: (cb: (jobId: string, track: Track) => void): Unsubscribe => on('import:track', cb)
  }
}

export type VelvetApi = typeof api

contextBridge.exposeInMainWorld('velvet', api)
