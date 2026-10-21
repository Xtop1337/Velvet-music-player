import { Client, type SetActivity } from '@xhayper/discord-rpc'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DiscordStatus, NowPlayingPayload } from '@shared/types'
import { paths } from './paths'

export interface DiscordOptions {
  enabled: boolean
  clientId: string
  showSpeed: boolean
  showButtons: boolean
  lookupCovers: boolean
}

const LISTENING = 2
const STATUS_DISPLAY_STATE = 1
const MIN_INTERVAL_MS = 2500
const RETRY_MS = 15000

function clip(text: string, max = 128): string {
  const t = text.trim()
  if (t.length < 2) return t.padEnd(2, ' ')
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function serviceName(url: string): string {
  if (/soundcloud\.com/.test(url)) return 'SoundCloud'
  if (/spotify\.com/.test(url)) return 'Spotify'
  if (/youtu/.test(url)) return 'YouTube'
  return 'Web'
}

/** Pure builder for the Rich Presence payload (exported for tests). */
export function buildActivity(p: NowPlayingPayload, opts: Pick<DiscordOptions, 'showSpeed' | 'showButtons'>, now = Date.now()): SetActivity {
  const en = p.language === 'en'
  const rate = p.rate > 0 ? p.rate : 1
  const speed = opts.showSpeed && Math.abs(rate - 1) > 0.001 ? ` · ${rate.toFixed(2).replace(/\.?0+$/, '')}x` : ''
  const artist = p.artist || (en ? 'Unknown artist' : 'Неизвестный исполнитель')
  const activity: SetActivity = {
    type: LISTENING,
    statusDisplayType: STATUS_DISPLAY_STATE,
    details: clip(p.title || (en ? 'Unknown track' : 'Без названия')),
    state: clip(p.playing ? artist : `${en ? 'Paused' : 'Пауза'} · ${artist}`),
    largeImageKey: p.coverUrl && /^https:\/\//.test(p.coverUrl) ? p.coverUrl : 'logo',
    largeImageText: clip(`${p.album || p.title || 'Velvet'}${speed}`),
    instance: false
  }
  if (p.playing && p.duration > 0) {
    // Timestamps are in wall-clock time, so they are scaled by the playback rate.
    const start = now - (p.position / rate) * 1000
    activity.startTimestamp = Math.round(start)
    activity.endTimestamp = Math.round(start + (p.duration / rate) * 1000)
  }
  if (opts.showButtons && p.sourceUrl && /^https:\/\//.test(p.sourceUrl)) {
    activity.buttons = [{ label: `${en ? 'Open on' : 'Открыть в'} ${serviceName(p.sourceUrl)}`, url: p.sourceUrl }]
  }
  return activity
}

type CoverCache = Record<string, string | null>

let coverCache: CoverCache | null = null
const coverCacheFile = (): string => join(paths.cache, 'cover-lookup.json')

function loadCoverCache(): CoverCache {
  if (coverCache) return coverCache
  try {
    coverCache = existsSync(coverCacheFile()) ? JSON.parse(readFileSync(coverCacheFile(), 'utf8')) : {}
  } catch {
    coverCache = {}
  }
  return coverCache!
}

/** Finds a public artwork URL for a local track via the iTunes Search API. */
export async function lookupCoverUrl(artist: string, title: string): Promise<string | null> {
  const key = `${artist}|${title}`.toLowerCase()
  const cache = loadCoverCache()
  if (key in cache) return cache[key]
  let url: string | null = null
  try {
    const term = encodeURIComponent(`${artist} ${title}`.trim())
    const res = await fetch(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`)
    if (res.ok) {
      const json = (await res.json()) as { results?: { artworkUrl100?: string; trackName?: string }[] }
      const want = title.toLowerCase()
      const hit = json.results?.find((r) => r.trackName?.toLowerCase().includes(want)) ?? json.results?.[0]
      url = hit?.artworkUrl100?.replace(/\/\d+x\d+bb\./, '/600x600bb.') ?? null
    }
  } catch {
    return null // network problem: don't cache, try again next time
  }
  cache[key] = url
  try {
    writeFileSync(coverCacheFile(), JSON.stringify(cache))
  } catch {
    // cache is best-effort
  }
  return url
}

export class DiscordPresence {
  private client: Client | null = null
  private opts: DiscordOptions = { enabled: false, clientId: '', showSpeed: true, showButtons: true, lookupCovers: true }
  private status: DiscordStatus = 'disabled'
  private pending: NowPlayingPayload | null | undefined = undefined
  private lastSent = 0
  private flushTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private current: NowPlayingPayload | null = null

  constructor(
    private onStatus: (status: DiscordStatus, user?: string) => void,
    private onCoverResolved: (trackId: string, url: string) => void
  ) {}

  getStatus(): DiscordStatus {
    return this.status
  }

  configure(opts: DiscordOptions): void {
    const reconnect = opts.clientId !== this.opts.clientId || opts.enabled !== this.opts.enabled
    this.opts = opts
    if (!reconnect) {
      if (this.current) this.update(this.current)
      return
    }
    void this.disconnect()
    if (!opts.enabled) return this.setStatus('disabled')
    if (!/^\d{15,22}$/.test(opts.clientId.trim())) return this.setStatus('no-client-id')
    void this.connect()
  }

  update(p: NowPlayingPayload | null): void {
    this.current = p
    if (p && !p.coverUrl && this.opts.lookupCovers && (p.title || p.artist)) {
      const trackId = p.trackId
      void lookupCoverUrl(p.artist, p.title).then((url) => {
        if (!url) return
        this.onCoverResolved(trackId, url)
        if (this.current?.trackId === trackId) this.update({ ...this.current, coverUrl: url })
      })
    }
    this.pending = p
    this.scheduleFlush()
  }

  private setStatus(status: DiscordStatus, user?: string): void {
    this.status = status
    this.onStatus(status, user)
  }

  private async connect(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.setStatus('connecting')
    const client = new Client({ clientId: this.opts.clientId.trim(), transport: { type: 'ipc' } })
    this.client = client
    client.on('ready', () => {
      if (this.client !== client) return
      this.setStatus('connected', client.user?.username)
      this.pending = this.current
      this.lastSent = 0
      this.scheduleFlush()
    })
    client.on('disconnected', () => {
      if (this.client !== client) return
      this.setStatus('connecting')
      this.scheduleRetry()
    })
    try {
      await client.login()
    } catch {
      if (this.client !== client) return
      this.setStatus('error')
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      if (this.opts.enabled && this.status !== 'connected') {
        void this.disconnect().then(() => this.connect())
      }
    }, RETRY_MS)
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    const wait = Math.max(0, this.lastSent + MIN_INTERVAL_MS - Date.now())
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, wait)
  }

  private async flush(): Promise<void> {
    if (this.pending === undefined || this.status !== 'connected' || !this.client?.user) return
    const p = this.pending
    this.pending = undefined
    this.lastSent = Date.now()
    try {
      if (p) await this.client.user.setActivity(buildActivity(p, this.opts))
      else await this.client.user.clearActivity()
    } catch {
      // transient RPC failure; the next update will try again
    }
  }

  async disconnect(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const client = this.client
    this.client = null
    if (!client) return
    try {
      await client.user?.clearActivity()
    } catch {
      // ignore
    }
    try {
      await client.destroy()
    } catch {
      // ignore
    }
  }
}
