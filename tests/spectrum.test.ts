import { describe, expect, it } from 'vitest'
import { BeatDetector, Peaks, bandAverage, level, logBands, rms, smoothBands, triggerIndex } from '@renderer/audio/spectrum'

/** A spectrum (dB per bin) with one loud tone at `freq`. */
function toneSpectrum(freq: number, sampleRate = 48000, bins = 4096): Float32Array {
  const db = new Float32Array(bins).fill(-110)
  const binHz = sampleRate / 2 / bins
  const k = Math.round(freq / binHz)
  for (let d = -2; d <= 2; d++) db[k + d] = -20 - Math.abs(d) * 12
  return db
}

describe('spectrum', () => {
  it('maps dB to 0..1', () => {
    expect(level(-Infinity)).toBe(0)
    expect(level(-100)).toBe(0)
    expect(level(-10)).toBe(1)
    expect(level(-47)).toBeCloseTo(0.5, 1)
  })

  it('puts a tone into the right log band, low and high', () => {
    for (const freq of [55, 440, 5000]) {
      const bands = logBands(toneSpectrum(freq), 48000, 96)
      const loudest = bands.indexOf(Math.max(...bands))
      const expected = Math.floor((Math.log(freq / 30) / Math.log(16000 / 30)) * 96)
      expect(Math.abs(loudest - expected)).toBeLessThanOrEqual(1)
      expect(bands[loudest]).toBeGreaterThan(0.6)
      // far away bands stay quiet
      expect(bands[(loudest + 40) % 96]).toBeLessThan(0.1)
    }
  })

  it('narrow bass bands are interpolated, not blocky copies of one bin', () => {
    const db = new Float32Array(1024).fill(-110)
    for (let k = 0; k < 8; k++) db[k] = -30 - k * 6
    const bands = logBands(db, 48000, 64, undefined, 30, 16000, 0)
    const low = Array.from(bands.slice(0, 12))
    expect(new Set(low.map((v) => v.toFixed(4))).size).toBeGreaterThan(6)
  })

  it('rises fast and falls slowly', () => {
    const cur = new Float32Array([0, 1])
    smoothBands(cur, new Float32Array([1, 0]), 1 / 60)
    expect(cur[0]).toBeCloseTo(0.55)
    expect(cur[1]).toBeCloseTo(0.86)
  })

  it('peak caps hold, then fall, never below the band', () => {
    const p = new Peaks(1)
    p.update(new Float32Array([0.8]), 1 / 60)
    for (let i = 0; i < 10; i++) p.update(new Float32Array([0.1]), 1 / 60)
    expect(p.values[0]).toBeCloseTo(0.8)
    for (let i = 0; i < 120; i++) p.update(new Float32Array([0.1]), 1 / 60)
    expect(p.values[0]).toBeCloseTo(0.1)
  })

  it('detects kicks in the bass and ignores a steady level', () => {
    const b = new BeatDetector()
    let beats = 0
    // 2 s steady, then kicks every 0.5 s
    for (let f = 0; f < 120; f++) beats += b.update(0.4, f / 60) ? 1 : 0
    expect(beats).toBe(0)
    for (let f = 120; f < 360; f++) {
      const t = f / 60
      const kick = (t % 0.5) < 0.05 ? 0.9 : 0.35
      beats += b.update(kick, t) ? 1 : 0
    }
    expect(beats).toBeGreaterThanOrEqual(6)
    expect(beats).toBeLessThanOrEqual(9)
  })

  it('starts the waveform at the same phase every frame', () => {
    const make = (phase: number): Float32Array => Float32Array.from({ length: 4096 }, (_, i) => Math.sin(phase + (i / 100) * Math.PI * 2))
    const a = make(0.3)
    const b = make(2.1)
    const ia = triggerIndex(a, 2048)
    const ib = triggerIndex(b, 2048)
    expect(a[ia - 1]).toBeLessThan(0)
    expect(a[ia]).toBeGreaterThanOrEqual(0)
    // both windows start at the same point of the cycle
    expect(Math.abs(a[ia + 25] - b[ib + 25])).toBeLessThan(0.05)
  })

  it('averages and measures loudness', () => {
    expect(bandAverage(new Float32Array([1, 1, 0, 0]), 0, 0.5)).toBe(1)
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBe(1)
  })
})
