import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseMusicLink } from '@shared/links'
import type { ImportOptions, ImportProgress, Track } from '@shared/types'
import { coverFromFile, coverFromUrl } from './covers'
import { readTrack } from './library'
import { pickBest, safeFileName, splitArtistTitle, type Candidate } from './matcher'
import { paths } from './paths'
import { enrichFromTrackEmbed, fetchSpotify, type SpotifyItem } from './spotify'
import { writeTags } from './tags'
import { ffmpegPath, lastError, requireYtDlp, runYtDlp, ytdlpJson, type RunHandle } from './ytdlp'

interface YtInfo {
  _type?: string
  id?: string
  title?: string
  uploader?: string
  channel?: string
  artist?: string
  album?: string
  track?: string
  thumbnail?: string
  duration?: number
  url?: string
  webpage_url?: string
  entries?: YtInfo[]
}

interface DownloadMeta {
  title: string
  artist: string
  album: string
  coverUrl?: string
  sourceUrl: string
  source: Track['source']
}

interface Job {
  progress: ImportProgress
  handle: RunHandle | null
  cancelled: boolean
}

export interface ImporterEvents {
  progress: (p: ImportProgress) => void
  track: (jobId: string, track: Track) => void
}

const PROG = 'VELVET_PROG'
const DONE = 'VELVET_JSON'

export class Importer {
  private jobs = new Map<string, Job>()

  constructor(private events: ImporterEvents) {}

