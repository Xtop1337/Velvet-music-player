import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Notification, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppPrefs, PlayerCommand, RemoteState } from '@shared/types'

export function assetPath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, 'resources', name) : join(app.getAppPath(), 'resources', name)
}

const SHORTCUTS: [string, PlayerCommand][] = [
  ['CommandOrControl+Alt+Space', { cmd: 'toggle' }],
  ['CommandOrControl+Alt+Right', { cmd: 'next' }],
  ['CommandOrControl+Alt+Left', { cmd: 'prev' }],
  ['CommandOrControl+Alt+Up', { cmd: 'volume', value: 0.05 }],
  ['CommandOrControl+Alt+Down', { cmd: 'volume', value: -0.05 }]
]

const STRINGS = {
  ru: { play: 'Играть', pause: 'Пауза', next: 'Следующий', prev: 'Предыдущий', show: 'Открыть Velvet', mini: 'Мини-плеер', quit: 'Выход', nothing: 'Ничего не играет' },
  en: { play: 'Play', pause: 'Pause', next: 'Next', prev: 'Previous', show: 'Open Velvet', mini: 'Mini player', quit: 'Quit', nothing: 'Nothing playing' }
}

/**
 * Everything that controls the player from outside the main window:
 * tray icon, mini player window, global shortcuts and track notifications.
 * Playback itself stays in the main window; commands are forwarded to it.
 */
export class Remote {
  private tray: Tray | null = null
  private mini: BrowserWindow | null = null
  private state: RemoteState | null = null
  private prefs: AppPrefs = { closeToTray: false, globalShortcuts: true, notifications: false, language: 'ru', miniOnTop: true }
  quitting = false

  constructor(
    private getMain: () => BrowserWindow | null,
    private loadRenderer: (w: BrowserWindow, hash: string) => void,
    private preload: string
  ) {}

  private send(cmd: PlayerCommand): void {
    const w = this.getMain()
    if (w && !w.isDestroyed()) w.webContents.send('player:command', cmd)
  }

  showMain(): void {
    const w = this.getMain()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }

  setPrefs(p: AppPrefs): void {
    const shortcutsChanged = p.globalShortcuts !== this.prefs.globalShortcuts
    this.prefs = p
    if (shortcutsChanged || !globalShortcut.isRegistered(SHORTCUTS[0][0])) this.applyShortcuts()
    if (this.mini && !this.mini.isDestroyed()) this.mini.setAlwaysOnTop(p.miniOnTop, 'floating')
    if (p.closeToTray) this.ensureTray()
    this.updateTray()
  }

  get closeToTray(): boolean {
    return this.prefs.closeToTray
  }

  private applyShortcuts(): void {
    for (const [acc] of SHORTCUTS) if (globalShortcut.isRegistered(acc)) globalShortcut.unregister(acc)
    if (!this.prefs.globalShortcuts) return
    for (const [acc, cmd] of SHORTCUTS) {
      try {
        globalShortcut.register(acc, () => this.send(cmd))
      } catch {
        // taken by another app
      }
    }
  }

  ensureTray(): void {
    if (this.tray) return
    const icon = assetPath('icon.png')
    const img = existsSync(icon) ? nativeImage.createFromPath(icon).resize({ width: process.platform === 'darwin' ? 18 : 22, quality: 'best' }) : nativeImage.createEmpty()
    this.tray = new Tray(img)
    this.tray.setToolTip('Velvet')
    this.tray.on('click', () => this.showMain())
    this.updateTray()
  }

  private updateTray(): void {
    if (!this.tray) return
    const s = STRINGS[this.prefs.language] ?? STRINGS.en
    const st = this.state
    const now = st?.title ? `${st.title}${st.artist ? ` — ${st.artist}` : ''}` : s.nothing
    this.tray.setToolTip(`Velvet · ${now}`.slice(0, 120))
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: now.slice(0, 60), enabled: false },
        { type: 'separator' },
        { label: st?.playing ? s.pause : s.play, click: () => this.send({ cmd: 'toggle' }) },
        { label: s.next, click: () => this.send({ cmd: 'next' }) },
        { label: s.prev, click: () => this.send({ cmd: 'prev' }) },
        { type: 'separator' },
        { label: s.show, click: () => this.showMain() },
        { label: s.mini, click: () => this.toggleMini() },
        { type: 'separator' },
        {
          label: s.quit,
          click: () => {
            this.quitting = true
            app.quit()
          }
        }
      ])
    )
  }

  /** State pushed by the main renderer; forwarded to the mini player, tray and notifications. */
  setState(next: RemoteState): void {
    const prev = this.state
    this.state = next
    if (this.mini && !this.mini.isDestroyed()) this.mini.webContents.send('player:state', next)
    if (!prev || prev.trackId !== next.trackId || prev.playing !== next.playing || prev.title !== next.title) this.updateTray()
    if (this.prefs.notifications && next.trackId && next.playing && prev?.trackId !== next.trackId) this.notify(next)
  }

  private notify(s: RemoteState): void {
    const main = this.getMain()
    if (main?.isFocused() || !Notification.isSupported()) return
    const icon = s.coverPath && existsSync(s.coverPath) ? nativeImage.createFromPath(s.coverPath).resize({ width: 256 }) : undefined
    const n = new Notification({ title: s.title || 'Velvet', body: [s.artist, s.album].filter(Boolean).join(' · '), icon, silent: true })
    n.on('click', () => this.showMain())
    n.show()
  }

  toggleMini(): void {
    if (this.mini && !this.mini.isDestroyed()) {
      this.mini.close()
      return
    }
    const w = new BrowserWindow({
      width: 400,
      height: 128,
      minWidth: 320,
      minHeight: 128,
      maxHeight: 128,
      frame: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: this.prefs.miniOnTop,
      skipTaskbar: false,
      show: false,
      title: 'Velvet Mini',
      backgroundColor: '#00000000',
      transparent: process.platform !== 'linux',
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true }
    })
    if (this.prefs.miniOnTop) w.setAlwaysOnTop(true, 'floating')
    w.once('ready-to-show', () => w.show())
    w.webContents.once('did-finish-load', () => this.state && w.webContents.send('player:state', this.state))
    w.on('closed', () => {
      this.mini = null
      this.getMain()?.webContents.send('mini:closed')
    })
    this.mini = w
    this.loadRenderer(w, 'mini')
  }

  command(cmd: PlayerCommand): void {
    if (cmd.cmd === 'show') return this.showMain()
    if (cmd.cmd === 'mini') return this.toggleMini()
    this.send(cmd)
  }

  dispose(): void {
    globalShortcut.unregisterAll()
    this.tray?.destroy()
    this.tray = null
  }
}
