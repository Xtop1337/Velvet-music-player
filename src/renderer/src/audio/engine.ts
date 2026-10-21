import { RATE_MAX, RATE_MIN, VOLUME_MAX } from '@shared/defaults'
import { clamp } from '@renderer/lib/format'
import { createImpulse, LIMITER_WORKLET } from './limiter'

export interface Fx {
  reverb: number
  bass: number
  mid: number
  treble: number
}

type Listener = () => void

interface Deck {
  el: HTMLAudioElement
  gain: GainNode | null
}

/**
 * Playback engine:
 *   deck A/B <audio> → deck gain → bass/mid/treble EQ → dry + reverb → volume → fade → limiter → analyser → speakers
 *
 * Two decks let one track fade into the next (crossfade) or start exactly when
 * the previous one ends (gapless). Only the active deck's events are emitted.
 *
 * Speed uses the element's playbackRate. With "auto tonality" on, Chromium's
 * time-stretcher keeps the pitch; with it off the audio is simply resampled
 * (the classic slowed / nightcore sound), which is artefact-free.
 */
export class AudioEngine {
  private decks: [Deck, Deck]
  private active = 0
  private ctx: AudioContext | null = null
  private graphReady: Promise<void> | null = null
  private bass!: BiquadFilterNode
  private mid!: BiquadFilterNode
  private treble!: BiquadFilterNode
  private dry!: GainNode
  private wet!: GainNode
  private volumeNode!: GainNode
  private fade!: GainNode
  analyser: AnalyserNode | null = null

  private volume = 1
  private rate = 1
  private preservesPitch = true
  private fx: Fx = { reverb: 0, bass: 0, mid: 0, treble: 0 }
  private pauseTimer: number | null = null
  private retireTimer: number | null = null
  private listeners = new Map<string, Set<Listener>>()

  constructor() {
    const make = (i: number): Deck => {
      const el = new Audio()
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      for (const ev of ['timeupdate', 'ended', 'play', 'pause', 'loadedmetadata', 'error', 'waiting', 'playing', 'durationchange', 'seeked']) {
        el.addEventListener(ev, () => {
          if (i === this.active) this.emit(ev)
        })
      }
      return { el, gain: null }
    }
    this.decks = [make(0), make(1)]
  }

  /** The audio element of the deck that is currently playing. */
  get audio(): HTMLAudioElement {
    return this.decks[this.active].el
  }

  private get standby(): Deck {
    return this.decks[1 - this.active]
  }

  on(event: string, cb: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(cb)
    return () => this.listeners.get(event)?.delete(cb)
  }

  private emit(event: string): void {
    this.listeners.get(event)?.forEach((cb) => cb())
  }

