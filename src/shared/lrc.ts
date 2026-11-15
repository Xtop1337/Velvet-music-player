export interface LyricWord {
  /** seconds */
  time: number
  text: string
}

export interface LyricLine {
  /** seconds, or null for plain (unsynced) lyrics */
  time: number | null
  text: string
  /** word timestamps, when the lyrics have them (enhanced LRC: `<mm:ss.xx>word`) */
  words?: LyricWord[]
}

export interface ParsedLyrics {
  synced: boolean
  lines: LyricLine[]
}

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const WORD_STAMP = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g

function seconds(m: RegExpMatchArray): number {
  const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0
  return Number(m[1]) * 60 + Number(m[2]) + frac
}

/** `<00:12.00>Word <00:12.50>by <00:13.10>word` → the words with their times, and the plain text. */
function splitWords(body: string, offset: number): { text: string; words?: LyricWord[] } {
  const stamps = [...body.matchAll(WORD_STAMP)]
  if (!stamps.length) return { text: body }
  const words: LyricWord[] = []
  stamps.forEach((m, i) => {
    const from = m.index! + m[0].length
    const to = i + 1 < stamps.length ? stamps[i + 1].index! : body.length
    const text = body.slice(from, to).trim()
    if (text) words.push({ time: Math.max(0, seconds(m) - offset), text })
  })
  const text = body.replace(WORD_STAMP, ' ').replace(/\s+/g, ' ').trim()
  return words.length >= 2 ? { text, words } : { text }
}

/** Parses LRC (`[mm:ss.xx] line`) or plain text. Supports several stamps per line and `[offset:±ms]`. */
export function parseLrc(input: string): ParsedLyrics {
  const text = input.replace(/\r\n?/g, '\n').trim()
  if (!text) return { synced: false, lines: [] }
  let offset = 0
  const off = /^\[offset:\s*([+-]?\d+)\s*\]$/im.exec(text)
  if (off) offset = Number(off[1]) / 1000
  const timed: LyricLine[] = []
  const plain: LyricLine[] = []
  for (const raw of text.split('\n')) {
    const stamps = [...raw.matchAll(STAMP)]
    const { text: body, words } = splitWords(raw.replace(STAMP, '').trim(), offset)
    if (stamps.length) {
      for (const m of stamps) {
        const time = Math.max(0, seconds(m) - offset)
        // word times belong to the line's own stamp (a line repeated at several times has none)
        timed.push(stamps.length === 1 && words ? { time, text: body, words } : { time, text: body })
      }
    } else if (!/^\[[a-z]+:.*\]$/i.test(raw.trim())) {
      plain.push({ time: null, text: raw.trim() })
    }
  }
  if (timed.length >= 2) return { synced: true, lines: timed.sort((a, b) => a.time! - b.time!) }
  return { synced: false, lines: plain.length ? plain : timed.map((l) => ({ time: null, text: l.text })) }
}

/** Index of the line that is being sung at `time` (-1 before the first line). */
export function activeLine(lines: LyricLine[], time: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((lines[mid].time ?? Infinity) <= time) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** Converts embedded synchronized lyrics (ms timestamps) to LRC text. */
export function toLrc(lines: { timestamp?: number; text: string }[]): string {
  return lines
    .map((l) => {
      const t = (l.timestamp ?? 0) / 1000
      const m = Math.floor(t / 60)
      const s = (t % 60).toFixed(2).padStart(5, '0')
      return `[${String(m).padStart(2, '0')}:${s}]${l.text}`
    })
    .join('\n')
}

/**
 * Gives unsynced lyrics approximate timestamps so they can scroll with the song:
 * lines share the track (minus intro/outro) in proportion to their length.
 */
export function estimateTimes(lines: LyricLine[], duration: number): LyricLine[] {
  const text = lines.filter((l) => l.text.trim())
  if (!text.length || duration <= 0) return lines
  const start = Math.min(12, duration * 0.07)
  const end = duration * 0.95
  const weight = (l: LyricLine): number => (l.text.trim() ? 6 + l.text.length : 4)
  const total = lines.reduce((s, l) => s + weight(l), 0)
  let t = start
  return lines.map((l) => {
    const line = { time: t, text: l.text }
    t += ((end - start) * weight(l)) / total
    return line
  })
}

const CYRILLIC_VOWELS = /[аеёиоуыэюяіїєў]/gi
const LATIN_VOWEL_GROUPS = /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿāēīōūœ]+/gi

/** Roughly how many syllables a word is sung as (every word counts for at least one). */
export function syllables(word: string): number {
  const w = word.toLowerCase()
  const cyr = w.match(CYRILLIC_VOWELS)?.length ?? 0
  let lat = w.match(LATIN_VOWEL_GROUPS)?.length ?? 0
  // a silent final "e" (make, time) is not sung
  if (lat > 1 && /[^aeiouy]e$/.test(w.replace(/[^a-z]+$/, ''))) lat--
  const digits = w.match(/\d/g)?.length ?? 0
  return Math.max(1, cyr + lat + digits)
}

