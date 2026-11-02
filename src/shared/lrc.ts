export interface LyricLine {
  /** seconds, or null for plain (unsynced) lyrics */
  time: number | null
  text: string
}

export interface ParsedLyrics {
  synced: boolean
  lines: LyricLine[]
}

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

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
    const body = raw.replace(STAMP, '').trim()
    if (stamps.length) {
      for (const m of stamps) {
        const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0
        const time = Math.max(0, Number(m[1]) * 60 + Number(m[2]) + frac - offset)
        timed.push({ time, text: body })
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

/** 0..1 progress through line `i` at `time` (for the karaoke fill). */
export function lineProgress(lines: LyricLine[], i: number, time: number, duration: number): number {
  const start = lines[i]?.time ?? 0
  const next = lines[i + 1]?.time ?? Math.max(start + 4, duration)
  // a line is "sung" over at most ~6 s, long gaps are instrumental breaks
  const len = Math.max(0.5, Math.min(next - start, 6))
  return Math.min(1, Math.max(0, (time - start) / len))
}
