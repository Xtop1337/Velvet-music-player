import { describe, expect, it } from 'vitest'
import type { SearchResult, Track } from '@shared/types'
import { familyAffinity, genreFamily, keywordFamily, tasteFit, trackFamily } from '../src/lib/genres'
import { trackKey } from '../src/lib/recommend'
import { buildProfile, trackWeights, type Feedback } from '../src/lib/taste'
import { artistsForMode, blendWave, candidateFamily, ownCount, ownPicks, pickWaveSeeds, rankCandidates, seedLabel } from '../src/lib/wave'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const t = (id: string, extra: Partial<Track> = {}): Track => ({
  id, path: `/${id}.mp3`, title: `Song ${id}`, artist: `Artist ${id}`, album: '', duration: 200, source: 'local', addedAt: NOW - 200 * DAY, ...extra
})
const lib = (...ts: Track[]): Record<string, Track> => Object.fromEntries(ts.map((x) => [x.id, x]))
const cand = (id: string, artist: string, title: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  id, artist, title, duration: 180, url: `https://soundcloud.com/x/${id}`, source: 'soundcloud', ...extra
})
const fb = (artist: string, title: string, weight = 1, extra: Partial<Feedback> = {}): Feedback => ({ key: trackKey(artist, title), artist, title, weight, at: NOW, ...extra })

/** A library that is mostly phonk / Brazilian funk, with a little rap and one jazz record. */
function phonkLibrary(): Record<string, Track> {
  return lib(
    ...Array.from({ length: 12 }, (_, i) => t(`p${i}`, { title: `PHONK ${i}`, artist: `Phonker ${i % 4}`, liked: i < 4, sourceUrl: `https://soundcloud.com/phonker/p${i}`, source: 'soundcloud' })),
    ...Array.from({ length: 8 }, (_, i) => t(`f${i}`, { title: `MONTAGEM ${i}`, artist: `DJ Funk ${i % 3}`, genre: 'Funk' })),
    ...Array.from({ length: 3 }, (_, i) => t(`r${i}`, { artist: `Rapper ${i}`, genre: 'Rap/Hip Hop' })),
    t('j0', { artist: 'Jazz Trio', genre: 'Jazz' })
  )
}

describe('genre families', () => {
  it('tells phonk and Brazilian funk from the genres catalogues file them under', () => {
    expect(genreFamily('Brazilian Funk')).toBe('funk')
    expect(genreFamily('Funk')).toBe('funk')
    expect(genreFamily('Drift Phonk')).toBe('phonk')
    expect(genreFamily('Rap/Hip Hop')).toBe('hiphop')
    expect(genreFamily('R&B')).toBe('rnb')
    expect(keywordFamily('MONTAGEM CORAL (Slowed)')).toBe('funk')
    expect(keywordFamily('Automotivo Bibi Fogosa')).toBe('funk')
    expect(keywordFamily('MURDER IN MY MIND phonk')).toBe('phonk')
    expect(keywordFamily('Therapy Session')).toBeNull()
    // the words in the title beat a coarse genre tag…
    expect(trackFamily({ title: 'SLAY! (Phonk)', genre: 'Rap/Hip Hop' })).toBe('phonk')
    expect(trackFamily({ title: 'Funk Estranho', genre: 'Electro' })).toBe('funk')
    // …a precise tag stands, and a plain song keeps its tag
    expect(trackFamily({ title: 'Untitled', genre: 'Phonk' })).toBe('phonk')
    expect(trackFamily({ title: 'So What', genre: 'Jazz' })).toBe('jazz')
    expect(trackFamily({ title: 'Untitled' })).toBeNull()
  })

  it('knows which families sound close', () => {
    expect(familyAffinity('phonk', 'phonk')).toBe(1)
    expect(familyAffinity('phonk', 'funk')).toBe(0.8)
    expect(familyAffinity('funk', 'phonk')).toBe(0.8)
    expect(familyAffinity('phonk', 'jazz')).toBe(0)
    const taste = new Map([['phonk', 0.7], ['hiphop', 0.3]] as const)
    expect(tasteFit('phonk', taste)).toBe(1)
    expect(tasteFit('funk', taste)).toBeCloseTo(0.8)
    expect(tasteFit('jazz', taste)).toBe(0)
    expect(tasteFit('hiphop', taste)).toBeCloseTo(0.3 / 0.7)
  })
})

