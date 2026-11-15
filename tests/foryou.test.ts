import { describe, expect, it } from 'vitest'
import type { HistoryEntry, SmartPlaylist, Track } from '@shared/types'
import { forgottenTracks } from '../src/lib/forgotten'
import { genreFamily } from '../src/lib/genres'
import { camelotRank, sortTracks } from '../src/lib/group'
import { buildDailyMixes, moodOf, withNewSongs } from '../src/lib/mixes'
import { keysCompatible, localRadio, tempoCloseness } from '../src/lib/radio'
import { trackKey } from '../src/lib/recommend'
import { evaluateSmart, matchesRule, smartTemplate } from '../src/lib/smart'
import { buildProfile, splitArtistNames } from '../src/lib/taste'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

const t = (id: string, extra: Partial<Track> = {}): Track => ({
  id, path: `/${id}.mp3`, title: `Song ${id}`, artist: 'Artist', album: '', duration: 200, source: 'local', addedAt: NOW - 200 * DAY, ...extra
})
const lib = (...ts: Track[]): Record<string, Track> => Object.fromEntries(ts.map((x) => [x.id, x]))
const play = (id: string, daysAgo: number, s = 180): HistoryEntry => ({ t: id, at: NOW - daysAgo * DAY, s })

describe('forgotten tracks', () => {
  it('finds loved songs not played for a while', () => {
    const tracks = lib(
      t('liked-old', { liked: true }),
      t('liked-recent', { liked: true }),
      t('often-old'),
      t('rare-old'),
      t('liked-new', { liked: true, addedAt: NOW - 3 * DAY })
    )
    const history = [
      play('liked-old', 90),
      play('liked-recent', 2),
      ...Array.from({ length: 6 }, (_, i) => play('often-old', 100 + i)),
      play('rare-old', 120)
    ]
    // equally loved: the one silent for longer first
    expect(forgottenTracks(tracks, history, { now: NOW })).toEqual(['often-old', 'liked-old'])
  })
})

describe('genres', () => {
  it('groups raw genres into families', () => {
    expect(genreFamily('Drift Phonk')).toBe('phonk')
    expect(genreFamily('Russian Rap')).toBe('hiphop')
    expect(genreFamily('Deep House')).toBe('dance')
    expect(genreFamily('Альтернатива')).toBe('indie')
    expect(genreFamily('Lo-Fi Beats')).toBe('lofi')
    expect(genreFamily('Polka')).toBe('other')
    expect(genreFamily('')).toBeNull()
  })
})

describe('daily mixes', () => {
  const many = (prefix: string, n: number, extra: Partial<Track>): Track[] =>
    Array.from({ length: n }, (_, i) => t(`${prefix}${i}`, { artist: `${prefix}-artist-${i % 4}`, ...extra }))

  it('makes genre mixes that stay the same all day and change the next', () => {
    const tracks = lib(...many('rock', 30, { genre: 'Rock' }), ...many('rap', 25, { genre: 'Hip-Hop' }), ...many('misc', 5, { genre: 'Polka' }))
    const a = buildDailyMixes(tracks, [], { date: '2026-11-12', now: NOW })
    const b = buildDailyMixes(tracks, [], { date: '2026-11-12', now: NOW })
    const c = buildDailyMixes(tracks, [], { date: '2026-11-13', now: NOW })
    expect(a.map((m) => m.family)).toEqual(expect.arrayContaining(['rock', 'hiphop']))
    expect(a).toEqual(b)
    expect(a.find((m) => m.family === 'rock')!.trackIds).not.toEqual(c.find((m) => m.family === 'rock')!.trackIds)
    const rock = a.find((m) => m.family === 'rock')!
    expect(rock.trackIds).toHaveLength(20)
    expect(new Set(rock.trackIds).size).toBe(20)
    expect(rock.trackIds.every((id) => tracks[id].genre === 'Rock')).toBe(true)
    // no artist twice in a row
    for (let i = 1; i < rock.trackIds.length; i++) expect(tracks[rock.trackIds[i]].artist).not.toBe(tracks[rock.trackIds[i - 1]].artist)
  })

  it('falls back to artist mixes and adds moods once analysed', () => {
    const tracks = lib(
      ...Array.from({ length: 30 }, (_, i) =>
        t(`x${i}`, { artist: `A${i % 3}`, bpm: i % 2 ? 128 : 80, energy: i % 2 ? 0.8 : 0.3, key: i % 2 ? 'C major' : 'A minor', camelot: i % 2 ? '8B' : '8A' })
      )
    )
    const mixes = buildDailyMixes(tracks, [], { date: '2026-11-12', now: NOW })
    expect(mixes.some((m) => m.kind === 'artist')).toBe(true)
    expect(mixes.some((m) => m.mood === 'energetic')).toBe(true)
    expect(moodOf(tracks.x1)).toBe('energetic')
    expect(moodOf(tracks.x0)).toBe('melancholic')
    expect(buildDailyMixes(lib(t('one')), [])).toEqual([])
  })

  it('puts new songs between the library ones', () => {
    expect(withNewSongs({ id: 'm', kind: 'genre', artists: [], trackIds: ['a', 'b', 'c', 'd', 'e', 'f'], newIds: ['N1', 'N2', 'N3'] })).toEqual(['a', 'b', 'c', 'N1', 'd', 'e', 'f', 'N2', 'N3'])
  })
})

