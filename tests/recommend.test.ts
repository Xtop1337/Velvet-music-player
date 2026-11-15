import { describe, expect, it } from 'vitest'
import type { HistoryEntry, SearchResult, Track } from '@shared/types'
import { pickSeeds, toSeed, trackKey, withoutKnown } from '../src/lib/recommend'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

const track = (id: string, artist: string, extra: Partial<Track> = {}): Track => ({
  id, path: `/${id}.mp3`, title: `Song ${id}`, artist, album: '', duration: 200, source: 'local', addedAt: NOW - 100 * DAY, ...extra
})

const lib = (...t: Track[]): Record<string, Track> => Object.fromEntries(t.map((x) => [x.id, x]))
const listen = (t: string, daysAgo: number, minutes: number): HistoryEntry => ({ t, at: NOW - daysAgo * DAY, s: minutes * 60 })

const result = (id: string, artist: string, title: string, url = `https://x/${id}`): SearchResult => ({ id, title, artist, duration: 0, url, source: 'youtube' })

describe('recommendation seeds', () => {
  it('starts from what was listened to most lately, one track per artist', () => {
    const tracks = lib(track('a1', 'Øneheart'), track('a2', 'Øneheart, reidenshi'), track('b', 'Neon Coast'), track('c', 'Old Band'), track('d', 'Quiet'))
    const history = [listen('a1', 1, 30), listen('a2', 2, 20), listen('b', 3, 10), listen('c', 60, 500)]
    const seeds = pickSeeds(tracks, history, { now: NOW })
    // two months ago doesn't count; a2 shares its main artist with a1
    expect(seeds.map((s) => s.id)).toEqual(['a1', 'b'])
  })

  it('counts likes and new additions, and falls back to the newest tracks', () => {
    const tracks = lib(track('liked', 'A', { liked: true, likedAt: NOW - DAY }), track('new', 'B', { addedAt: NOW - DAY }), track('plain', 'C'))
    expect(pickSeeds(tracks, [], { now: NOW }).map((s) => s.id)).toEqual(['liked', 'new'])
    const fresh = lib(track('x', 'X', { addedAt: NOW - 200 * DAY }), track('y', 'Y', { addedAt: NOW - 300 * DAY }))
    expect(pickSeeds(fresh, [], { now: NOW }).map((s) => s.id)).toEqual(['x', 'y'])
    expect(pickSeeds({}, [], { now: NOW })).toEqual([])
  })

  it('draws a different mix on refresh', () => {
    const tracks = lib(...Array.from({ length: 12 }, (_, i) => track(`t${i}`, `Artist ${i}`)))
    const history = Array.from({ length: 12 }, (_, i) => listen(`t${i}`, 1, 30 - i))
    const top = pickSeeds(tracks, history, { now: NOW }).map((s) => s.id)
    expect(top).toEqual(['t0', 't1', 't2'])
    const values = [0.99, 0.99, 0.99]
    const refreshed = pickSeeds(tracks, history, { now: NOW, round: 1, random: () => values.shift() ?? 0 }).map((s) => s.id)
    expect(refreshed).toHaveLength(3)
    expect(refreshed).not.toEqual(top)
    expect(new Set(refreshed).size).toBe(3)
  })

  it('passes the track link along so services can start from it', () => {
    expect(toSeed(track('a', 'A', { sourceUrl: 'https://soundcloud.com/a/b' }))).toEqual({ artist: 'A', title: 'Song a', url: 'https://soundcloud.com/a/b' })
  })
})

describe('known tracks', () => {
  it('hides suggestions already in the library (same song or same link)', () => {
    const tracks = lib(track('a', 'Øneheart', { title: 'Snowfall' }), track('b', 'X', { sourceUrl: 'https://www.youtube.com/watch?v=zzz' }))
    const out = withoutKnown(
      [result('1', 'øneheart, reidenshi', 'Snowfall!'), result('2', 'Y', 'Other', 'https://www.youtube.com/watch?v=zzz'), result('3', 'Z', 'New one')],
      tracks
    )
    expect(out.map((r) => r.id)).toEqual(['3'])
    expect(trackKey('Øneheart, reidenshi', 'Snowfall (Slowed)')).toBe('øneheart|snowfall slowed')
  })
})
