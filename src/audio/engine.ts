import { RATE_MAX, RATE_MIN, VOLUME_MAX } from '@shared/defaults'
import { logUi } from '@renderer/lib/diag'
import { clamp } from '@renderer/lib/format'
import { createImpulse, LIMITER_WORKLET } from './limiter'

/** `graph`: through Web Audio (effects, 200%, visualizer). `direct`: a plain <audio> (always audible). */
export type OutputMode = 'graph' | 'direct'

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
  /** the signal right after the element, before anything else (silence check) */
  tap: AnalyserNode | null
}

/**
 * Playback engine:
 *   deck A/B <audio> → deck gain → bass/mid/treble EQ → dry + reverb → mix → volume → fade → limiter → speakers
 *                                                                       └→ analyser (visualizers)
 *
 * The analyser listens before the volume knob, so visualizers look the same at 10% and at 200%.
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
  /** A finer analyser for the visualizer screen (more detail in the bass); same tap as `analyser`. */
  vizAnalyser: AnalyserNode | null = null
  private wetIn: AudioNode | null = null
  private reverbOn = false
  private reverbOffTimer: number | null = null
  private suspendTimer: number | null = null

  private volume = 1
  private rate = 1
  private preservesPitch = true
  private fx: Fx = { reverb: 0, bass: 0, mid: 0, treble: 0 }
  private pauseTimer: number | null = null
  private retireTimer: number | null = null
  private listeners = new Map<string, Set<Listener>>()
  private direct = false
  private suspending: Promise<void> | null = null
  private monitorTimer: number | null = null
  private silence = { url: '', from: 0, heard: false, stuck: 0 }
  /** why the last playback attempt failed, for the sound check */
  lastProblem = ''
  /** why the output mode last changed ('setting' when the user chose it) */
  modeReason = ''

  constructor() {
    this.decks = [this.makeDeck(0, true), this.makeDeck(1, true)]
    this.on('playing', () => this.startMonitor())
    // a seek before anything was heard restarts the check from the new position
    this.on('seeked', () => {
      if (!this.silence.heard) this.silence.from = this.audio.currentTime
    })
  }

  /** A fresh deck element. Once an element is routed into Web Audio it can never play on its own again. */
  private makeDeck(i: number, graph: boolean, gain: GainNode | null = null): Deck {
    const el = new Audio()
    if (graph) el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    for (const ev of ['timeupdate', 'ended', 'play', 'pause', 'loadedmetadata', 'error', 'waiting', 'playing', 'durationchange', 'seeked']) {
      el.addEventListener(ev, () => {
        if (this.decks[i]?.el !== el || i !== this.active) return
        this.emit(ev)
        if (ev === 'ended' || ev === 'pause') this.scheduleSuspend()
      })
    }
    return { el, gain, tap: null }
  }

  get mode(): OutputMode {
    return this.direct ? 'direct' : 'graph'
  }

  /** Routes a deck's element into the graph (graph mode, once the graph exists). */
  private connectDeck(i: number): void {
    const ctx = this.ctx
    if (!ctx || this.direct) return
    const d = this.decks[i]
    if (!d.gain) {
      d.gain = ctx.createGain()
      d.gain.connect(this.bass)
    }
    d.gain.gain.value = i === this.active ? 1 : 0
    const src = ctx.createMediaElementSource(d.el)
    src.connect(d.gain)
    d.tap = ctx.createAnalyser()
    d.tap.fftSize = 1024
    src.connect(d.tap)
  }

  /**
   * Switches between the Web Audio graph and plain playback, keeping the track and position.
   * Plain playback is the safety net when the graph stays silent on some system.
   */
  async setOutput(mode: OutputMode, reason: string, resume = true): Promise<void> {
    if ((mode === 'direct') === this.direct) return
    logUi(mode === 'direct' ? 'warn' : 'info', `audio output: ${mode} (${reason})`)
    this.modeReason = reason
    const old = this.audio
    const url = old.dataset.url
    const pos = old.currentTime
    const wasPlaying = !old.paused
    this.retireStandby()
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer)
      this.pauseTimer = null
    }
    this.direct = mode === 'direct'
    const olds = this.decks.map((d) => d.el)
    this.decks = [this.makeDeck(0, !this.direct, this.decks[0].gain), this.makeDeck(1, !this.direct, this.decks[1].gain)]
    for (const el of olds) {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
    if (!this.direct && this.ctx) {
      this.connectDeck(0)
      this.connectDeck(1)
    }
    this.silence = { url: '', from: 0, heard: true, stuck: 0 }
    this.emit('mode')
    if (url) {
      await this.load(url, pos)
      if (wasPlaying && resume) await this.play().catch(() => {})
    }
  }

  /**
   * Watches the first seconds of each track in graph mode: an element that plays while the graph
   * receives nothing but exact zeros (a WebView quirk) — or an AudioContext that won't run — means
   * nothing can be heard, so playback moves to the plain element.
   */
  private startMonitor(): void {
    if (this.direct || this.monitorTimer) return
    this.monitorTimer = window.setInterval(() => {
      const el = this.audio
      const tap = this.decks[this.active].tap
      if (this.direct || el.paused || !tap || !this.ctx) {
        if (this.monitorTimer) clearInterval(this.monitorTimer)
        this.monitorTimer = null
        return
      }
      const url = el.dataset.url ?? ''
      if (this.silence.url !== url) this.silence = { url, from: el.currentTime, heard: false, stuck: 0 }
      if (this.silence.heard) {
        if (this.monitorTimer) clearInterval(this.monitorTimer)
        this.monitorTimer = null
        return
      }
      if (this.ctx.state !== 'running') {
        this.silence.stuck += 0.5
        if (this.silence.stuck >= 3) void this.setOutput('direct', `AudioContext stays ${this.ctx.state}`)
        return
      }
      const data = new Float32Array(tap.fftSize)
      tap.getFloatTimeDomainData(data)
      if (data.some((v) => v !== 0)) {
        this.silence.heard = true
        return
      }
      if (el.currentTime - this.silence.from >= 5 && !el.muted) void this.setOutput('direct', 'the audio graph receives only silence')
    }, 500)
  }

  /** Makes sure the AudioContext runs; false if it can't be started. */
  private async wake(): Promise<boolean> {
    const ctx = this.ctx
    if (!ctx) return false
    if (this.suspending) await this.suspending.catch(() => {})
    if (ctx.state === 'running') return true
    const started = await Promise.race([ctx.resume().then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 2500))])
    // (TS narrowed `state` above; it changes while awaiting)
    return started && (ctx.state as AudioContextState) === 'running'
  }

  /** A short two-note chime through the current output (Settings → "Check sound"). */
  async testTone(): Promise<{ mode: OutputMode; context: string; sampleRate: number; problem: string }> {
    if (!this.direct) {
      await this.ensureGraph()
      const ok = await this.wake()
      if (ok && this.ctx) {
        const ctx = this.ctx
        const g = ctx.createGain()
        g.gain.value = 0
        g.connect(ctx.destination)
        const t = ctx.currentTime + 0.05
        for (const [i, f] of [660, 880].entries()) {
          const o = ctx.createOscillator()
          o.frequency.value = f
          o.connect(g)
          o.start(t + i * 0.18)
          o.stop(t + i * 0.18 + 0.16)
        }
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(0.18 * Math.min(1, this.volume || 0.5), t + 0.02)
        g.gain.setValueAtTime(0.18 * Math.min(1, this.volume || 0.5), t + 0.32)
        g.gain.linearRampToValueAtTime(0, t + 0.36)
      }
    } else {
      // a tiny generated WAV through a plain element
      const rate = 22050
      const n = Math.floor(rate * 0.36)
      const buf = new ArrayBuffer(44 + n * 2)
      const v = new DataView(buf)
      const w = (o: number, str: string): void => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true)
      for (let i = 0; i < n; i++) {
        const f = i < n / 2 ? 660 : 880
        const env = Math.min(1, i / 300, (n - i) / 300)
        v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * f * i) / rate) * 6000 * env, true)
      }
      const a = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })))
      a.volume = Math.min(1, this.volume || 0.5)
      await a.play().catch(() => {})
    }
    return { mode: this.mode, context: this.ctx?.state ?? 'none', sampleRate: this.ctx?.sampleRate ?? 0, problem: this.lastProblem }
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
      this.vizAnalyser = ctx.createAnalyser()
      this.vizAnalyser.fftSize = 8192
      this.vizAnalyser.smoothingTimeConstant = 0.5
      this.vizAnalyser.minDecibels = -100
      this.vizAnalyser.maxDecibels = -10

      this.decks.forEach((_, i) => this.connectDeck(i))
      ctx.onstatechange = () => logUi('info', `AudioContext: ${ctx.state}`)
      this.bass.connect(this.mid).connect(this.treble)
      const mix = ctx.createGain()
      this.treble.connect(this.dry).connect(mix)
      // the reverb branch is only connected while reverb is on (see applyFx): a convolver costs CPU even at 0%
      wetFilter.connect(convolver).connect(this.wet).connect(mix)
      this.wetIn = wetFilter
      mix.connect(this.volumeNode).connect(this.fade).connect(limiter).connect(ctx.destination)
      mix.connect(this.analyser)
      mix.connect(this.vizAnalyser)

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
    if (reverb > 0 && !this.reverbOn && this.wetIn) {
      if (this.reverbOffTimer) clearTimeout(this.reverbOffTimer)
      this.reverbOffTimer = null
      this.treble.connect(this.wetIn)
      this.reverbOn = true
    } else if (reverb <= 0 && this.reverbOn && !this.reverbOffTimer) {
      // let the wet gain fade out first, then detach the convolver so it stops processing
      this.reverbOffTimer = window.setTimeout(() => {
        this.reverbOffTimer = null
        if (this.fx.reverb > 0 || !this.wetIn) return
        this.treble.disconnect(this.wetIn)
        this.reverbOn = false
      }, 400)
    }
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

  /**
   * The position of what is being *heard* right now: the element's clock runs ahead of the
   * speakers by the output latency (audio device buffer, the limiter's look-ahead), which at a
   * faster playback rate is more of the song. Lyrics follow this, not `currentTime`.
   */
  get heardTime(): number {
    const t = this.audio.currentTime || 0
    if (this.direct || !this.ctx) return t
    const ctx = this.ctx as AudioContext & { outputLatency?: number }
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + 0.004
    return Math.max(0, t - Math.min(0.5, latency) * this.rate)
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
    if (!this.direct) {
      await this.ensureGraph()
      if (!(await this.wake())) await this.setOutput('direct', 'AudioContext did not start', false)
    }
    if (this.direct) {
      // plain playback has no mixer: switch straight to the next track
      await this.load(url)
      await this.play()
      return
    }
    const ctx = this.ctx!
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

  /** True when `url` is already buffered on the standby deck (see `preload`). */
  isPreloaded(url: string): boolean {
    const el = this.standby.el
    return el.dataset.url === url && el.dataset.preloaded === '1' && el.paused && !el.error
  }

  async load(url: string, startAt = 0): Promise<void> {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer)
      this.pauseTimer = null
    }
    // the track was loaded ahead on the standby deck: switch decks instead of loading it again
    if (startAt === 0 && this.isPreloaded(url)) {
      if (this.retireTimer) {
        clearTimeout(this.retireTimer)
        this.retireTimer = null
      }
      const out = this.decks[this.active]
      if (this.ctx && !this.direct && !out.el.paused) {
        this.ramp(this.fade.gain, 0, 0.015)
        await new Promise((r) => setTimeout(r, 70))
      }
      // another load may have run while waiting
      if (!this.isPreloaded(url)) return this.load(url, startAt)
      out.el.pause()
      out.el.removeAttribute('src')
      delete out.el.dataset.url
      out.el.load()
      if (out.gain && this.ctx) this.ramp(out.gain.gain, 0, 0, true)
      this.active = 1 - this.active
      const deck = this.decks[this.active]
      delete deck.el.dataset.preloaded
      if (deck.gain && this.ctx) this.ramp(deck.gain.gain, 1, 0, true)
      if (deck.el.currentTime > 0) deck.el.currentTime = 0
      this.applyDeck(deck.el)
      if (this.direct) deck.el.volume = Math.min(1, this.volume)
      // the new deck is now the one the UI follows
      for (const ev of ['durationchange', 'timeupdate']) this.emit(ev)
      return
    }
    this.retireStandby()
    if (this.ctx && !this.direct && !this.audio.paused) {
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
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer)
      this.pauseTimer = null
    }
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer)
      this.suspendTimer = null
    }
    if (!this.direct) {
      await this.ensureGraph()
      // an AudioContext that can't start would play everything as silence
      if (!(await this.wake())) await this.setOutput('direct', 'AudioContext did not start', false)
    }
    if (this.direct) {
      this.applyDeck(this.audio)
      this.audio.volume = Math.min(1, this.volume)
      await this.audio.play()
      return
    }
    if (this.audio.paused) this.ramp(this.fade.gain, 0, 0, true)
    // playbackRate is reset by some browsers when the source changes
    this.applyDeck(this.audio)
    await this.audio.play()
    this.ramp(this.fade.gain, 1, 0.035)
  }

  pause(): void {
    if (!this.ctx || this.direct || this.audio.paused) {
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
      this.scheduleSuspend()
    }, 160)
  }

  /**
   * A running AudioContext keeps processing silence (EQ, limiter, analyser) even with nothing playing.
   * Once both decks have been quiet for a moment it is suspended, so a paused player uses no CPU.
   */
  scheduleSuspend(): void {
    if (!this.ctx) return
    if (this.suspendTimer) clearTimeout(this.suspendTimer)
    this.suspendTimer = window.setTimeout(() => {
      this.suspendTimer = null
      if (this.ctx && this.ctx.state === 'running' && this.decks.every((d) => d.el.paused)) {
        // play() waits for this to finish before resuming (resuming mid-suspend left it silent)
        const done: Promise<void> = this.ctx.suspend().finally(() => {
          if (this.suspending === done) this.suspending = null
        })
        this.suspending = done
      }
    }, 1500)
  }

  /** True while sound is actually being produced (used to skip visualizer work). */
  get audible(): boolean {
    return !this.direct && !!this.ctx && this.ctx.state === 'running' && !this.audio.paused
  }

  seek(sec: number): void {
    const d = this.duration
    if (!d) return
    this.audio.currentTime = clamp(sec, 0, Math.max(0, d - 0.05))
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, VOLUME_MAX)
    if (this.direct) this.decks.forEach((d) => (d.el.volume = Math.min(1, this.volume)))
    else if (this.ctx) this.ramp(this.volumeNode.gain, this.volume, 0.03)
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
