import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { assetPath, Remote } from './services/remote'
import { Updater } from './services/updater'
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '@shared/defaults'
import type { AppPrefs, ExportOptions, ImportOptions, PlayerCommand, RemoteState, LyricsQuery, NowPlayingPayload, SearchSource } from '@shared/types'
import { coverFromClipboard, coverFromFile, coverFromUrl } from './services/covers'
import { DiscordPresence, type DiscordOptions } from './services/discord'
import { Importer } from './services/importer'
import { scanPaths } from './services/library'
import { paths } from './services/paths'
import { loadStore, saveStore } from './services/store'
import { writeTags, type TagWrite } from './services/tags'
import { exportTrack } from './services/exporter'
import { getLyrics } from './services/lyrics'
import { previewUrl, search } from './services/search'
import { installYtDlp, ytdlpStatus } from './services/ytdlp'

// Keeps the data folder name stable in dev and packaged builds.
app.setName('Velvet')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'velvet',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true }
  }
])

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  alac: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime'
}

let win: BrowserWindow | null = null

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

/** Serves local audio and images to the renderer, with HTTP Range support so seeking works. */
function registerMediaProtocol(): void {
  protocol.handle('velvet', async (req) => {
    const url = new URL(req.url)
    const file = decodeURIComponent(url.pathname.slice(1))
    const ext = extname(file).slice(1).toLowerCase()
    if (!AUDIO_EXTENSIONS.includes(ext) && !IMAGE_EXTENSIONS.includes(ext) && !VIDEO_EXTENSIONS.includes(ext)) {
      return new Response('Forbidden', { status: 403 })
    }
    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    }
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '')
    let start = 0
    let end = size - 1
    let status = 200
    if (range && size > 0) {
      if (range[1]) {
        start = Number(range[1])
        if (range[2]) end = Math.min(Number(range[2]), size - 1)
      } else if (range[2]) {
        start = Math.max(0, size - Number(range[2]))
      }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
      }
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    }
    headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1)
    if (req.method === 'HEAD' || size === 0) return new Response(null, { status, headers })
    const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream
    return new Response(body, { status, headers })
  })
}

function loadRenderer(w: BrowserWindow, hash = ''): void {
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${hash ? `#${hash}` : ''}`)
  } else {
    void w.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}

const updater = new Updater((s) => send('update:status', s))
const remote = new Remote(() => win, loadRenderer, join(__dirname, '../preload/index.js'))

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const icon = assetPath('icon.png')
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#f5f7fb',
    title: 'Velvet',
    icon: existsSync(icon) ? icon : undefined,
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarOverlay: { color: '#00000000', symbolColor: '#1b2333', height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) e.preventDefault()
  })
  loadRenderer(win)
  win.on('close', (e) => {
    if (remote.closeToTray && !remote.quitting) {
      e.preventDefault()
      remote.ensureTray()
      win?.hide()
    }
  })
  win.on('closed', () => (win = null))
}

const discord = new DiscordPresence(
  (status, user) => send('discord:status', status, user),
  (trackId, url) => send('discord:cover', trackId, url)
)

const importer = new Importer({
  progress: (p) => send('import:progress', p),
  track: (jobId, track) => send('import:track', jobId, track)
})

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    defaultDownloads: paths.defaultDownloads
  }))

  ipcMain.handle('store:load', (_e, name: string) => loadStore(name))
  ipcMain.handle('store:save', (_e, name: string, data: unknown) => saveStore(name, data))
  ipcMain.on('store:save-sync', (e, name: string, data: unknown) => {
    try {
      saveStore(name, data)
    } finally {
      e.returnValue = true
    }
  })

  ipcMain.handle('library:pick', async (_e, kind: 'files' | 'folder') => {
    if (!win) return []
    const res = await dialog.showOpenDialog(win, {
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters: kind === 'files' ? [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }] : undefined
    })
    if (res.canceled) return []
    return scanPaths(res.filePaths, (done, total) => send('library:scan-progress', done, total))
  })
  ipcMain.handle('library:scan', (_e, list: string[]) =>
    scanPaths(list, (done, total) => send('library:scan-progress', done, total))
  )
  ipcMain.handle('library:exists', (_e, list: string[]) => list.map((p) => existsSync(p)))
  ipcMain.handle('library:reveal', (_e, file: string) => shell.showItemInFolder(file))

  ipcMain.handle('tags:write', (_e, t: TagWrite) => {
    try {
      writeTags(t)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('cover:pick', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
    })
    return res.canceled ? null : coverFromFile(res.filePaths[0])
  })
  ipcMain.handle('cover:url', (_e, url: string) => coverFromUrl(url))
  ipcMain.handle('cover:clipboard', () => coverFromClipboard())

  ipcMain.handle('dialog:pickVideo', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('dialog:pickDir', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('discord:configure', (_e, opts: DiscordOptions) => discord.configure(opts))
  ipcMain.handle('discord:update', (_e, p: NowPlayingPayload | null) => discord.update(p))
  ipcMain.handle('discord:status', () => discord.getStatus())

  ipcMain.handle('export:start', async (_e, o: ExportOptions) => {
    try {
      return await exportTrack(o, (p) => send('export:progress', p))
    } catch (e) {
      const p = { id: o.id, state: 'error' as const, percent: 0, error: e instanceof Error ? e.message : String(e) }
      send('export:progress', p)
      return p
    }
  })
  ipcMain.handle('search:query', async (_e, q: string, source: SearchSource) => {
    try {
      return { results: await search(q, source) }
    } catch (e) {
      return { results: [], error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('search:preview', (_e, url: string) => previewUrl(url))
  ipcMain.on('player:state', (_e, s: RemoteState) => remote.setState(s))
  ipcMain.on('player:command', (_e, c: PlayerCommand) => remote.command(c))
  ipcMain.handle('app:prefs', (_e, p: AppPrefs) => remote.setPrefs(p))
  ipcMain.handle('mini:toggle', () => remote.toggleMini())
  ipcMain.handle('mini:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle('update:configure', (_e, auto: boolean) => updater.configure(auto))
  ipcMain.handle('update:check', () => updater.check())
  ipcMain.handle('update:install', () => {
    remote.quitting = true
    updater.install()
  })
  ipcMain.handle('update:status', () => updater.getStatus())
  ipcMain.handle('lyrics:get', (_e, q: LyricsQuery) => getLyrics(q))
  ipcMain.handle('import:start', (_e, opts: ImportOptions) => importer.start(opts))
  ipcMain.handle('import:cancel', (_e, jobId: string) => importer.cancel(jobId))
  ipcMain.handle('ytdlp:status', () => ytdlpStatus(true))
  ipcMain.handle('ytdlp:install', () => installYtDlp())

  ipcMain.handle('window:theme', (_e, colors: { bg: string; fg: string }) => {
    if (!win) return
    win.setBackgroundColor(colors.bg)
    if (process.platform !== 'darwin') {
      try {
        win.setTitleBarOverlay({ color: '#00000000', symbolColor: colors.fg, height: 40 })
      } catch {
        // not supported on this platform
      }
    }
  })
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => remote.showMain())
  app.whenReady().then(() => {
    app.setAppUserModelId('app.velvet.player')
    registerMediaProtocol()
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (!win) createWindow()
      else remote.showMain()
    })
  })
  app.on('before-quit', () => {
    remote.quitting = true
    void discord.disconnect()
  })
  app.on('will-quit', () => remote.dispose())
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