describe('taste profile', () => {
  it('finds the main genre families and what each artist plays', () => {
    const p = buildProfile(phonkLibrary(), [], [], NOW)
    expect([...p.families.keys()].slice(0, 2).sort()).toEqual(['funk', 'phonk'])
    expect(p.families.get('phonk')! + p.families.get('funk')!).toBeGreaterThan(0.75)
    expect(p.artistFamily.get('phonker 0')).toBe('phonk')
    expect(p.artistFamily.get('dj funk 1')).toBe('funk')
  })

  it('learns from 👍 and 👎', () => {
    const tracks = phonkLibrary()
    const liked = buildProfile(tracks, [], { likes: [fb('New Phonker', 'X', 1, { family: 'phonk' })], dislikes: [] }, NOW)
    expect(liked.artists.map((a) => a.name)).toContain('New Phonker')
    const base = buildProfile(tracks, [], [], NOW)
    expect(liked.families.get('phonk')!).toBeGreaterThan(base.families.get('phonk')!)
    const refused = buildProfile(tracks, [], { likes: [], dislikes: [fb('Jazz Trio', 'A', 1, { family: 'jazz' }), fb('Jazz Trio', 'B', 1, { family: 'jazz' }), fb('Rapper 0', 'Skip', 0.3)] }, NOW)
    expect(refused.excludeArtists).toEqual(['jazz trio'])
    expect(refused.excludeKeys).toContain(trackKey('Jazz Trio', 'A'))
    // a quick skip doesn't ban the song itself
    expect(refused.excludeKeys).not.toContain(trackKey('Rapper 0', 'Skip'))
    expect(refused.families.get('jazz') ?? 0).toBeLessThan(base.families.get('jazz') ?? 0)
    // a liked artist is not banned by older refusals
    const both = buildProfile(tracks, [], { likes: [fb('Jazz Trio', 'C')], dislikes: [fb('Jazz Trio', 'A'), fb('Jazz Trio', 'B')] }, NOW)
    expect(both.excludeArtists).toEqual([])
  })
})

