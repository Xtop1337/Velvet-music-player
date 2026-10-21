import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, clipboard: {}, nativeImage: {} }))
const { buildFilterGraph } = await import('../src/main/services/exporter')
const base = { rate: 1, preservesPitch: true, reverb: 0, bass: 0, mid: 0, treble: 0 }

describe('buildFilterGraph', () => {
  it('resamples for slowed sound without auto tonality', () => {
    const g = buildFilterGraph({ ...base, rate: 0.8, preservesPitch: false }, 44100, true)
    expect(g).toContain('asetrate=35280')
    expect(g).toContain('aresample=44100')
    expect(g).toContain('alimiter=limit=0.966')
  })
  it('uses rubberband, or chained atempo when it is missing', () => {
    expect(buildFilterGraph({ ...base, rate: 1.5 }, 48000, true)).toContain('rubberband=tempo=1.5')
    const g = buildFilterGraph({ ...base, rate: 0.3 }, 48000, false)
    expect(g.match(/atempo=/g)?.length).toBe(2)
    expect(g).toContain('atempo=0.5,atempo=0.600000')
  })
  it('adds EQ and a convolution reverb mixed like the player', () => {
    const g = buildFilterGraph({ ...base, reverb: 0.38, bass: 3, treble: -2 }, 44100, true)
    expect(g).toContain('bass=g=3')
    expect(g).toContain('treble=g=-2')
    expect(g).toContain('afir=')
    expect(g).toContain('amix=inputs=2')
    expect(g).not.toContain('equalizer')
  })
})
