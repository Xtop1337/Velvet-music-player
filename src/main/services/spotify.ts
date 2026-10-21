/**
 * Spotify metadata. Spotify audio is DRM-protected, so only metadata is read here;
 * the audio itself is matched on YouTube / SoundCloud by the importer.
 *
 * Two sources are supported:
 *  - the public embed page (no keys needed, playlists are capped at ~100 tracks)
 *  - the Web API with Client Credentials (optional, set in Settings → Import)
 */

export interface SpotifyItem {
  id: string
  title: string
  artists: string[]
  album: string
  durationMs: number
  coverUrl?: string
  url: string
}

export interface SpotifyRelease {
  kind: 'track' | 'album' | 'playlist'
  name: string
  coverUrl?: string
  items: SpotifyItem[]
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function idFromUri(uri: string): string {
  return uri.split(':').pop() ?? uri
}

/** Picks the largest image from the various shapes Spotify uses. */
function bestImage(entity: Json): string | undefined {
  const pools = [
    arr(obj(entity.visualIdentity).image),
    arr(obj(entity.coverArt).sources),
    arr(entity.images)
  ]
  for (const pool of pools) {
    const sorted = pool
      .map(obj)
      .filter((i) => str(i.url))
      .sort((a, b) => num(b.maxWidth ?? b.width) - num(a.maxWidth ?? a.width))
    if (sorted.length) return str(sorted[0].url)
  }
  return undefined
}

function splitArtists(subtitle: string): string[] {
  return subtitle
    .split(/\s*,\s*|\s+&\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Parses the __NEXT_DATA__ JSON of an embed page (exported for tests). */
export function parseEmbedHtml(html: string, kind: SpotifyRelease['kind']): SpotifyRelease {
  const m = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (!m) throw new Error('Spotify embed: metadata not found')
  const data = JSON.parse(m[1]) as Json
  const entity = obj(obj(obj(obj(obj(data.props).pageProps).state).data).entity)
  const name = str(entity.name) || str(entity.title)
  if (!name) throw new Error('Spotify embed: empty entity')
  const cover = bestImage(entity)

  if (kind === 'track') {
    const artists = arr(entity.artists).map((a) => str(obj(a).name)).filter(Boolean)
    return {
      kind,
      name,
      coverUrl: cover,
      items: [
        {
          id: idFromUri(str(entity.uri)) || str(entity.id),
          title: name,
          artists: artists.length ? artists : splitArtists(str(entity.subtitle)),
          album: str(obj(entity.album).name),
          durationMs: num(entity.duration),
          coverUrl: cover,
          url: `https://open.spotify.com/track/${idFromUri(str(entity.uri)) || str(entity.id)}`
        }
      ]
    }
  }

  const albumArtist = kind === 'album' ? str(entity.subtitle) : ''
  const items = arr(entity.trackList)
    .map(obj)
    .filter((t) => str(t.title))
    .map((t): SpotifyItem => {
      const id = idFromUri(str(t.uri))
      return {
        id,
        title: str(t.title),
        artists: splitArtists(str(t.subtitle) || albumArtist),
        album: kind === 'album' ? name : '',
        durationMs: num(t.duration),
        coverUrl: kind === 'album' ? cover : undefined,
        url: `https://open.spotify.com/track/${id}`
      }
    })
  return { kind, name, coverUrl: cover, items }
}

async function fetchEmbed(kind: SpotifyRelease['kind'], id: string): Promise<SpotifyRelease> {
  const res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' }
  })
  if (!res.ok) throw new Error(`Spotify: HTTP ${res.status}`)
  return parseEmbedHtml(await res.text(), kind)
}

/** Fills in cover + album for playlist items (the playlist embed doesn't list them). */
export async function enrichFromTrackEmbed(item: SpotifyItem): Promise<SpotifyItem> {
  if (item.coverUrl && item.album) return item
  try {
    const t = (await fetchEmbed('track', item.id)).items[0]
    return { ...item, coverUrl: item.coverUrl ?? t.coverUrl, album: item.album || t.album }
  } catch {
    return item
  }
}

let token: { value: string; key: string; expires: number } | null = null

async function apiToken(clientId: string, secret: string): Promise<string> {
  const key = `${clientId}:${secret}`
  if (token && token.key === key && token.expires > Date.now() + 30000) return token.value
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(key).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  })
  if (!res.ok) throw new Error(`Spotify API auth failed: HTTP ${res.status}`)
  const json = (await res.json()) as { access_token: string; expires_in: number }
  token = { value: json.access_token, key, expires: Date.now() + json.expires_in * 1000 }
  return token.value
}

async function api(path: string, auth: string): Promise<Json> {
  const res = await fetch(path.startsWith('http') ? path : `https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${auth}` }
  })
  if (!res.ok) throw new Error(`Spotify API: HTTP ${res.status}`)
  return (await res.json()) as Json
}

function apiTrack(t: Json, albumOverride?: Json): SpotifyItem {
  const album = albumOverride ?? obj(t.album)
  return {
    id: str(t.id),
    title: str(t.name),
    artists: arr(t.artists).map((a) => str(obj(a).name)).filter(Boolean),
    album: str(album.name),
    durationMs: num(t.duration_ms),
    coverUrl: bestImage(album),
    url: str(obj(t.external_urls).spotify) || `https://open.spotify.com/track/${str(t.id)}`
  }
}

async function fetchApi(kind: SpotifyRelease['kind'], id: string, clientId: string, secret: string): Promise<SpotifyRelease> {
  const auth = await apiToken(clientId, secret)
  if (kind === 'track') {
    const t = await api(`/tracks/${id}`, auth)
    const item = apiTrack(t)
    return { kind, name: item.title, coverUrl: item.coverUrl, items: [item] }
  }
  if (kind === 'album') {
    const a = await api(`/albums/${id}`, auth)
    const items: SpotifyItem[] = []
    let page = obj(a.tracks)
    for (;;) {
      for (const t of arr(page.items)) items.push(apiTrack(obj(t), a))
      if (!str(page.next)) break
      page = await api(str(page.next), auth)
    }
    return { kind, name: str(a.name), coverUrl: bestImage(a), items }
  }
  const p = await api(`/playlists/${id}?fields=name,images`, auth)
  const items: SpotifyItem[] = []
  let next = `/playlists/${id}/tracks?limit=100`
  while (next) {
    const page = await api(next, auth)
    for (const row of arr(page.items)) {
      const t = obj(obj(row).track)
      if (str(t.id) && str(t.type || 'track') === 'track') items.push(apiTrack(t))
    }
    next = str(page.next)
  }
  return { kind, name: str(p.name), coverUrl: bestImage(p), items }
}

export async function fetchSpotify(
  kind: SpotifyRelease['kind'],
  id: string,
  creds?: { clientId?: string; clientSecret?: string }
): Promise<SpotifyRelease> {
  if (creds?.clientId && creds.clientSecret) {
    try {
      return await fetchApi(kind, id, creds.clientId, creds.clientSecret)
    } catch {
      // fall back to the embed page (e.g. editorial playlists are not available to apps)
    }
  }
  return fetchEmbed(kind, id)
}
