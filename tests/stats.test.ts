import { describe, expect, it } from 'vitest'
import type { Track } from '@shared/types'
import { countsAsPlay, summarize } from '../src/renderer/src/lib/stats'

const track = (id: string, artist: string, album: string): Track => ({
  id, path: `/${id}.mp3`, title: id.toUpperCase(), artist, album, duration: 200, source: 'local', addedAt: 0
})

describe('stats', () => {
  it('counts a play after 30 s or half of a short track', () => {
    expect(countsAsPlay(29, 200)).toBe(false)
    expect(countsAsPlay(30, 200)).toBe(true)
    expect(countsAsPlay(11, 20)).toBe(true)
  })

  it('ranks tracks, artists and albums and buckets minutes by day', () => {
    const now = new Date(2026, 9, 21, 18).getTime()
    const day = 86_400_000
    const tracks = { a: track('a', 'Neon', 'Afterglow'), b: track('b', 'Neon', 'Afterglow'), c: track('c', 'Aurora', 'Snow') }
    const history = [
      { t: 'a', at: now - 1000, s: 120 },
      { t: 'a', at: now - day, s: 180 },
      { t: 'c', at: now - day, s: 60 },
      { t: 'b', at: now - 40 * day, s: 200 } // outside 30 days
    ]
    const s = summarize(history, tracks, '30d', 'en', now)
    expect(s.plays).toBe(3)
    expect(s.seconds).toBe(360)
    expect(s.topTracks[0]).toMatchObject({ trackId: 'a', plays: 2 })
    expect(s.topArtists.map((r) => r.label)).toEqual(['Neon', 'Aurora'])
    expect(s.buckets).toHaveLength(30)
    expect(s.buckets.at(-1)!.minutes).toBe(2)
    expect(s.buckets.at(-2)!.minutes).toBe(4)
    expect(summarize(history, tracks, 'all', 'en', now).plays).toBe(4)
  })
})
