import { describe, expect, it } from 'vitest'
import { parseEmbedHtml } from '../src/main/services/spotify'

const wrap = (entity: unknown): string =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { state: { data: { entity } } } }
  })}</script></body></html>`

describe('parseEmbedHtml', () => {
  it('parses a track embed', () => {
    const r = parseEmbedHtml(
      wrap({
        type: 'track',
        name: 'Snowfall',
        uri: 'spotify:track:abc123',
        artists: [{ name: 'Øneheart' }, { name: 'reidenshi' }],
        duration: 129000,
        visualIdentity: { image: [{ url: 'https://i.scdn.co/small', maxWidth: 64 }, { url: 'https://i.scdn.co/big', maxWidth: 640 }] }
      }),
      'track'
    )
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({
      id: 'abc123',
      title: 'Snowfall',
      artists: ['Øneheart', 'reidenshi'],
      durationMs: 129000,
      coverUrl: 'https://i.scdn.co/big'
    })
  })

  it('parses an album embed with its track list', () => {
    const r = parseEmbedHtml(
      wrap({
        type: 'album',
        name: 'After Hours',
        subtitle: 'The Weeknd',
        coverArt: { sources: [{ url: 'https://i.scdn.co/album', width: 640 }] },
        trackList: [
          { uri: 'spotify:track:t1', title: 'Alone Again', subtitle: 'The Weeknd', duration: 250000 },
          { uri: 'spotify:track:t2', title: 'Too Late', subtitle: '', duration: 239000 }
        ]
      }),
      'album'
    )
    expect(r.name).toBe('After Hours')
    expect(r.items.map((i) => i.title)).toEqual(['Alone Again', 'Too Late'])
    expect(r.items[1].artists).toEqual(['The Weeknd'])
    expect(r.items[0].album).toBe('After Hours')
    expect(r.items[0].coverUrl).toBe('https://i.scdn.co/album')
  })

  it('throws on pages without metadata', () => {
    expect(() => parseEmbedHtml('<html></html>', 'track')).toThrow()
  })
})
