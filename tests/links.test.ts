import { describe, expect, it } from 'vitest'
import { parseMusicLink } from '@shared/links'

describe('parseMusicLink', () => {
  it('recognises Spotify tracks, albums and playlists', () => {
    expect(parseMusicLink('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc')).toEqual({
      service: 'spotify',
      kind: 'track',
      id: '4uLU6hMCjMI75M1A2tKUQC',
      url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'
    })
    expect(parseMusicLink('https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy')?.kind).toBe('album')
    expect(parseMusicLink('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')?.kind).toBe('playlist')
    expect(parseMusicLink('open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')?.service).toBe('spotify')
  })

  it('recognises SoundCloud tracks, sets and profiles', () => {
    expect(parseMusicLink('https://soundcloud.com/artist/some-track')).toMatchObject({ service: 'soundcloud', kind: 'track' })
    expect(parseMusicLink('https://soundcloud.com/artist/sets/my-album?si=1')).toMatchObject({
      service: 'soundcloud',
      kind: 'playlist',
      url: 'https://soundcloud.com/artist/sets/my-album'
    })
    expect(parseMusicLink('https://m.soundcloud.com/artist')).toMatchObject({ kind: 'user' })
    expect(parseMusicLink('https://on.soundcloud.com/AbCd123')).toMatchObject({ kind: 'short' })
  })

  it('recognises YouTube and rejects other links', () => {
    expect(parseMusicLink('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ service: 'youtube', kind: 'track' })
    expect(parseMusicLink('https://www.youtube.com/playlist?list=PL123')).toMatchObject({ kind: 'playlist' })
    expect(parseMusicLink('https://example.com/song.mp3')).toBeNull()
    expect(parseMusicLink('https://open.spotify.com/artist/abc')).toBeNull()
    expect(parseMusicLink('')).toBeNull()
  })
})
