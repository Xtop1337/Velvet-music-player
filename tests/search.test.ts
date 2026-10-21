import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))
const { toResults } = await import('../src/main/services/search')

describe('toResults', () => {
  it('maps YouTube flat search entries', () => {
    const r = toResults(
      [
        {
          id: 'abc',
          title: 'Snowfall',
          url: 'https://www.youtube.com/watch?v=abc',
          channel: 'Øneheart - Topic',
          duration: 129,
          thumbnails: [{ url: 'small', width: 120 }, { url: 'mid', width: 480 }, { url: 'huge', width: 1280 }]
        },
        { id: 'x', url: 'https://youtube.com/watch?v=x' }
      ],
      'youtube'
    )
    expect(r).toEqual([
      { id: 'youtube:abc', title: 'Snowfall', artist: 'Øneheart', duration: 129, url: 'https://www.youtube.com/watch?v=abc', thumbnail: 'mid', source: 'youtube' }
    ])
  })
  it('splits "Artist - Title" uploads', () => {
    const [r] = toResults([{ id: '1', title: 'Neon Coast - Midnight Drive', uploader: 'label', webpage_url: 'https://soundcloud.com/a/b' }], 'soundcloud')
    expect(r).toMatchObject({ artist: 'Neon Coast', title: 'Midnight Drive', url: 'https://soundcloud.com/a/b' })
  })
})
