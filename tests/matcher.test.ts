import { describe, expect, it } from 'vitest'
import { pickBest, safeFileName, splitArtistTitle } from '../src/main/services/matcher'

describe('pickBest', () => {
  const want = { title: 'Blinding Lights', artists: ['The Weeknd'], durationSec: 200 }

  it('prefers the original with matching duration over remixes and slowed versions', () => {
    const best = pickBest(
      [
        { url: 'a', title: 'The Weeknd - Blinding Lights (slowed + reverb)', channel: 'Slow Vibes', duration: 260 },
        { url: 'b', title: 'Blinding Lights (Remix)', channel: 'DJ X', duration: 201 },
        { url: 'c', title: 'Blinding Lights', channel: 'The Weeknd - Topic', duration: 201 },
        { url: 'd', title: 'The Weeknd - Blinding Lights (Official Video)', channel: 'TheWeekndVEVO', duration: 263 }
      ],
      want
    )
    expect(best?.url).toBe('c')
  })

  it('returns null when nothing is close', () => {
    expect(pickBest([{ url: 'x', title: 'Completely different song', channel: 'Someone', duration: 30 }], want)).toBeNull()
  })
})

describe('splitArtistTitle', () => {
  it('splits SoundCloud style titles', () => {
    expect(splitArtistTitle('Artist Name - Track Title [Free Download]', 'label')).toEqual({ artist: 'Artist Name', title: 'Track Title' })
    expect(splitArtistTitle('Just A Title', 'uploader')).toEqual({ artist: 'uploader', title: 'Just A Title' })
    expect(splitArtistTitle('Track', 'uploader', 'Real Artist')).toEqual({ artist: 'Real Artist', title: 'Track' })
  })
})

describe('safeFileName', () => {
  it('removes characters that are invalid on Windows', () => {
    expect(safeFileName('AC/DC: Back In Black?')).toBe('AC_DC_ Back In Black_')
    expect(safeFileName('name. ')).toBe('name')
  })
})
