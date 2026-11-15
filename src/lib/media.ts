import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { logUi } from './diag'

/**
 * URL for a local image served by the backend's `velvet` protocol.
 * It is `http://velvet.localhost/<path>` on Windows and `velvet://localhost/<path>` elsewhere.
 */
export function mediaUrl(path: string | undefined): string {
  return path ? convertFileSrc(path, 'velvet') : ''
}

/** A cover to show: the cached file, else a public link (tracks from the internet). */
export function coverSrc(t: { coverPath?: string; coverUrl?: string } | undefined): string | undefined {
  if (!t) return undefined
  if (t.coverPath) return mediaUrl(t.coverPath)
  return t.coverUrl && /^https:\/\//.test(t.coverUrl) ? t.coverUrl : undefined
}

/**
 * How audio reaches the player:
 * - `loopback`: Velvet's own http server on 127.0.0.1 (real HTTP + CORS; Linux always, Windows when reachable)
 * - `protocol`: the `velvet` protocol inside WebView2 (Windows fallback; WebKitGTK can't play it)
 */
export type Transport = 'loopback' | 'protocol'

let base: string | null = null
let transport: Transport = 'protocol'
/** WebView2 (Windows) can play the `velvet` protocol too; WebKitGTK (Linux) only the loopback server. */
let isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

async function reachable(url: string): Promise<boolean> {
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), 2500)
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctl.signal })
    return r.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Asks the backend where audio can come from and picks the transport (call once before playing). */
export async function initMedia(): Promise<void> {
  const [b, info] = await Promise.all([
    invoke<string | null>('media_base').catch(() => null),
    invoke<{ platform: string }>('app_info').catch(() => null)
  ])
  base = b
  // the backend knows the platform for sure (a user agent can be changed)
  if (info?.platform) isWindows = info.platform === 'win32'
  if (!base) {
    transport = 'protocol'
  } else if (!isWindows) {
    transport = 'loopback'
  } else {
    transport = (await reachable(`${base}ping`)) ? 'loopback' : 'protocol'
  }
  logUi('info', `audio transport: ${transport}${base ? '' : ' (no loopback server)'}`)
}

export function currentTransport(): Transport {
  return transport
}

function urlFor(path: string, via: Transport): string {
  if (via === 'loopback' && base) return `${base}${encodeURIComponent(path)}`
  return mediaUrl(path)
}

/** URL for local audio and video (seekable), over the current transport. */
export function streamUrl(path: string | undefined): string {
  if (!path) return ''
  return urlFor(path, transport)
}

/** The same file over the other transport, when there is one that can work here. */
export function altStreamUrl(path: string): string | null {
  if (!isWindows || !base) return null
  return urlFor(path, transport === 'loopback' ? 'protocol' : 'loopback')
}

/** After the other transport worked, keep using it for the rest of the session. */
export function switchTransport(): void {
  if (!isWindows || !base) return
  transport = transport === 'loopback' ? 'protocol' : 'loopback'
  logUi('warn', `audio transport switched to ${transport}`)
}

/** URL of a track streamed from the internet (see stream.rs). */
export function remoteStreamUrl(id: string, via: Transport = transport): string {
  if (via === 'loopback' && base) return `${base}stream/${id}`
  return convertFileSrc(`__stream/${id}`, 'velvet')
}
