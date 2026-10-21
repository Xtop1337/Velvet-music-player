import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import type { YtDlpStatus } from '@shared/types'
import { paths } from './paths'

const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'

function releaseAsset(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

export function ffmpegPath(): string | null {
  const p = ffmpegStatic as unknown as string | null
  if (!p) return null
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p
}

function runCapture(bin: string, args: string[], timeoutMs = 20000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ChildProcess
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) })
      return
    }
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

let cached: YtDlpStatus | null = null

export async function ytdlpStatus(force = false): Promise<YtDlpStatus> {
  if (cached && !force) return cached
  const candidates: { path: string; source: YtDlpStatus['source'] }[] = [
    { path: join(process.resourcesPath ?? '', 'resources', exe), source: 'bundled' },
    { path: join(paths.bin, exe), source: 'downloaded' },
    { path: exe, source: 'system' }
  ]
  for (const c of candidates) {
    if (c.source !== 'system' && !existsSync(c.path)) continue
    const r = await runCapture(c.path, ['--version'])
    if (r.code === 0) {
      cached = { installed: true, version: r.stdout.trim(), path: c.path, source: c.source }
      return cached
    }
  }
  cached = { installed: false }
  return cached
}

/** Downloads (or updates) the standalone yt-dlp binary into the app data folder. */
export async function installYtDlp(): Promise<YtDlpStatus> {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${releaseAsset()}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`yt-dlp download failed: HTTP ${res.status}`)
  const target = join(paths.bin, exe)
  const tmp = `${target}.download`
  writeFileSync(tmp, new Uint8Array(await res.arrayBuffer()))
  if (process.platform !== 'win32') chmodSync(tmp, 0o755)
  renameSync(tmp, target)
  return ytdlpStatus(true)
}

export async function requireYtDlp(): Promise<string> {
  let status = await ytdlpStatus()
  if (!status.installed) status = await installYtDlp()
  if (!status.path) throw new Error('yt-dlp is not available')
  return status.path
}

export interface RunHandle {
  child: ChildProcess
  done: Promise<{ code: number; stderr: string }>
}

/** Runs yt-dlp and streams stdout line by line. */
export function runYtDlp(bin: string, args: string[], onLine: (line: string) => void): RunHandle {
  const child = spawn(bin, args, { windowsHide: true })
  let buf = ''
  let stderr = ''
  const feed = (chunk: Buffer): void => {
    buf += chunk.toString('utf8')
    let i: number
    while ((i = buf.search(/\r|\n/)) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) onLine(line)
    }
  }
  child.stdout?.on('data', feed)
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf8')
    if (stderr.length > 20000) stderr = stderr.slice(-10000)
  })
  const done = new Promise<{ code: number; stderr: string }>((resolve) => {
    child.on('error', (e) => resolve({ code: -1, stderr: stderr + String(e) }))
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim())
      resolve({ code: code ?? -1, stderr })
    })
  })
  return { child, done }
}

/** Runs yt-dlp and parses its JSON output (-J). */
export async function ytdlpJson<T>(bin: string, args: string[], timeoutMs = 60000): Promise<T> {
  const r = await runCapture(bin, ['--no-warnings', '-J', ...args], timeoutMs)
  if (r.code !== 0) throw new Error(lastError(r.stderr) || `yt-dlp exited with ${r.code}`)
  return JSON.parse(r.stdout) as T
}

export function lastError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim())
  const err = [...lines].reverse().find((l) => l.startsWith('ERROR'))
  return (err ?? lines[lines.length - 1] ?? '').replace(/^ERROR:\s*/, '').slice(0, 300)
}
