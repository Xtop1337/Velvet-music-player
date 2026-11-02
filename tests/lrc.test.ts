import { describe, expect, it } from 'vitest'
import { activeLine, parseLrc, toLrc } from '@shared/lrc'

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

import { estimateTimes, lineProgress } from '@shared/lrc'

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
