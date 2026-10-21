/** Pure helpers for matching Spotify metadata to downloadable audio (exported for tests). */

export interface Candidate {
  url: string
  title: string
  channel?: string
  duration?: number
}

const JUNK = ['live', 'cover', 'remix', 'slowed', 'sped up', 'speed up', 'nightcore', '8d', 'karaoke', 'instrumental', 'reverb', 'bass boosted', 'lyrics video', 'reaction', 'tutorial']

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/feat\.?|ft\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function words(s: string): string[] {
  return normalize(s).split(' ').filter((w) => w.length > 1)
}

/** Higher is better. */
export function scoreCandidate(c: Candidate, want: { title: string; artists: string[]; durationSec: number }): number {
  let score = 0
  const hay = normalize(`${c.title} ${c.channel ?? ''}`)
  const titleWords = words(want.title)
  const hits = titleWords.filter((w) => hay.includes(w)).length
  score += titleWords.length ? (hits / titleWords.length) * 40 : 0
  const artistHit = want.artists.some((a) => normalize(a) && hay.includes(normalize(a)))
  if (artistHit) score += 25
  if (c.channel && / - topic$/i.test(c.channel)) score += 15
  if (/official (audio|video)|provided to youtube/i.test(c.title)) score += 5

  const wantedTitle = want.title.toLowerCase()
  for (const j of JUNK) {
    if (c.title.toLowerCase().includes(j) && !wantedTitle.includes(j)) score -= 25
  }

  if (want.durationSec > 0 && c.duration && c.duration > 0) {
    const diff = Math.abs(c.duration - want.durationSec)
    if (diff <= 2) score += 30
    else if (diff <= 5) score += 20
    else if (diff <= 12) score += 8
    else if (diff > 30) score -= 30
  }
  return score
}

export function pickBest(cands: Candidate[], want: { title: string; artists: string[]; durationSec: number }): Candidate | null {
  let best: Candidate | null = null
  let bestScore = -Infinity
  for (const c of cands) {
    const s = scoreCandidate(c, want)
    if (s > bestScore) {
      best = c
      bestScore = s
    }
  }
  return bestScore >= 20 ? best : null
}

/** SoundCloud uploads are often titled "Artist - Title"; split them when the artist field is empty. */
export function splitArtistTitle(title: string, uploader: string, artist?: string): { artist: string; title: string } {
  const clean = title.replace(/\s*\[(free download|out now|premiere)[^\]]*\]\s*/gi, ' ').trim()
  if (artist) return { artist, title: clean }
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(clean)
  if (m) return { artist: m[1].trim(), title: m[2].trim() }
  return { artist: uploader, title: clean }
}

export function safeFileName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 150) || 'track'
  )
}
