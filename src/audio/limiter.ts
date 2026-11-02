/**
 * Look-ahead brick-wall limiter, run as an AudioWorklet.
 *
 * Volume above 100% and EQ boosts can push samples past 0 dBFS, which is what
 * produces audible crackle ("хрипы"). The limiter delays the signal by a few
 * milliseconds, looks at the upcoming peaks and lowers the gain *before* they
 * arrive, so the output never clips and there is no hard-clipping distortion.
 */
export const LIMITER_WORKLET = /* js */ `
class VelvetLimiter extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ceiling = 0.966            // -0.3 dBFS
    this.look = Math.max(16, Math.round(sampleRate * 0.004))   // 4 ms look-ahead
    this.attack = 1 - Math.exp(-1 / (this.look / 6))
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.12))       // 120 ms release
    this.gain = 1
    this.delay = [new Float32Array(this.look), new Float32Array(this.look)]
    this.tdelay = new Float32Array(this.look).fill(1)   // target gain of each delayed sample
    this.pos = 0
    // monotonic deque over the target gains of the look-ahead window
    this.qVal = new Float32Array(this.look + 2)
    this.qIdx = new Float64Array(this.look + 2)
    this.qHead = 0
    this.qTail = 0
    this.n = 0
    this.port.onmessage = (e) => { if (e.data && typeof e.data.ceiling === 'number') this.ceiling = e.data.ceiling }
  }
  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const frames = output[0].length
    const chans = Math.min(2, output.length)
    const look = this.look
    const cap = look + 2
    for (let i = 0; i < frames; i++) {
      let peak = 0
      for (let c = 0; c < chans; c++) {
        const ch = input && input[c] ? input[c] : (input && input[0] ? input[0] : null)
        const v = ch ? ch[i] : 0
        const a = v < 0 ? -v : v
        if (a > peak) peak = a
      }
      const target = peak > this.ceiling ? this.ceiling / peak : 1
      const n = this.n++
      // push target, keeping the deque increasing so the front is the window minimum
      while (this.qTail !== this.qHead) {
        const last = (this.qTail - 1 + cap) % cap
        if (this.qVal[last] >= target) this.qTail = last
        else break
      }
      this.qVal[this.qTail] = target
      this.qIdx[this.qTail] = n
      this.qTail = (this.qTail + 1) % cap
      while (this.qIdx[this.qHead] < n - look) this.qHead = (this.qHead + 1) % cap
      const want = this.qVal[this.qHead]
      this.gain += (want - this.gain) * (want < this.gain ? this.attack : this.release)
      const pos = this.pos
      // never apply more gain than the delayed sample itself allows
      const delayedTarget = this.tdelay[pos]
      this.tdelay[pos] = target
      const g = this.gain < delayedTarget ? this.gain : delayedTarget
      for (let c = 0; c < chans; c++) {
        const ch = input && input[c] ? input[c] : (input && input[0] ? input[0] : null)
        const delayed = this.delay[c][pos]
        this.delay[c][pos] = ch ? ch[i] : 0
        let out = delayed * g
        if (out > this.ceiling) out = this.ceiling
        else if (out < -this.ceiling) out = -this.ceiling
        output[c][i] = out
      }
      this.pos = pos + 1 === look ? 0 : pos + 1
    }
    for (let c = chans; c < output.length; c++) output[c].set(output[0])
    return true
  }
}
registerProcessor('velvet-limiter', VelvetLimiter)
`

/** Synthesises a smooth stereo reverb impulse (no external IR files needed). */
export function createImpulse(ctx: BaseAudioContext, seconds = 2.6, decay = 3.2): AudioBuffer {
  const rate = ctx.sampleRate
  const length = Math.floor(rate * seconds)
  const pre = Math.floor(rate * 0.018)
  const buf = ctx.createBuffer(2, length, rate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / (length - pre)
      const noise = Math.random() * 2 - 1
      // one-pole low-pass that gets darker over time, like a real room
      const k = 0.55 - 0.4 * t
      lp += (noise - lp) * k
      d[i] = lp * Math.pow(1 - t, decay)
    }
  }
  return buf
}
