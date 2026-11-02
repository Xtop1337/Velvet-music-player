/**
 * Turning analyser data into what the visualizers draw: log-spaced bands, smoothing,
 * falling peak caps, beats, and a steady oscilloscope trigger. Pure functions, no DOM.
 */

/** dB → 0..1 between a floor and a ceiling. */
export function level(db: number, floor = -78, ceil = -16): number {
  if (!(db > floor)) return 0
  return db >= ceil ? 1 : (db - floor) / (ceil - floor)
}

/**
 * `count` log-spaced bands between fMin and fMax from `getFloatFrequencyData` (dB per bin).
 * Bands narrower than a bin (the low end) are interpolated between bins; wider ones take their
 * loudest bin, which reads better than an average. `tilt` lifts the highs (dB per octave around
 * 1 kHz), since music naturally gets quieter towards the treble.
 */
export function logBands(db: Float32Array, sampleRate: number, count: number, out?: Float32Array, fMin = 30, fMax = 16000, tilt = 3): Float32Array {
  const res = out && out.length === count ? out : new Float32Array(count)
  const binHz = sampleRate / 2 / db.length
  const ratio = fMax / fMin
  for (let i = 0; i < count; i++) {
    const f0 = fMin * ratio ** (i / count)
    const f1 = fMin * ratio ** ((i + 1) / count)
    const b0 = f0 / binHz
    const b1 = f1 / binHz
    let v = -Infinity
    if (b1 - b0 < 1) {
      const c = (b0 + b1) / 2
      const k = Math.min(db.length - 1, Math.floor(c))
      const t = c - k
      const a = db[k]
      const b = db[Math.min(db.length - 1, k + 1)]
      v = Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * t : Math.max(a, b)
    } else {
      const end = Math.min(db.length - 1, Math.floor(b1))
      for (let k = Math.ceil(b0); k <= end; k++) if (db[k] > v) v = db[k]
    }
    res[i] = level(v + tilt * Math.log2(Math.sqrt(f0 * f1) / 1000))
  }
  return res
}

/** Moves `cur` towards `next`: fast up (attack), slower down (release); `dt` in seconds. */
export function smoothBands(cur: Float32Array, next: Float32Array, dt: number, attack = 0.55, release = 0.14): Float32Array {
  const frames = dt * 60
  const up = 1 - (1 - attack) ** frames
  const down = 1 - (1 - release) ** frames
  for (let i = 0; i < cur.length; i++) {
    const n = next[i] ?? 0
    cur[i] += (n - cur[i]) * (n > cur[i] ? up : down)
  }
  return cur
}

/** Peak caps: jump up with the band, hold a moment, then fall with gravity. */
export class Peaks {
  values: Float32Array
  private hold: Float32Array
  private speed: Float32Array

  constructor(n: number) {
    this.values = new Float32Array(n)
    this.hold = new Float32Array(n)
    this.speed = new Float32Array(n)
  }

  get length(): number {
    return this.values.length
  }

  update(bands: Float32Array, dt: number, holdFor = 0.32, gravity = 2.2): Float32Array {
    for (let i = 0; i < this.values.length; i++) {
      const v = bands[i] ?? 0
      if (v >= this.values[i]) {
        this.values[i] = v
        this.hold[i] = holdFor
        this.speed[i] = 0
      } else if (this.hold[i] > 0) {
        this.hold[i] -= dt
      } else {
        this.speed[i] += gravity * dt
        this.values[i] = Math.max(v, this.values[i] - this.speed[i] * dt)
      }
    }
    return this.values
  }
}

/**
 * Beats from the bass: compares the rise in bass energy (spectral flux) with its recent average
 * and spread. `update` returns 0, or 0..1 for how strong a beat that starts now is.
 */
export class BeatDetector {
  private prev = -1
  private mean = 0
  private dev = 0.02
  private last = -1

  update(energy: number, time: number, minGap = 0.2): number {
    if (this.prev < 0) {
      this.prev = energy
      return 0
    }
    const flux = Math.max(0, energy - this.prev)
    this.prev = energy
    const threshold = this.mean + 1.8 * this.dev + 0.012
    this.mean += (flux - this.mean) * 0.06
    this.dev += (Math.abs(flux - this.mean) - this.dev) * 0.06
    if (flux > threshold && energy > 0.18 && time - this.last >= minGap) {
      this.last = time
      return Math.min(1, 0.35 + (flux - threshold) * 6)
    }
    return 0
  }
}

/** Average of the bands between two fractions of the band list (0..1). */
export function bandAverage(bands: Float32Array, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from * bands.length))
  const b = Math.max(a + 1, Math.min(bands.length, Math.ceil(to * bands.length)))
  let s = 0
  for (let i = a; i < b; i++) s += bands[i]
  return s / (b - a)
}

/**
 * Where to start drawing a waveform window of `length` samples so that it begins at a rising zero
 * crossing: the wave then stands still instead of jittering from frame to frame.
 */
export function triggerIndex(wave: Float32Array, length: number): number {
  const last = wave.length - length
  if (last <= 1) return 0
  let best = 0
  let bestSlope = 0
  for (let i = 1; i < last; i++) {
    if (wave[i - 1] < 0 && wave[i] >= 0) {
      const slope = wave[i] - wave[i - 1]
      if (slope > bestSlope) {
        bestSlope = slope
        best = i
      }
      // the first strong crossing is enough
      if (bestSlope > 0.02 && i > length / 8) break
    }
  }
  return best
}

export function rms(wave: Float32Array, start = 0, length = wave.length): number {
  let s = 0
  const end = Math.min(wave.length, start + length)
  for (let i = start; i < end; i++) s += wave[i] * wave[i]
  return Math.sqrt(s / Math.max(1, end - start))
}
