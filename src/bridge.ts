/**
 * `window.velvet`: the UI's only door to the Rust backend (Tauri commands and events).
 * It keeps the shape the UI was written against, so components and stores don't know
 * which shell they run in.
 */
import { invoke } from '@tauri-apps/api/core'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { mainStrings } from '@shared/mainStrings'
import type {
  AppPrefs,
  DiscordStatus,
  ExportOptions,
  ExportProgress,
  ImportOptions,
  ImportProgress,
  LyricsQuery,
  LyricsResult,
  NowPlayingPayload,
  PlayerCommand,
  RemoteState,
  SearchResult,
  SearchSource,
  Track,
  UpdateStatus,
  YtDlpStatus
} from '@shared/types'

type Unsubscribe = () => void

export interface FileDropEvent {
  type: 'enter' | 'over' | 'drop' | 'leave'
  paths: string[]
}

const win = getCurrentWebviewWindow()
const isMini = location.hash === '#mini'

/** Events whose payload is an argument list. */
const SPREAD = new Set(['library:scan-progress', 'discord:status', 'discord:cover', 'import:track'])

/** Subscribes to a backend event; the returned function also cancels a subscription still being set up. */
function on<A extends unknown[]>(event: string, cb: (...args: A) => void): Unsubscribe {
  let off: UnlistenFn | null = null
  let cancelled = false
  void win
    .listen<unknown>(event, (e) => {
      const args = SPREAD.has(event) && Array.isArray(e.payload) ? e.payload : [e.payload]
      cb(...(args as A))
    })
    .then((u) => {
      if (cancelled) u()
      else off = u
    })
  return () => {
    cancelled = true
    off?.()
  }
}

// ── saving before quit ─────────────────────────────────────────────────────────
// There is no synchronous IPC: saves are tracked, and when the app is about to quit the
// backend asks the main window to flush them first (see `app:flush` below).
const pending = new Set<Promise<unknown>>()
function tracked<T>(p: Promise<T>): Promise<T> {
  pending.add(p)
  void p.finally(() => pending.delete(p)).catch(() => {})
  return p
}

