import { convertFileSrc, invoke } from '@tauri-apps/api/core'

/**
 * URL for a local image served by the backend's `velvet` protocol.
 * It is `http://velvet.localhost/<path>` on Windows and `velvet://localhost/<path>` elsewhere.
 */
export function mediaUrl(path: string | undefined): string {
  return path ? convertFileSrc(path, 'velvet') : ''
}

let streamBase: string | null = null

/** Asks the backend where audio/video are streamed from (call once before playing). */
export async function initMedia(): Promise<void> {
  streamBase = await invoke<string | null>('media_base').catch(() => null)
}

/**
 * URL for local audio and video (seekable). The `velvet` protocol on Windows; on Linux,
 * whose WebKit can't play media from custom schemes, the backend's loopback stream server.
 */
export function streamUrl(path: string | undefined): string {
  if (!path) return ''
  return streamBase ? `${streamBase}${encodeURIComponent(path)}` : mediaUrl(path)
}
