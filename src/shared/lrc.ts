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