function lineSyllables(text: string): number {
  return text
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .reduce((n, w) => n + syllables(w), 0)
}

/**
 * How fast this song is sung, in seconds per syllable: the median over the lines that are
 * followed directly by the next line (no instrumental break in between).
 */
export function singingPace(lines: LyricLine[]): number {
  const paces: number[] = []
  for (let i = 0; i + 1 < lines.length; i++) {
    const n = lineSyllables(lines[i].text)
    const gap = (lines[i + 1].time ?? 0) - (lines[i].time ?? 0)
    if (n >= 3 && gap > 0.4 && gap <= 9) paces.push(gap / n)
  }
  if (paces.length < 3) return 0.3
  paces.sort((a, b) => a - b)
  // the lower half: lines sung without a pause before the next one
  const typical = paces[Math.floor(paces.length * 0.35)]
  return Math.min(0.7, Math.max(0.1, typical))
}

/**
 * How long line `i` is actually sung (seconds). The time to the next line is the upper bound;
 * when that is much longer than the words need at the song's pace, the rest is a pause or an
 * instrumental break, and the line ends early.
 */
export function sungLength(lines: LyricLine[], i: number, duration: number, pace: number): number {
  const start = lines[i]?.time ?? 0
  const next = lines[i + 1]?.time ?? Math.max(start + 4, duration)
  const gap = Math.max(0.3, next - start)
  const need = lineSyllables(lines[i]?.text ?? '') * pace
  if (need <= 0) return Math.min(gap, 4)
  // singers stretch and rush: up to half as long again still counts as singing
  return gap <= need * 1.5 + 0.4 ? gap : need * 1.15 + 0.2
}

export interface TimedWord {
  text: string
  start: number
  end: number
}

/**
 * When each word of line `i` is sung. Exact when the lyrics carry word times; otherwise the
 * line's sung time is shared between its words by their syllables.
 */
export function wordTimings(lines: LyricLine[], i: number, duration: number, pace: number): TimedWord[] {
  const line = lines[i]
  if (!line) return []
  const start = line.time ?? 0
  const next = lines[i + 1]?.time ?? Math.max(start + 4, duration)
  if (line.words?.length) {
    return line.words.map((w, k) => {
      const end = line.words![k + 1]?.time ?? Math.min(next, w.time + Math.max(0.25, syllables(w.text) * pace * 1.3))
      return { text: w.text, start: w.time, end: Math.max(w.time + 0.05, end) }
    })
  }
  const words = line.text.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const len = sungLength(lines, i, duration, pace)
  const weights = words.map((w) => (/[\p{L}\p{N}]/u.test(w) ? syllables(w) : 0.3))
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let t = start
  return words.map((text, k) => {
    const d = (len * weights[k]) / total
    const word = { text, start: t, end: t + d }
    t += d
    return word
  })
}

/** Stretches timestamps by `k` (a slowed / sped-up file of a song timed at its original speed). */
export function scaleLines(lines: LyricLine[], k: number): LyricLine[] {
  if (!Number.isFinite(k) || k <= 0 || Math.abs(k - 1) < 0.001) return lines
  return lines.map((l) => ({
    ...l,
    time: l.time === null ? null : l.time * k,
    words: l.words?.map((w) => ({ ...w, time: w.time * k }))
  }))
}

/** A slowed / sped-up / nightcore version of a song (same rule as `is_speed_version` in lyrics.rs). */
export function isSpeedVersion(title: string): boolean {
  return /slowed|sped[\s_-]*up|speed[\s_-]*up|nightcore|daycore|замедл|ускор/i.test(title)
}

/**
 * By how much to stretch lyrics timed for a recording `lyricsDuration` long so they fit a file
 * `fileDuration` long: only for speed versions (a different length otherwise means a different
 * edit, which no stretch can fix), and only within a sane range.
 */
export function stretchFactor(fileDuration: number, lyricsDuration: number | undefined, speedVersion: boolean): number {
  if (!speedVersion || !lyricsDuration || fileDuration <= 0) return 1
  const k = fileDuration / lyricsDuration
  return k > 0.5 && k < 2 && Math.abs(k - 1) > 0.02 ? k : 1
}

/** 0..1 progress through line `i` at `time` (for the karaoke fill). */
export function lineProgress(lines: LyricLine[], i: number, time: number, duration: number, pace?: number): number {
  const start = lines[i]?.time ?? 0
  if (pace) return Math.min(1, Math.max(0, (time - start) / sungLength(lines, i, duration, pace)))
  const next = lines[i + 1]?.time ?? Math.max(start + 4, duration)
  // a line is "sung" over at most ~6 s, long gaps are instrumental breaks
  const len = Math.max(0.5, Math.min(next - start, 6))
  return Math.min(1, Math.max(0, (time - start) / len))
}
