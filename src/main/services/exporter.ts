import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFile } from 'music-metadata'
import type { ExportOptions, ExportProgress } from '@shared/types'
import { readTrack } from './library'
import { safeFileName } from './matcher'
import { paths } from './paths'
import { writeTags } from './tags'
import { ffmpegPath } from './ytdlp'

const CEILING = 0.966 // same -0.3 dBFS ceiling as the player's limiter

/** Same reverb impulse as the player (renderer/audio/limiter.ts), deterministic for exports. */
function impulseWav(sampleRate: number): string {
  const file = join(paths.cache, `impulse-${sampleRate}.wav`)
  if (existsSync(file)) return file
  const seconds = 2.6
  const decay = 3.2
  const length = Math.floor(sampleRate * seconds)
  const pre = Math.floor(sampleRate * 0.018)
  const data = new Float32Array(length * 2)
  let seed = 1234567
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let c = 0; c < 2; c++) {
    let lp = 0
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / (length - pre)
      lp += (rnd() * 2 - 1 - lp) * (0.55 - 0.4 * t)
      data[i * 2 + c] = lp * Math.pow(1 - t, decay)
    }
  }
  // 32-bit float WAV
  const bytes = data.length * 4
  const buf = Buffer.alloc(44 + bytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + bytes, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(3, 20) // IEEE float
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 8, 28)
  buf.writeUInt16LE(8, 32)
  buf.writeUInt16LE(32, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(bytes, 40)
  for (let i = 0; i < data.length; i++) buf.writeFloatLE(data[i], 44 + i * 4)
  writeFileSync(file, buf)
  return file
}

function atempoChain(rate: number): string[] {
  const out: string[] = []
  let r = rate
  while (r < 0.5) {
    out.push('atempo=0.5')
    r /= 0.5
  }
  while (r > 2) {
    out.push('atempo=2')
    r /= 2
  }
  out.push(`atempo=${r.toFixed(6)}`)
  return out
}

/** Builds the ffmpeg filter graph that reproduces the player's sound (exported for tests). */
export function buildFilterGraph(o: Pick<ExportOptions, 'rate' | 'preservesPitch' | 'reverb' | 'bass' | 'mid' | 'treble'>, sampleRate: number, hasRubberband: boolean): string {
  const chain: string[] = []
  if (Math.abs(o.rate - 1) > 0.0005) {
    if (!o.preservesPitch) chain.push(`asetrate=${Math.round(sampleRate * o.rate)}`, `aresample=${sampleRate}:resampler=soxr`)
    else if (hasRubberband) chain.push(`rubberband=tempo=${o.rate.toFixed(6)}:pitchq=quality`)
    else chain.push(...atempoChain(o.rate))
  }
  if (o.bass) chain.push(`bass=g=${o.bass}:f=110:w=0.7`)
  if (o.mid) chain.push(`equalizer=f=1200:t=q:w=0.8:g=${o.mid}`)
  if (o.treble) chain.push(`treble=g=${o.treble}:f=7500`)
  const pre = chain.length ? chain.join(',') : 'anull'
  const limiter = `alimiter=limit=${CEILING}:level=false:attack=4:release=120`
  if (o.reverb <= 0) return `[0:a]${pre},${limiter}[out]`
  const dry = Math.cos(o.reverb * Math.PI * 0.3).toFixed(4)
  const wet = (Math.sin(o.reverb * Math.PI * 0.5) * 0.9).toFixed(4)
  return [
    `[0:a]${pre},asplit=2[d][w]`,
    `[w]highpass=f=180[wh]`,
    `[wh][1:a]afir=dry=1:wet=1:gtype=-1:irnorm=1[wr]`,
    `[d]volume=${dry}[dv]`,
    `[wr]volume=${wet}[wv]`,
    `[dv][wv]amix=inputs=2:normalize=0:duration=first,${limiter}[out]`
  ].join(';')
}

let rubberband: boolean | null = null
function hasRubberband(ff: string): Promise<boolean> {
  if (rubberband !== null) return Promise.resolve(rubberband)
  return new Promise((resolve) => {
    let out = ''
    const p = spawn(ff, ['-hide_banner', '-filters'], { windowsHide: true })
    p.stdout.on('data', (d) => (out += d))
    p.on('error', () => resolve((rubberband = false)))
    p.on('close', () => resolve((rubberband = / rubberband /.test(out))))
  })
}

const CODECS: Record<ExportOptions['format'], string[]> = {
  mp3: ['-c:a', 'libmp3lame', '-b:a', '320k'],
  wav: ['-c:a', 'pcm_s16le'],
  flac: ['-c:a', 'flac', '-compression_level', '8']
}

export async function exportTrack(o: ExportOptions, onProgress: (p: ExportProgress) => void): Promise<ExportProgress> {
  const ff = ffmpegPath()
  if (!ff) throw new Error('ffmpeg not found')
  const meta = await parseFile(o.path, { duration: true, skipCovers: true }).catch(() => null)
  const sampleRate = meta?.format.sampleRate ?? 44100
  const outDuration = (meta?.format.duration ?? 0) / o.rate
  const dir = o.outDir || join(paths.defaultDownloads, 'Exports')
  mkdirSync(dir, { recursive: true })
  let file = join(dir, `${safeFileName(`${o.artist ? `${o.artist} - ` : ''}${o.title} (${o.label})`)}.${o.format}`)
  for (let n = 2; existsSync(file); n++) file = file.replace(/( \(\d+\))?\.(\w+)$/, ` (${n}).$2`)

  const graph = buildFilterGraph(o, sampleRate, await hasRubberband(ff))
  const args = ['-hide_banner', '-nostdin', '-y', '-i', o.path]
  if (o.reverb > 0) args.push('-i', impulseWav(sampleRate))
  args.push('-filter_complex', graph, '-map', '[out]', '-map_metadata', '-1', '-vn', ...CODECS[o.format], '-progress', 'pipe:1', '-nostats', file)

  const progress: ExportProgress = { id: o.id, state: 'running', percent: 0, file }
  onProgress(progress)
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ff, args, { windowsHide: true })
    let err = ''
    let buf = ''
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const m = [...buf.matchAll(/out_time_us=(\d+)/g)].pop()
      if (m && outDuration > 0) {
        progress.percent = Math.min(0.99, Number(m[1]) / 1e6 / outDuration)
        onProgress({ ...progress })
      }
      if (buf.length > 4000) buf = buf.slice(-1000)
    })
    p.stderr.on('data', (d) => {
      err += d
      if (err.length > 8000) err = err.slice(-4000)
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with ${code}`))))
  })

  const title = `${o.title} (${o.label})`
  try {
    writeTags({ path: file, title, artist: o.artist, album: o.album, coverPath: o.coverPath })
  } catch {
    // WAV may not take every tag; the file itself is fine
  }
  const track = await readTrack(file)
  track.title = title
  track.artist = o.artist
  track.album = o.album
  track.coverPath = o.coverPath ?? track.coverPath
  const done: ExportProgress = { id: o.id, state: 'done', percent: 1, file, track }
  onProgress(done)
  return done
}
