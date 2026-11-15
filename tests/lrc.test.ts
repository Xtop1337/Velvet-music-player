import { describe, expect, it } from 'vitest'
import { activeLine, isSpeedVersion, lineProgress, parseLrc, scaleLines, singingPace, stretchFactor, sungLength, syllables, toLrc, wordTimings } from '@shared/lrc'

describe('parseLrc', () => {
  it('parses timestamps, repeated stamps and offsets', () => {
    const r = parseLrc('[ar:Someone]\n[offset:+500]\n[00:01.50]Hello\n[00:05.00][00:20.25]Chorus\n[01:02.3]End')
    expect(r.synced).toBe(true)
    expect(r.lines.map((l) => [l.time, l.text])).toEqual([
      [1, 'Hello'],
      [4.5, 'Chorus'],
      [19.75, 'Chorus'],
      [61.8, 'End']
    ])
  })
  it('falls back to plain text', () => {
    const r = parseLrc('Line one\nLine two')
    expect(r.synced).toBe(false)
    expect(r.lines.map((l) => l.text)).toEqual(['Line one', 'Line two'])
  })
  it('finds the active line', () => {
    const { lines } = parseLrc('[00:01]a\n[00:05]b\n[00:09]c')
    expect(activeLine(lines, 0.5)).toBe(-1)
    expect(activeLine(lines, 5)).toBe(1)
    expect(activeLine(lines, 100)).toBe(2)
  })
  it('converts embedded synced lyrics to LRC', () => {
    expect(toLrc([{ timestamp: 61500, text: 'Hi' }])).toBe('[01:01.50]Hi')
  })
})

import { estimateTimes } from '@shared/lrc'

describe('estimateTimes / lineProgress', () => {
  it('spreads plain lines over the track in order', () => {
    const lines = parseLrc('Short\nA much longer line of the song\n\nEnd').lines
    const timed = estimateTimes(lines, 200)
    expect(timed[0].time).toBeCloseTo(12)
    for (let i = 1; i < timed.length; i++) expect(timed[i].time!).toBeGreaterThan(timed[i - 1].time!)
    expect(timed.at(-1)!.time!).toBeLessThan(190)
  })
  it('fills the current line over its singing time', () => {
    const { lines } = parseLrc('[00:10]a\n[00:12]b\n[00:40]c')
    expect(lineProgress(lines, 0, 11, 60)).toBeCloseTo(0.5)
    // long gap: the line is considered sung after ~6 s
    expect(lineProgress(lines, 1, 18, 60)).toBe(1)
  })
})

describe('word-by-word lyrics', () => {
  it('reads word timestamps of enhanced LRC', () => {
    const r = parseLrc('[00:10.00]<00:10.00>Never <00:10.60>gonna <00:11.10>give\n[00:14.00]plain line')
    expect(r.lines[0].text).toBe('Never gonna give')
    expect(r.lines[0].words).toEqual([
      { time: 10, text: 'Never' },
      { time: 10.6, text: 'gonna' },
      { time: 11.1, text: 'give' }
    ])
    expect(r.lines[1].words).toBeUndefined()
    const w = wordTimings(r.lines, 0, 60, 0.3)
    expect(w.map((x) => [x.text, x.start, x.end])).toEqual([
      ['Never', 10, 10.6],
      ['gonna', 10.6, 11.1],
      ['give', 11.1, expect.any(Number)]
    ])
    expect(w[2].end).toBeGreaterThan(11.1)
    expect(w[2].end).toBeLessThanOrEqual(14)
  })

  it('counts syllables in Russian and English', () => {
    expect(syllables('молоко')).toBe(3)
    expect(syllables('я')).toBe(1)
    expect(syllables('ночь')).toBe(1)
    expect(syllables('beautiful')).toBe(3)
    expect(syllables('time')).toBe(1)
    expect(syllables('hey!')).toBe(1)
    expect(syllables('mmm')).toBe(1)
    expect(syllables('24')).toBe(2)
  })

  it('shares a line between its words by syllables, and ends it before a long break', () => {
    // sung back to back: 4 syllables in 2 s each → 0.5 s per syllable
    const { lines } = parseLrc('[00:00]la la la la\n[00:02]да да да да\n[00:04]no no no no\n[00:06]мо ло ко я\n[00:30]end of it all')
    const pace = singingPace(lines)
    expect(pace).toBeCloseTo(0.5)
    // a line followed directly by the next one fills the whole gap
    expect(sungLength(lines, 0, 60, pace)).toBeCloseTo(2)
    // 24 s to the next line, but four syllables take about 2.5 s: the rest is a break
    expect(sungLength(lines, 3, 60, pace)).toBeLessThan(3)
    const w = wordTimings(lines, 0, 60, pace)
    expect(w.map((x) => x.start)).toEqual([0, 0.5, 1, 1.5])
    expect(w[3].end).toBeCloseTo(2)
    const uneven = wordTimings(parseLrc('[00:00]я молоко\n[00:04]x').lines, 0, 60, 1)
    // "молоко" (3 syllables) takes three times as long as "я"
    expect(uneven[1].end - uneven[1].start).toBeCloseTo(3 * (uneven[0].end - uneven[0].start))
    expect(lineProgress(lines, 3, 7.25, 60, pace)).toBeCloseTo(0.5, 1)
    expect(lineProgress(lines, 3, 20, 60, pace)).toBe(1)
  })

  it('stretches lyrics to slowed / sped-up files only', () => {
    expect(isSpeedVersion('Snowfall (Slowed + Reverb)')).toBe(true)
    expect(isSpeedVersion('Metamorphosis sped up')).toBe(true)
    expect(isSpeedVersion('Slow Dancing')).toBe(false)
    expect(stretchFactor(125, 100, true)).toBeCloseTo(1.25)
    expect(stretchFactor(80, 100, true)).toBeCloseTo(0.8)
    // not a speed version, the same length, unknown or absurd: left alone
    expect(stretchFactor(125, 100, false)).toBe(1)
    expect(stretchFactor(101, 100, true)).toBe(1)
    expect(stretchFactor(125, undefined, true)).toBe(1)
    expect(stretchFactor(400, 100, true)).toBe(1)
    const { lines } = parseLrc('[00:10.00]<00:10.00>a <00:11.00>b\n[00:20]c')
    const scaled = scaleLines(lines, 1.25)
    expect(scaled.map((l) => l.time)).toEqual([12.5, 25])
    expect(scaled[0].words!.map((x) => x.time)).toEqual([12.5, 13.75])
    expect(scaleLines(lines, 1)).toBe(lines)
  })
})