  start(opts: ImportOptions): string {
    const link = parseMusicLink(opts.url)
    const jobId = randomUUID()
    const job: Job = {
      handle: null,
      cancelled: false,
      progress: { jobId, url: opts.url, state: 'resolving', total: 0, completed: 0, failed: 0, percent: 0, trackIds: [] }
    }
    this.jobs.set(jobId, job)
    this.emit(job)
    if (!link) {
      this.fail(job, 'unsupported-link')
      return jobId
    }
    const run = link.service === 'spotify' ? this.runSpotify(job, link.kind, link.id, opts) : this.runDirect(job, link.url, opts)
    run.catch((e: unknown) => this.fail(job, e instanceof Error ? e.message : String(e)))
    return jobId
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job || job.progress.state === 'done') return
    job.cancelled = true
    job.handle?.child.kill()
    job.progress.state = 'cancelled'
    this.emit(job)
  }

  private emit(job: Job): void {
    this.events.progress({ ...job.progress, trackIds: [...job.progress.trackIds] })
  }

  private fail(job: Job, error: string): void {
    if (job.cancelled) return
    job.progress.state = 'error'
    job.progress.error = error
    this.emit(job)
  }

  private finish(job: Job): void {
    if (job.cancelled) return
    job.progress.state = job.progress.completed === 0 && job.progress.failed > 0 ? 'error' : 'done'
    job.progress.current = undefined
    job.progress.percent = 1
    if (job.progress.state === 'error' && !job.progress.error) job.progress.error = 'all-failed'
    this.emit(job)
  }

  /** SoundCloud / YouTube: yt-dlp downloads directly. */
  private async runDirect(job: Job, url: string, opts: ImportOptions): Promise<void> {
    const bin = await requireYtDlp()
    const info = await ytdlpJson<YtInfo>(bin, ['--flat-playlist', url])
    if (job.cancelled) return
    const isList = info._type === 'playlist' && Array.isArray(info.entries)
    const entries = isList ? info.entries!.filter((e) => e.url || e.webpage_url) : [info]
    job.progress.title = info.title
    job.progress.kind = isList ? (/\/sets\/|album/i.test(url) ? 'album' : 'playlist') : 'track'
    job.progress.total = entries.length
    job.progress.state = 'downloading'
    this.emit(job)

    for (const entry of entries) {
      if (job.cancelled) return
      const entryUrl = isList ? (entry.webpage_url ?? entry.url!) : url
      job.progress.current = entry.title ?? entryUrl
      job.progress.percent = 0
      this.emit(job)
      try {
        const service = /soundcloud/.test(entryUrl) ? 'soundcloud' : 'youtube'
        const track = await this.download(job, bin, entryUrl, opts, null, service)
        if (job.progress.kind === 'album' && !track.album && info.title) track.album = info.title
        this.addTrack(job, track)
      } catch (e) {
        if (job.cancelled) return
        job.progress.failed++
        job.progress.error = e instanceof Error ? e.message : String(e)
      }
      this.emit(job)
    }
    this.finish(job)
  }

  /** Spotify: metadata from Spotify, audio from the best YouTube / SoundCloud match. */
  private async runSpotify(job: Job, kind: 'track' | 'album' | 'playlist', id: string, opts: ImportOptions): Promise<void> {
    const release = await fetchSpotify(kind, id, { clientId: opts.spotifyClientId, clientSecret: opts.spotifyClientSecret })
    if (job.cancelled) return
    const bin = await requireYtDlp()
    job.progress.title = release.name
    job.progress.kind = kind
    job.progress.total = release.items.length
    job.progress.state = 'downloading'
    this.emit(job)

    for (let item of release.items) {
      if (job.cancelled) return
      job.progress.current = `${item.artists.join(', ')} — ${item.title}`
      job.progress.percent = 0
      this.emit(job)
      try {
        if (kind === 'playlist') item = await enrichFromTrackEmbed(item)
        const match = await this.findAudio(bin, item)
        if (!match) throw new Error(`not-found: ${item.title}`)
        const meta: DownloadMeta = {
          title: item.title,
          artist: item.artists.join(', '),
          album: item.album,
          coverUrl: item.coverUrl ?? release.coverUrl,
          sourceUrl: item.url,
          source: 'spotify'
        }
        this.addTrack(job, await this.download(job, bin, match.url, opts, meta, 'spotify'))
      } catch (e) {
        if (job.cancelled) return
        job.progress.failed++
        job.progress.error = e instanceof Error ? e.message : String(e)
      }
      this.emit(job)
    }
    this.finish(job)
  }

  private addTrack(job: Job, track: Track): void {
    job.progress.completed++
    job.progress.trackIds.push(track.id)
    this.events.track(job.progress.jobId, track)
  }

  private async findAudio(bin: string, item: SpotifyItem): Promise<Candidate | null> {
    const want = { title: item.title, artists: item.artists, durationSec: item.durationMs / 1000 }
    const query = `${item.artists.join(' ')} - ${item.title}`
    for (const search of [`ytsearch6:${query} audio`, `scsearch5:${query}`]) {
      try {
        const res = await ytdlpJson<YtInfo>(bin, ['--flat-playlist', search])
        const cands: Candidate[] = (res.entries ?? [])
          .filter((e) => e.url || e.webpage_url)
          .map((e) => ({
            url: e.webpage_url ?? e.url!,
            title: e.title ?? '',
            channel: e.channel ?? e.uploader,
            duration: e.duration
          }))
        const best = pickBest(cands, want)
        if (best) return best
      } catch {
        // try the next source
      }
    }
    return null
  }

  private async download(
    job: Job,
    bin: string,
    url: string,
    opts: ImportOptions,
    meta: DownloadMeta | null,
    source: Track['source']
  ): Promise<Track> {
    const dir = opts.downloadDir || paths.defaultDownloads
    mkdirSync(dir, { recursive: true })
    const thumbs = join(paths.cache, 'thumbs')
    mkdirSync(thumbs, { recursive: true })

    const name = meta ? safeFileName(`${meta.artist} - ${meta.title}`).replace(/%/g, '%%') : '%(uploader)s - %(title)s'
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--progress',
      '--windows-filenames',
      '--no-mtime',
      '-f',
      opts.format === 'm4a' ? 'bestaudio[ext=m4a]/bestaudio/best' : 'bestaudio/best',
      '-x',
      '--write-thumbnail',
      '--convert-thumbnails',
      'jpg',
      '-o',
      join(dir, `${name}.%(ext)s`),
      '-o',
      `thumbnail:${join(thumbs, '%(id)s.%(ext)s')}`,
      '--progress-template',
      `download:${PROG} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s`,
      '--print',
      `after_move:${DONE} %(.{id,title,uploader,artist,album,track,thumbnail,duration,webpage_url,filepath})j`
    ]
    if (opts.format !== 'best') args.push('--audio-format', opts.format, '--audio-quality', '0')
    const ff = ffmpegPath()
    if (ff) args.push('--ffmpeg-location', ff)
    args.push('--', url)

    let result: (YtInfo & { filepath?: string }) | null = null
    const handle = runYtDlp(bin, args, (line) => {
      if (line.startsWith(PROG)) {
        const [, done, total, estimate] = line.split(' ')
        const t = Number(total) || Number(estimate)
        if (t > 0) {
          job.progress.percent = Math.min(1, Number(done) / t)
          this.emit(job)
        }
      } else if (line.startsWith(DONE)) {
        try {
          result = JSON.parse(line.slice(DONE.length + 1))
        } catch {
          // ignore malformed line
        }
      }
    })
    job.handle = handle
    const { code, stderr } = await handle.done
    job.handle = null
    if (job.cancelled) throw new Error('cancelled')
    const info = result as (YtInfo & { filepath?: string }) | null
    if (code !== 0 || !info?.filepath) throw new Error(lastError(stderr) || `yt-dlp exited with ${code}`)

    const track = await readTrack(info.filepath, source)
    const split = splitArtistTitle(info.track || info.title || track.title, info.uploader ?? '', info.artist)
    track.title = meta?.title ?? split.title
    track.artist = meta?.artist ?? split.artist
    track.album = meta?.album ?? info.album ?? ''
    track.duration = track.duration || info.duration || 0
    track.sourceUrl = meta?.sourceUrl ?? info.webpage_url ?? url
    track.coverUrl = meta?.coverUrl ?? info.thumbnail
    track.coverUrlAuto = false

    const thumb = info.id ? join(thumbs, `${info.id}.jpg`) : ''
    try {
      if (meta?.coverUrl) track.coverPath = await coverFromUrl(meta.coverUrl)
      else if (thumb && existsSync(thumb)) track.coverPath = coverFromFile(thumb)
    } catch {
      if (thumb && existsSync(thumb)) track.coverPath = coverFromFile(thumb)
    }
    if (thumb) rmSync(thumb, { force: true })

    try {
      writeTags({ path: track.path, title: track.title, artist: track.artist, album: track.album, coverPath: track.coverPath })
    } catch {
      // the library entry still has the right metadata
    }
    return track
  }
}
