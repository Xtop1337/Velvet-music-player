import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateStatus } from '@shared/types'

const EVERY_MS = 6 * 3600_000

/** GitHub Releases auto-update. Only active in packaged builds with a configured repository. */
export class Updater {
  private status: UpdateStatus = { state: 'idle' }
  private timer: NodeJS.Timeout | null = null
  private wired = false

  constructor(private onStatus: (s: UpdateStatus) => void) {}

  getStatus(): UpdateStatus {
    return this.status
  }

  private set(s: UpdateStatus): void {
    this.status = s
    this.onStatus(s)
  }

  /** True when electron-builder wrote a real publish config into the app. */
  private configured(): boolean {
    const file = join(process.resourcesPath, 'app-update.yml')
    if (!existsSync(file)) return false
    return !/YOUR_GITHUB_USERNAME/.test(readFileSync(file, 'utf8'))
  }

  private wire(): void {
    if (this.wired) return
    this.wired = true
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-available', (i) => this.set({ state: 'downloading', version: i.version, percent: 0 }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none', checkedAt: Date.now() }))
    autoUpdater.on('download-progress', (p) => this.set({ ...this.status, state: 'downloading', percent: p.percent / 100 }))
    autoUpdater.on('update-downloaded', (i) => this.set({ state: 'ready', version: i.version }))
    autoUpdater.on('error', (e) => this.set({ state: 'error', error: e?.message?.split('\n')[0] }))
  }

  configure(auto: boolean): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!app.isPackaged) return this.set({ state: 'dev' })
    if (!this.configured()) return this.set({ state: 'unconfigured' })
    this.wire()
    if (!auto) return this.set({ ...this.status, state: this.status.state === 'ready' ? 'ready' : 'idle' })
    void this.check()
    this.timer = setInterval(() => void this.check(), EVERY_MS)
  }

  async check(): Promise<void> {
    if (!app.isPackaged || !this.configured()) return
    this.wire()
    if (this.status.state === 'downloading' || this.status.state === 'ready') return
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      this.set({ state: 'error', error: e instanceof Error ? e.message.split('\n')[0] : String(e) })
    }
  }

  install(): void {
    if (this.status.state === 'ready') autoUpdater.quitAndInstall()
  }
}
