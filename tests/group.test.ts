import { describe, expect, it } from 'vitest'
import type { Track } from '@shared/types'
import { groupAlbums, groupArtists, sortTracks, splitArtists, tracksOfArtist } from '../src/renderer/src/lib/group'

const t = (id: string, title: string, artist: string, album: string, extra: Partial<Track> = {}): Track => ({
  id, path: `/${id}`, title, artist, album, duration: 100, source: 'local', addedAt: 0, ...extra
})
const tracks: Record<string, Track> = {
  a: t('a', 'Intro', 'Neon Coast', 'Afterglow', { trackNo: 1 }),
  b: t('b', 'Drive', 'Neon Coast feat. Aurora', 'Afterglow', { trackNo: 2, playCount: 5 }),
  c: t('c', 'Snow', 'Aurora', 'Winter', { playCount: 2 }),
  d: t('d', 'Loose', 'Aurora & Neon Coast', '')
}
const ids = ['a', 'b', 'c', 'd']

describe('grouping', () => {
  it('splits multi-artist strings', () => {
    expect(splitArtists('A, B & C feat. D')).toEqual(['A', 'B', 'C', 'D'])
  })
  it('groups albums in track-number order and skips tracks without album', () => {
    const albums = groupAlbums(ids, tracks)
    expect(albums.map((a) => a.album)).toEqual(['Afterglow', 'Winter'])
    expect(albums[0]).toMatchObject({ artist: 'Neon Coast', trackIds: ['a', 'b'], duration: 200 })
  })
  it('credits every artist of a collaboration', () => {
    const artists = groupArtists(ids, tracks)
    expect(artists.map((a) => a.name)).toEqual(['Aurora', 'Neon Coast'])
    expect(artists.find((a) => a.name === 'Aurora')).toMatchObject({ trackIds: ['b', 'c', 'd'], albums: 2, plays: 7 })
    expect(tracksOfArtist('neon coast', ids, tracks)).toEqual(['a', 'b', 'd'])
  })
  it('sorts by any column', () => {
    expect(sortTracks(ids, tracks, 'title', false)).toEqual(['b', 'a', 'd', 'c'])
    expect(sortTracks(ids, tracks, 'plays', true)[0]).toBe('b')
    expect(sortTracks(ids, tracks, 'added', false)).toEqual(['d', 'c', 'b', 'a'])
  })
})