const api = {
  app: {
    info: (): Promise<{ platform: string; version: string; defaultDownloads: string }> => invoke('app_info'),
    setWindowTheme: (colors: { bg: string; fg: string }): Promise<void> => invoke('window_theme', { bg: colors.bg }),
    openExternal: (url: string): Promise<void> => invoke('open_external', { url })
  },
  store: {
    load: <T>(name: string): Promise<T | null> => invoke<T | null>('store_load', { name }),
    save: (name: string, data: unknown): Promise<void> => tracked(invoke<void>('store_save', { name, data })),
    /** Fire-and-forget save used while the page is going away; the quit flow waits for it. */
    saveSync: (name: string, data: unknown): void => void tracked(invoke<void>('store_save', { name, data })).catch(() => {})
  },
  library: {
    pick: (kind: 'files' | 'folder'): Promise<Track[]> => invoke('library_pick', { kind }),
    scan: (paths: string[]): Promise<Track[]> => invoke('library_scan', { paths }),
    exists: (paths: string[]): Promise<boolean[]> => invoke('library_exists', { paths }),
    reveal: (path: string): Promise<void> => invoke('library_reveal', { path }),
    onScanProgress: (cb: (done: number, total: number) => void): Unsubscribe => on('library:scan-progress', cb),
    /** Files dragged in from the system (with their paths). */
    onFileDrop: (cb: (e: FileDropEvent) => void): Unsubscribe => {
      let off: UnlistenFn | null = null
      let cancelled = false
      void getCurrentWebview()
        .onDragDropEvent((e) => {
          const p = e.payload
          cb({ type: p.type, paths: 'paths' in p ? p.paths : [] })
        })
        .then((u) => (cancelled ? u() : (off = u)))
      return () => {
        cancelled = true
        off?.()
      }
    }
  },
  tags: {
    write: (t: { path: string; title: string; artist: string; album: string; coverPath?: string; clearCover?: boolean; lyrics?: string }): Promise<{ ok: boolean; error?: string }> =>
      invoke('tags_write', { t })
  },
  covers: {
    pick: (): Promise<string | null> => invoke('cover_pick'),
    fromUrl: (url: string): Promise<string> => invoke('cover_url', { url }),
    fromClipboard: (): Promise<string | null> => invoke('cover_clipboard')
  },
  dialog: {
    pickDir: (): Promise<string | null> => invoke('dialog_pick_dir'),
    pickVideo: (): Promise<string | null> => invoke('dialog_pick_video')
  },
  discord: {
    configure: (opts: { enabled: boolean; clientId: string; showSpeed: boolean; showButtons: boolean; lookupCovers: boolean; hideWhenPaused?: boolean }): Promise<void> =>
      invoke('discord_configure', { opts: { hideWhenPaused: false, ...opts } }),
    update: (p: NowPlayingPayload | null): Promise<void> => invoke('discord_update', { p: p && { ...p, strings: mainStrings(p.language) } }),
    status: (): Promise<DiscordStatus> => invoke('discord_status'),
    onStatus: (cb: (status: DiscordStatus, user?: string) => void): Unsubscribe => on('discord:status', cb),
    onCover: (cb: (trackId: string, url: string) => void): Unsubscribe => on('discord:cover', cb)
  },
  exporter: {
    start: (o: ExportOptions): Promise<ExportProgress> => invoke('export_start', { o }),
    onProgress: (cb: (p: ExportProgress) => void): Unsubscribe => on('export:progress', cb)
  },
  search: {
    query: (q: string, source: SearchSource): Promise<{ results: SearchResult[]; error?: string }> => invoke('search_query', { q, source }),
    preview: (url: string): Promise<string> => invoke('search_preview', { url })
  },
  remote: {
    pushState: (s: RemoteState): void => void invoke('player_state', { s }).catch(() => {}),
    command: (c: PlayerCommand): void => void invoke('player_command', { c }).catch(() => {}),
    onCommand: (cb: (c: PlayerCommand) => void): Unsubscribe => on('player:command', cb),
    onState: (cb: (s: RemoteState) => void): Unsubscribe => {
      // the mini player asks for the last state once, then follows the pushes
      void invoke<RemoteState | null>('remote_last_state').then((s) => s && cb(s))
      return on('player:state', cb)
    },
    setPrefs: (p: AppPrefs): Promise<string[]> => invoke('app_prefs', { p, strings: mainStrings(p.language) }),
    toggleMini: (): Promise<void> => invoke('mini_toggle'),
    closeSelf: (): Promise<void> => invoke('mini_close'),
    onMiniClosed: (cb: () => void): Unsubscribe => on('mini:closed', cb)
  },
  updates: {
    configure: (auto: boolean): Promise<void> => invoke('update_configure', { auto }),
    check: (): Promise<void> => invoke('update_check'),
    /** Opens the new release on GitHub. */
    open: (): Promise<void> => invoke('update_open'),
    status: (): Promise<UpdateStatus> => invoke('update_status'),
    onStatus: (cb: (s: UpdateStatus) => void): Unsubscribe => on('update:status', cb)
  },
  lyrics: {
    get: (q: LyricsQuery): Promise<LyricsResult> => invoke('lyrics_get', { q })
  },
  importer: {
    start: (opts: ImportOptions): Promise<string> => invoke('import_start', { opts }),
    cancel: (jobId: string): Promise<void> => invoke('import_cancel', { jobId }),
    ytdlpStatus: (): Promise<YtDlpStatus> => invoke('ytdlp_status'),
    installYtdlp: (): Promise<YtDlpStatus> => invoke('ytdlp_install'),
    onProgress: (cb: (p: ImportProgress) => void): Unsubscribe => on('import:progress', cb),
    onTrack: (cb: (jobId: string, track: Track) => void): Unsubscribe => on('import:track', cb)
  },
  window: {
    minimize: (): Promise<void> => win.minimize(),
    toggleMaximize: (): Promise<void> => win.toggleMaximize(),
    close: (): Promise<void> => win.close(),
    isMaximized: (): Promise<boolean> => win.isMaximized(),
    onResized: (cb: () => void): Unsubscribe => {
      let off: UnlistenFn | null = null
      let cancelled = false
      void win.onResized(() => cb()).then((u) => (cancelled ? u() : (off = u)))
      return () => {
        cancelled = true
        off?.()
      }
    }
  }
}

export type VelvetApi = typeof api

window.velvet = api

// ── window behaviour that Electron provided natively ───────────────────────────

/** Elements marked `.drag` move the window (like `-webkit-app-region: drag` did); a double click maximizes. */
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  const target = e.target as HTMLElement | null
  if (!target?.closest('.drag, .mini__drag')) return
  if (target.closest('.no-drag, button, input, label, select, textarea, a, [contenteditable="true"], .window-controls')) return
  e.preventDefault()
  if (e.detail === 2 && !isMini) void win.toggleMaximize()
  else void win.startDragging()
})

/** The visualizer's fullscreen stage also makes the window itself fullscreen. */
document.addEventListener('fullscreenchange', () => {
  void win.setFullscreen(!!document.fullscreenElement).catch(() => {})
})

// pages being reloaded (development) flush like a quit does
window.addEventListener('beforeunload', () => window.dispatchEvent(new Event('velvet:flush')))

if (!isMini) {
  // Quit / close requested: the stores write what they still hold, then the backend may exit.
  void win.listen('app:flush', async () => {
    window.dispatchEvent(new Event('velvet:flush'))
    await Promise.allSettled([...pending])
    await invoke('app_flushed').catch(() => {})
  })
}