  /** The AudioContext can only start after a user gesture, so the graph is built lazily. */
  private ensureGraph(): Promise<void> {
    if (this.graphReady) return this.graphReady
    this.graphReady = (async () => {
      const ctx = new AudioContext({ latencyHint: 'playback' })
      this.ctx = ctx

      this.bass = ctx.createBiquadFilter()
      this.bass.type = 'lowshelf'
      this.bass.frequency.value = 110
      this.mid = ctx.createBiquadFilter()
      this.mid.type = 'peaking'
      this.mid.frequency.value = 1200
      this.mid.Q.value = 0.8
      this.treble = ctx.createBiquadFilter()
      this.treble.type = 'highshelf'
      this.treble.frequency.value = 7500

      const convolver = ctx.createConvolver()
      convolver.buffer = createImpulse(ctx)
      const wetFilter = ctx.createBiquadFilter()
      wetFilter.type = 'highpass'
      wetFilter.frequency.value = 180
      this.dry = ctx.createGain()
      this.wet = ctx.createGain()
      this.volumeNode = ctx.createGain()
      this.fade = ctx.createGain()

      let limiter: AudioNode
      try {
        const url = URL.createObjectURL(new Blob([LIMITER_WORKLET], { type: 'application/javascript' }))
        await ctx.audioWorklet.addModule(url)
        URL.revokeObjectURL(url)
        limiter = new AudioWorkletNode(ctx, 'velvet-limiter', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        })
      } catch {
        // Fallback: the built-in compressor configured as a limiter.
        const comp = ctx.createDynamicsCompressor()
        comp.threshold.value = -1.5
        comp.knee.value = 0
        comp.ratio.value = 20
        comp.attack.value = 0.002
        comp.release.value = 0.12
        limiter = comp
      }

      this.analyser = ctx.createAnalyser()
      this.analyser.fftSize = 2048
      this.analyser.smoothingTimeConstant = 0.78

      this.decks.forEach((d, i) => {
        d.gain = ctx.createGain()
        d.gain.gain.value = i === this.active ? 1 : 0
        ctx.createMediaElementSource(d.el).connect(d.gain).connect(this.bass)
      })
      this.bass.connect(this.mid).connect(this.treble)
      this.treble.connect(this.dry).connect(this.volumeNode)
      this.treble.connect(wetFilter).connect(convolver).connect(this.wet).connect(this.volumeNode)
      this.volumeNode.connect(this.fade).connect(limiter).connect(this.analyser).connect(ctx.destination)

      this.applyFx(true)
      this.volumeNode.gain.value = this.volume
      this.fade.gain.value = 0
    })()
    return this.graphReady
  }

  private ramp(param: AudioParam, value: number, tau = 0.03, immediate = false): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    param.cancelScheduledValues(now)
    if (immediate) param.setValueAtTime(value, now)
    else param.setTargetAtTime(value, now, tau)
  }

  private applyFx(immediate = false): void {
    if (!this.ctx) return
    const { reverb, bass, mid, treble } = this.fx
    this.ramp(this.bass.gain, bass, 0.04, immediate)
    this.ramp(this.mid.gain, mid, 0.04, immediate)
    this.ramp(this.treble.gain, treble, 0.04, immediate)
    // equal-power style mix so adding reverb doesn't make the track louder
    this.ramp(this.dry.gain, Math.cos(reverb * Math.PI * 0.3), 0.05, immediate)
    this.ramp(this.wet.gain, Math.sin(reverb * Math.PI * 0.5) * 0.9, 0.05, immediate)
  }

  get context(): AudioContext | null {
    return this.ctx
  }

  get currentTime(): number {
    return this.audio.currentTime || 0
  }

  get duration(): number {
    const d = this.audio.duration
    return Number.isFinite(d) ? d : 0
  }

  get paused(): boolean {
    return this.audio.paused
  }

  private applyDeck(el: HTMLAudioElement): void {
    el.defaultPlaybackRate = this.rate
    el.playbackRate = this.rate
    el.preservesPitch = this.preservesPitch
  }

  /** Stops a crossfade in progress, keeping only the active deck. */
  private retireStandby(): void {
    if (this.retireTimer) {
      clearTimeout(this.retireTimer)
      this.retireTimer = null
    }
    const d = this.standby
    d.el.pause()
    if (d.gain && this.ctx) this.ramp(d.gain.gain, 0, 0, true)
    if (d.el.getAttribute('src') && d.el.dataset.preloaded !== '1') {
      d.el.removeAttribute('src')
      delete d.el.dataset.url
      d.el.load()
    }
  }

  /** Buffers the next track on the standby deck so it can start instantly. */
  preload(url: string): void {
    const d = this.standby
    if (!d.el.paused || d.el.dataset.url === url) return
    d.el.src = url
    d.el.dataset.url = url
    d.el.dataset.preloaded = '1'
    d.el.load()
  }

  /**
   * Starts `url` on the standby deck and fades the current one out over `seconds`
   * (equal-power curves, so the loudness stays even). seconds≈0 = gapless.
   */
  async crossfadeTo(url: string, seconds: number): Promise<void> {
    await this.ensureGraph()
    const ctx = this.ctx!
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.retireTimer) {
      clearTimeout(this.retireTimer)
      this.retireTimer = null
    }
    const out = this.decks[this.active]
    const inc = this.standby
    if (inc.el.dataset.url !== url) {
      inc.el.src = url
      inc.el.dataset.url = url
    }
    delete inc.el.dataset.preloaded
    if (inc.el.currentTime > 0) inc.el.currentTime = 0
    this.applyDeck(inc.el)
    const dur = Math.max(0.03, seconds)
    const now = ctx.currentTime
    const steps = 64
    const fadeIn = new Float32Array(steps)
    const fadeOut = new Float32Array(steps)
    for (let i = 0; i < steps; i++) {
      const x = i / (steps - 1)
      fadeIn[i] = Math.sin((x * Math.PI) / 2)
      fadeOut[i] = Math.cos((x * Math.PI) / 2) * out.gain!.gain.value
    }
    inc.gain!.gain.cancelScheduledValues(now)
    inc.gain!.gain.setValueAtTime(0, now)
    await inc.el.play()
    const t = ctx.currentTime
    inc.gain!.gain.cancelScheduledValues(t)
    inc.gain!.gain.setValueCurveAtTime(fadeIn, t, dur)
    out.gain!.gain.cancelScheduledValues(t)
    out.gain!.gain.setValueCurveAtTime(fadeOut, t, dur)
    this.ramp(this.fade.gain, 1, 0.02)
    this.active = 1 - this.active
    // the new deck is now the one the UI follows
    for (const ev of ['durationchange', 'playing', 'timeupdate']) this.emit(ev)
    this.retireTimer = window.setTimeout(() => {
      this.retireTimer = null
      out.el.pause()
      out.el.removeAttribute('src')
      delete out.el.dataset.url
      out.el.load()
    }, dur * 1000 + 80)
  }

  async load(url: string, startAt = 0): Promise<void> {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer)
      this.pauseTimer = null
    }
    this.retireStandby()
    if (this.ctx && !this.audio.paused) {
      // short fade-out so switching tracks never clicks
      this.ramp(this.fade.gain, 0, 0.015)
      await new Promise((r) => setTimeout(r, 70))
    }
    const deck = this.decks[this.active]
    if (deck.gain && this.ctx) this.ramp(deck.gain.gain, 1, 0, true)
    deck.el.src = url
    deck.el.dataset.url = url
    this.applyDeck(deck.el)
    if (startAt > 0) deck.el.currentTime = startAt
  }

  unload(): void {
    this.retireStandby()
    this.audio.pause()
    this.audio.removeAttribute('src')
    delete this.audio.dataset.url
    this.audio.load()
  }

  async play(): Promise<void> {
    await this.ensureGraph()
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer)
      this.pauseTimer = null
    }
    if (this.ctx!.state === 'suspended') await this.ctx!.resume()
    if (this.audio.paused) this.ramp(this.fade.gain, 0, 0, true)
    // playbackRate is reset by some browsers when the source changes
    this.applyDeck(this.audio)
    await this.audio.play()
    this.ramp(this.fade.gain, 1, 0.035)
  }

  pause(): void {
    if (!this.ctx || this.audio.paused) {
      this.audio.pause()
      return
    }
    this.ramp(this.fade.gain, 0, 0.03)
    if (this.pauseTimer) clearTimeout(this.pauseTimer)
    this.pauseTimer = window.setTimeout(() => {
      this.pauseTimer = null
      // pausing in the middle of a crossfade just finishes it
      if (this.retireTimer) this.retireStandby()
      this.audio.pause()
    }, 160)
  }

  seek(sec: number): void {
    const d = this.duration
    if (!d) return
    this.audio.currentTime = clamp(sec, 0, Math.max(0, d - 0.05))
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, VOLUME_MAX)
    if (this.ctx) this.ramp(this.volumeNode.gain, this.volume, 0.03)
  }

  setRate(r: number): void {
    this.rate = clamp(r, RATE_MIN, RATE_MAX)
    this.decks.forEach((d) => this.applyDeck(d.el))
  }

  setPreservesPitch(on: boolean): void {
    this.preservesPitch = on
    this.decks.forEach((d) => this.applyDeck(d.el))
  }

  /** Seconds of real (wall-clock) time left in the current track. */
  get remaining(): number {
    const d = this.duration
    return d ? (d - this.currentTime) / (this.rate || 1) : Infinity
  }

  setFx(fx: Partial<Fx>): void {
    this.fx = { ...this.fx, ...fx }
    this.applyFx()
  }
}

export const engine = new AudioEngine()