describe('my wave', () => {
  const tracks = phonkLibrary()
  const weights = trackWeights(tracks, [], NOW)
  const profile = buildProfile(tracks, [], [], NOW)
  const seq = (): (() => number) => {
    let i = 0
    return () => ((i++ * 37) % 100) / 100
  }

  it('starts from songs of the main genre, one per artist, on the chosen service first', () => {
    const seeds = pickWaveSeeds(tracks, weights, profile, 'favorite', { service: 'soundcloud', random: seq(), now: NOW })
    expect(seeds).toHaveLength(4)
    expect(seeds.every((s) => s.family === 'phonk' || s.family === 'funk')).toBe(true)
    expect(new Set(seeds.map((s) => s.artist)).size).toBe(4)
    expect(seeds.filter((s) => s.url?.includes('soundcloud.com')).length).toBeGreaterThanOrEqual(2)
    // the next batch starts from other songs
    const avoid = new Set(seeds.map((s) => trackKey(s.artist, s.title)))
    const next = pickWaveSeeds(tracks, weights, profile, 'favorite', { service: 'soundcloud', avoid, random: seq(), now: NOW })
    expect(next.some((s) => avoid.has(trackKey(s.artist, s.title)))).toBe(false)
    // a song liked in the wave becomes a seed
    const liked = pickWaveSeeds(tracks, weights, profile, 'favorite', { liked: [fb('Fresh', 'LIKED PHONK', 1, { family: 'phonk', url: 'https://soundcloud.com/fresh/x' })], random: () => 0.99, now: NOW })
    expect(liked.map((s) => s.title)).toContain('LIKED PHONK')
  })

  it('keeps to the genre in "Favourites" and opens up in "Discover"', () => {
    const seeds = [{ artist: 'Phonker 0', title: 'PHONK 0', family: 'phonk' as const }]
    const seedFamilies = new Map([[seedLabel(seeds[0]), seeds[0].family]])
    const because = seedLabel(seeds[0])
    const list = [
      cand('1', 'Kordhell', 'Murder In My Mind', { because }),
      cand('2', 'Smooth Sax', 'Late Night Jazz', { because, genre: 'Jazz' }),
      cand('3', 'MC Flow', 'Rap Freestyle', { because }),
      cand('4', 'DJ Samir', 'MONTAGEM XONADA', { because }),
      cand('5', 'Unknown Guy', 'No Words', { because: 'Somebody Else' }),
      cand('6', 'Phonker 1', 'PHONK 1', { because }),
      cand('7', 'Jazz Trio', 'New Jazz', { because })
    ]
    const strict = rankCandidates(list, { profile, mode: 'favorite', seedFamilies, random: () => 0.5 }).map((r) => r.result.id)
    // jazz and rap are out, the unknown one too; the song already in the library is skipped
    expect(strict.sort()).toEqual(['1', '4'])
    const balance = rankCandidates(list, { profile, mode: 'balance', seedFamilies, random: () => 0.5 }).map((r) => r.result.id)
    expect(balance).toContain('5')
    expect(balance).not.toContain('2')
    const open = rankCandidates(list, { profile, mode: 'discover', seedFamilies, random: () => 0.5 }).map((r) => r.result.id)
    expect(open).toEqual(expect.arrayContaining(['1', '2', '3', '4', '5', '7']))
    // songs of the genre still come first
    expect(open.indexOf('1')).toBeLessThan(open.indexOf('2'))
    expect(candidateFamily(list[0], { seedFamilies, profile })).toBe('phonk')
    expect(candidateFamily(list[1], { seedFamilies, profile })).toBe('jazz')
    expect(candidateFamily(list[2], { seedFamilies, profile })).toBe('hiphop')
  })

  it('drops refused songs and banned artists, two songs per artist at most', () => {
    const p = buildProfile(tracks, [], { likes: [], dislikes: [fb('Bad One', 'PHONK X'), fb('Banned', 'A'), fb('Banned', 'B')] }, NOW)
    const list = [
      cand('1', 'Bad One', 'PHONK X'),
      cand('2', 'Banned', 'PHONK C'),
      cand('3', 'Same', 'PHONK 1a'),
      cand('4', 'Same', 'PHONK 2a'),
      cand('5', 'Same', 'PHONK 3a'),
      cand('6', 'Other', 'PHONK Z')
    ]
    const out = rankCandidates(list, { profile: p, mode: 'favorite', seedFamilies: new Map(), random: () => 0.5 }).map((r) => r.result)
    expect(out.map((r) => r.id).sort()).toEqual(['3', '4', '6'])
    expect(out[0].artist === 'Same' && out[1].artist === 'Same').toBe(false)
  })

  it("mixes in the user's own songs by the mode's share", () => {
    expect(ownCount(10, 'favorite')).toBe(6)
    expect(ownCount(10, 'discover')).toBe(2)
    const mine = ownPicks(tracks, weights, profile, 'favorite', 8, { random: seq() })
    expect(mine).toHaveLength(8)
    expect(mine.every((id) => ['phonk', 'funk'].includes(trackFamily(tracks[id])!))).toBe(true)
    const blended = blendWave(['o1', 'o2', 'o3', 'o4', 'o5', 'o6'], ['n1', 'n2', 'n3', 'n4'], 0.6)
    expect(blended).toHaveLength(10)
    // six of every ten are the user's own, spread evenly
    expect(blended.slice(0, 5).filter((x) => x.startsWith('o')).length).toBeGreaterThanOrEqual(2)
    expect(blended.slice(0, 5).filter((x) => x.startsWith('n')).length).toBeGreaterThanOrEqual(2)
    expect(blendWave([], ['n1', 'n2'], 0.6)).toEqual(['n1', 'n2'])
    expect(blendWave(['o1'], [], 0.2)).toEqual(['o1'])
    // only artists of the allowed genres are asked about
    const names = artistsForMode(profile, 'favorite').map((a) => a.name)
    expect(names).not.toContain('Jazz Trio')
    expect(names).toContain('Phonker 0')
    expect(artistsForMode(profile, 'discover').map((a) => a.name)).toContain('Jazz Trio')
  })
})
