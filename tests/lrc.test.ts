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
