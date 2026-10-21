export type LinkInfo =
  | { service: 'spotify'; kind: 'track' | 'album' | 'playlist'; id: string; url: string }
  | { service: 'soundcloud'; kind: 'track' | 'playlist' | 'user' | 'short'; url: string }
  | { service: 'youtube'; kind: 'track' | 'playlist'; url: string }

/** Recognises Spotify / SoundCloud / YouTube links. Returns null for anything else. */
export function parseMusicLink(input: string): LinkInfo | null {
  const raw = input.trim()
  if (!raw) return null

  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]+)$/.exec(raw)
  if (uri) {
    const kind = uri[1] as 'track' | 'album' | 'playlist'
    return { service: 'spotify', kind, id: uri[2], url: `https://open.spotify.com/${kind}/${uri[2]}` }
  }

  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '')
  const parts = url.pathname.split('/').filter(Boolean)

  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    // Links may carry a locale segment: /intl-de/track/<id>
    const segs = parts[0]?.startsWith('intl-') ? parts.slice(1) : parts
    const [kind, id] = segs
    if ((kind === 'track' || kind === 'album' || kind === 'playlist') && id && /^[A-Za-z0-9]+$/.test(id)) {
      return { service: 'spotify', kind, id, url: `https://open.spotify.com/${kind}/${id}` }
    }
    return null
  }

  if (host === 'on.soundcloud.com' || host === 'snd.sc') {
    return parts.length ? { service: 'soundcloud', kind: 'short', url: url.toString() } : null
  }
  if (host === 'soundcloud.com') {
    if (parts.length === 0) return null
    const clean = `https://soundcloud.com/${parts.join('/')}`
    if (parts.length === 1) return { service: 'soundcloud', kind: 'user', url: clean }
    if (parts[1] === 'sets') return { service: 'soundcloud', kind: 'playlist', url: clean }
    if (['tracks', 'albums', 'popular-tracks', 'reposts', 'likes'].includes(parts[1])) {
      return { service: 'soundcloud', kind: 'user', url: clean }
    }
    return { service: 'soundcloud', kind: 'track', url: clean }
  }

  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
    if (url.searchParams.get('list') && !url.searchParams.get('v')) {
      return { service: 'youtube', kind: 'playlist', url: url.toString() }
    }
    if (host === 'youtu.be' || url.searchParams.get('v') || parts[0] === 'shorts') {
      return { service: 'youtube', kind: 'track', url: url.toString() }
    }
    if (url.searchParams.get('list')) return { service: 'youtube', kind: 'playlist', url: url.toString() }
  }
  return null
}