describe('smart playlists', () => {
  const tracks = lib(
    t('often', { addedAt: NOW - 100 * DAY }),
    t('often-liked', { liked: true }),
    t('new', { addedAt: NOW - 2 * DAY, bpm: 130 }),
    t('fast', { bpm: 140, genre: 'Drum & Bass', year: 2004 }),
    t('noted', { note: 'wedding song' })
  )
  const history = [...Array.from({ length: 6 }, (_, i) => play('often', i + 1)), ...Array.from({ length: 6 }, (_, i) => play('often-liked', i + 1))]
  const order = Object.keys(tracks)

  it('"played often but not liked" and "added this week"', () => {
    expect(evaluateSmart(smartTemplate('oftenNotLiked', 'x', NOW), tracks, history, order, NOW)).toEqual(['often'])
    expect(evaluateSmart(smartTemplate('addedWeek', 'x', NOW), tracks, history, order, NOW)).toEqual(['new'])
  })

  it('combines rules with all / any, sorts and limits', () => {
    const pl: SmartPlaylist = {
      id: 'p', name: 'p', createdAt: 0, limit: 1, match: 'any',
      rules: [{ field: 'bpm', op: 'gte', value: '125' }, { field: 'hasNote', op: 'is', value: 'true' }],
      sort: { key: 'bpm', desc: true }
    }
    expect(evaluateSmart({ ...pl, limit: 0 }, tracks, history, order, NOW)).toEqual(['fast', 'new', 'noted'])
    expect(evaluateSmart(pl, tracks, history, order, NOW)).toEqual(['fast'])
    expect(evaluateSmart({ ...pl, match: 'all', limit: 0 }, tracks, history, order, NOW)).toEqual([])
  })

  it('reads text, years and half-typed values sensibly', () => {
    const c = { now: NOW, plays: new Map(), recent: new Map(), last: new Map() }
    expect(matchesRule(tracks.fast, { field: 'genre', op: 'contains', value: 'bass' }, c)).toBe(true)
    expect(matchesRule(tracks.fast, { field: 'year', op: 'gte', value: '2000' }, c)).toBe(true)
    expect(matchesRule(tracks.often, { field: 'year', op: 'gte', value: '2000' }, c)).toBe(false)
    expect(matchesRule(tracks.often, { field: 'bpm', op: 'gte', value: '' }, c)).toBe(true)
  })
})

describe('offline radio', () => {
  it('prefers songs alike in artist, genre, tempo and key, two per artist', () => {
    const seed = t('seed', { artist: 'Neon', genre: 'Synthwave', bpm: 100, camelot: '8A', year: 1987 })
    const tracks = lib(
      seed,
      t('same1', { artist: 'Neon', genre: 'Synthwave', bpm: 101, camelot: '8A' }),
      t('same2', { artist: 'Neon', genre: 'Synthwave', bpm: 99, camelot: '9A' }),
      t('same3', { artist: 'Neon', genre: 'Synthwave', bpm: 100, camelot: '8A' }),
      t('alike', { artist: 'Other', genre: 'Electro', bpm: 200, camelot: '7A', year: 1985 }),
      t('far', { artist: 'Far', genre: 'Classical', bpm: 60, camelot: '3B', year: 1800 })
    )
    const out = localRadio(seed, tracks, { n: 4, random: () => 0 })
    expect(out.filter((id) => tracks[id].artist === 'Neon')).toHaveLength(2)
    expect(out.slice(0, 2).every((id) => tracks[id].artist === 'Neon')).toBe(true)
    expect(out.indexOf('alike')).toBeLessThan(out.indexOf('far'))
    expect(keysCompatible('8A', '9A')).toBe(true)
    expect(keysCompatible('8A', '8B')).toBe(true)
    expect(keysCompatible('12A', '1A')).toBe(true)
    expect(keysCompatible('8A', '3B')).toBe(false)
    expect(tempoCloseness(70, 140)).toBe(1)
  })
})

describe('taste profile', () => {
  it('weighs the whole library and learns from "not interested"', () => {
    const tracks = lib(
      t('a', { artist: 'Loved', liked: true }),
      t('b', { artist: 'Loved, Guest' }),
      t('c', { artist: 'Played' }),
      t('d', { artist: 'Skipped' }),
      t('e', { artist: 'Quiet' })
    )
    const history = [play('c', 1, 600), play('d', 1, 5), play('d', 2, 5)]
    const p = buildProfile(tracks, history, [{ key: trackKey('Banned', 'x'), artist: 'Banned', weight: 1, at: 0 }, { key: trackKey('Banned', 'y'), artist: 'Banned', weight: 1, at: 0 }], NOW)
    const names = p.artists.map((a) => a.name)
    expect(names[0]).toBe('Played')
    expect(names).toContain('Loved')
    expect(names).toContain('Guest')
    expect(names).toContain('Quiet')
    expect(names).not.toContain('Skipped')
    expect(p.excludeArtists).toEqual(['banned'])
    expect(p.excludeKeys).toContain(trackKey('Loved', 'Song a'))
    expect(splitArtistNames('A feat. B & C, D x E')).toEqual(['A', 'B', 'C', 'D', 'E'])
  })
})

describe('sorting by BPM and key', () => {
  it('orders by tempo and around the Camelot wheel, unknown last', () => {
    const tracks = lib(t('k8a', { camelot: '8A', bpm: 128 }), t('k1b', { camelot: '1B', bpm: 90 }), t('k8b', { camelot: '8B', bpm: 174 }), t('none'))
    expect(camelotRank('1A')).toBe(0)
    expect(camelotRank('12B')).toBe(23)
    expect(sortTracks(Object.keys(tracks), tracks, 'key', false)).toEqual(['k1b', 'k8a', 'k8b', 'none'])
    expect(sortTracks(Object.keys(tracks), tracks, 'bpm', true)).toEqual(['k8b', 'k8a', 'k1b', 'none'])
  })
})
