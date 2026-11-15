import i18n from 'i18next'
import { create } from 'zustand'
import { BUILTIN_PRESETS, RATE_MAX, RATE_MIN, VOLUME_MAX } from '@shared/defaults'
import type { Preset, RepeatMode, Settings, SoundSettings, Track } from '@shared/types'
import { engine, type Fx } from '@renderer/audio/engine'
import { planTransition, secondsUntilNextStage } from '@renderer/audio/transition'
import { clamp, shuffleArray } from '@renderer/lib/format'
import { logUi } from '@renderer/lib/diag'
import { altStreamUrl, currentTransport, remoteStreamUrl, streamUrl, switchTransport } from '@renderer/lib/media'
import { useLibrary } from './library'
import { useSettings } from './settings'
import { useUi } from './ui'

export interface Sound {
  rate: number
  preservesPitch: boolean
  fx: Fx
  activePresetId: string
}

interface PlayerState extends Sound {
  queue: string[]
  /** Queue order before shuffling, to restore it. */
  original: string[]
  index: number
  currentId: string | null
  playing: boolean
  position: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  /** Sound settings to restore after a track with its own preset. */
  restoreSound: Sound | null
  /** a song from the internet is being looked up */
  resolving: boolean
  /** the last time the user skipped a song (radio learns from quick skips) */
  lastSkip: { id: string; position: number; at: number } | null

  init: (p: Settings['playback']) => void
  /** Restores the last queue and position (without starting playback). */
  restore: () => Promise<void>
  playQueue: (ids: string[], startIndex?: number) => Promise<void>
  jumpTo: (index: number) => Promise<void>
  toggle: () => Promise<void>
  play: () => Promise<void>
  pause: () => void
  next: (auto?: boolean) => Promise<void>
  prev: () => Promise<void>
  seek: (sec: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  setRate: (r: number) => void
  setPreservesPitch: (on: boolean) => void
  setFx: (fx: Partial<Fx>) => void
  applyPreset: (p: Preset, fromTrack?: boolean) => void
  /** Binds the current speed and effects to the current track (or removes the binding). */
  bindCurrent: (on: boolean) => void
  setShuffle: (on: boolean) => void
  cycleRepeat: () => void
  enqueue: (ids: string[]) => void
  playNext: (ids: string[]) => void
  removeFromQueue: (index: number) => void
  stop: () => void
  /** Moves to `index` overlapping the current track for `seconds` (crossfade / gapless). */
  transitionTo: (index: number, seconds: number) => Promise<void>
}

export function allPresets(): Preset[] {
  return [...BUILTIN_PRESETS, ...useSettings.getState().settings.customPresets]
}

function sameSound(a: Sound, p: Preset): boolean {
  return (
    Math.abs(a.rate - p.rate) < 0.005 &&
    a.preservesPitch === p.preservesPitch &&
    Math.abs(a.fx.reverb - p.reverb) < 0.005 &&
    a.fx.bass === p.bass &&
    a.fx.mid === p.mid &&
    a.fx.treble === p.treble
  )
}

/** After a manual change, re-detect which preset (if any) still matches. */
function detectPreset(s: Sound): string {
  return allPresets().find((p) => sameSound(s, p))?.id ?? ''
}

function applySound(s: Sound): void {
  engine.setRate(s.rate)
  engine.setPreservesPitch(s.preservesPitch)
  engine.setFx(s.fx)
}

function presetSound(p: Preset): Sound {
  return {
    rate: clamp(p.rate, RATE_MIN, RATE_MAX),
    preservesPitch: p.preservesPitch,
    fx: { reverb: p.reverb, bass: p.bass, mid: p.mid, treble: p.treble },
    activePresetId: p.id
  }
}

/** The speed and effects bound to a track: its preset, else its own sound; `null` when none. */
export function trackSound(track: Pick<Track, 'presetId' | 'sound'> | undefined): Sound | null {
  if (!track) return null
  const preset = track.presetId ? allPresets().find((p) => p.id === track.presetId) : undefined
  if (preset) return presetSound(preset)
  if (!track.sound) return null
  const s = presetSound({ id: '', name: '', ...track.sound })
  return { ...s, activePresetId: detectPreset(s) }
}

/** How a sound is stored on a track: as the preset it matches, or as its own values. */
export function bindingFor(s: Sound): Pick<Track, 'presetId' | 'sound'> {
  if (s.activePresetId && allPresets().some((p) => p.id === s.activePresetId)) return { presetId: s.activePresetId, sound: undefined }
  const sound: SoundSettings = { rate: s.rate, preservesPitch: s.preservesPitch, ...s.fx }
  return { presetId: undefined, sound }
}

// slider drags change the sound many times a second: the bound track is written once it settles
let pendingBind: { id: string; sound: Sound } | null = null
let bindTimer: number | null = null
function flushBinding(): void {
  if (bindTimer) clearTimeout(bindTimer)
  bindTimer = null
  const p = pendingBind
  pendingBind = null
  if (p) useLibrary.getState().updateTrack(p.id, bindingFor(p.sound))
}
function saveBinding(trackId: string, s: Sound): void {
  if (pendingBind && pendingBind.id !== trackId) flushBinding()
  pendingBind = { id: trackId, sound: s }
  if (bindTimer) clearTimeout(bindTimer)
  bindTimer = window.setTimeout(flushBinding, 300)
}
function dropBinding(): void {
  if (bindTimer) clearTimeout(bindTimer)
  bindTimer = null
  pendingBind = null
}
function isBound(trackId: string | null): boolean {
  return !!trackId && (pendingBind?.id === trackId || !!trackSound(useLibrary.getState().tracks[trackId]))
}

let loadToken = 0

/**
 * Where a track's audio comes from: its file, or — for a song from the internet — a stream
 * Velvet relays (found on YouTube / SoundCloud the first time, then remembered for hours).
 */
export async function sourceUrl(track: Track, fresh = false): Promise<string> {
  return (await sourceOf(track, fresh)).url
}

/** Like `sourceUrl`, with the stream id of a song from the internet (for downloading it ahead). */
async function sourceOf(track: Track, fresh = false): Promise<{ url: string; streamId?: string }> {
  if (!track.stream) return { url: streamUrl(track.path) }
  const info = await window.velvet.stream.resolve({
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    page: track.stream.page,
    prefer: track.stream.prefer,
    fresh
  })
  if (track.stream.page !== info.page) useLibrary.getState().updateTrack(track.id, { stream: { ...track.stream, page: info.page } })
  return { url: remoteStreamUrl(info.id), streamId: info.id }
}
const SESSION_KEY = 'velvet.session'

export const usePlayer = create<PlayerState>((set, get) => {
  const sound = (): Sound => {
    const { rate, preservesPitch, fx, activePresetId } = get()
    return { rate, preservesPitch, fx, activePresetId }
  }

  /** A track's own preset or sound; after such a track, the user's own sound comes back. */
  function applyTrackSound(track: Track): void {
    const bound = trackSound(track)
    if (bound) {
      if (!get().restoreSound) set({ restoreSound: sound() })
      applySound(bound)
      set(bound)
    } else if (get().restoreSound) {
      const s = get().restoreSound!
      set({ ...s, restoreSound: null })
      applySound(s)
    }
  }

  /**
   * A change made in the speed panel. While the current track has a binding the change is
   * saved to it (the user's own sound still returns after the track); otherwise it becomes
   * the user's sound for every track.
   */
  function commitSound(next: Sound): void {
    const id = get().currentId
    if (id && isBound(id)) {
      saveBinding(id, next)
      set(next)
    } else set({ ...next, restoreSound: null })
  }

  async function load(index: number, autoplay: boolean, overlap = 0): Promise<void> {
    const { queue } = get()
    const id = queue[index]
    const track = id ? useLibrary.getState().tracks[id] : undefined
    if (!track) return
    const token = ++loadToken

    flushBinding()
    applyTrackSound(track)
    set({ index, currentId: id, position: 0, duration: track.duration || 0, resolving: !!track.stream })
    let url: string
    try {
      url = await sourceUrl(track)
    } catch (e) {
      if (token !== loadToken) return
      set({ resolving: false, playing: false })
      reportPlayError(id, String(e).includes('no-match') ? i18n.t('search.noMatch') : String(e))
      // a radio keeps going with the next song (not "next": with repeat-one it would retry this one)
      if (autoplay && get().index + 1 < get().queue.length) void get().jumpTo(get().index + 1)
      return
    }
    if (token !== loadToken) return
    set({ resolving: false })
    if (overlap > 0 && !engine.paused) {
      try {
        await engine.crossfadeTo(url, overlap)
      } catch {
        // fall back to a normal switch below
        if (token === loadToken) await engine.load(url)
        else return
      }
      return
    }
    await engine.load(url)
    if (token !== loadToken) return
    if (autoplay) {
      try {
        await engine.play()
      } catch (e) {
        // a newer load interrupting this one is normal; anything else is worth telling
        // (a media error is reported by its own event, which says more)
        if (token === loadToken && e instanceof Error && e.name !== 'AbortError' && !engine.audio.error) reportPlayError(id, e.message || e.name)
      }
    }
  }

  return {
    queue: [],
    original: [],
    index: -1,
    currentId: null,
    playing: false,
    position: 0,
    duration: 0,
    volume: 1,
    muted: false,
    shuffle: false,
    repeat: 'off',
    rate: 1,
    preservesPitch: true,
    fx: { reverb: 0, bass: 0, mid: 0, treble: 0 },
    activePresetId: 'normal',
    restoreSound: null,
    resolving: false,
    lastSkip: null,

    init: (p) => {
      const s: Sound = {
        rate: clamp(p.rate, RATE_MIN, RATE_MAX),
        preservesPitch: p.preservesPitch,
        fx: { reverb: p.reverb, bass: p.bass, mid: p.mid, treble: p.treble },
        activePresetId: p.activePresetId
      }
      set({ ...s, volume: clamp(p.volume, 0, VOLUME_MAX), shuffle: p.shuffle, repeat: p.repeat })
      applySound(s)
      engine.setVolume(clamp(p.volume, 0, VOLUME_MAX))
      if (p.simpleAudio) void engine.setOutput('direct', 'setting')
    },

    restore: async () => {
      let saved: { queue?: string[]; index?: number; position?: number } | null = null
      try {
        saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null')
      } catch {
        saved = null
      }
      if (!saved?.queue?.length || get().currentId) return
      const tracks = useLibrary.getState().tracks
      const id = saved.queue[saved.index ?? 0]
      const queue = saved.queue.filter((q) => tracks[q])
      const index = queue.indexOf(id)
      if (index < 0) return
      const position = Math.max(0, saved.position ?? 0)
      applyTrackSound(tracks[id])
      set({ queue, original: queue, index, currentId: id, duration: tracks[id].duration, position })
      await engine.load(streamUrl(tracks[id].path), position)
    },

    playQueue: async (ids, startIndex = 0) => {
      if (!ids.length) return
      let queue = [...ids]
      let index = clamp(startIndex, 0, ids.length - 1)
      if (get().shuffle) {
        const first = queue[index]
        queue = [first, ...shuffleArray(queue.filter((_, i) => i !== index))]
        index = 0
      }
      set({ queue, original: [...ids] })
      await load(index, true)
    },

    jumpTo: async (index) => {
      if (index < 0 || index >= get().queue.length) return
      await load(index, true)
    },

    toggle: async () => (get().playing ? get().pause() : get().play()),

    play: async () => {
      if (get().index < 0) {
        const order = useLibrary.getState().order
        if (order.length) await get().playQueue(order, 0)
        return
      }
      if (!engine.audio.src) await load(get().index, false)
      try {
        await engine.play()
      } catch {
        // ignore
      }
    },

    pause: () => engine.pause(),

    next: async (auto = false) => {
      const { index, queue, repeat, currentId } = get()
      if (!queue.length) return
      if (!auto && currentId) set({ lastSkip: { id: currentId, position: engine.currentTime, at: Date.now() } })
      if (auto && repeat === 'one') {
        engine.seek(0)
        await engine.play()
        return
      }
      if (index + 1 < queue.length) return load(index + 1, true)
      if (repeat === 'all' || !auto) return load(0, auto ? true : get().playing || auto)
      // end of queue
      engine.pause()
      engine.seek(0)
      set({ playing: false, position: 0 })
    },

    prev: async () => {
      const { index } = get()
      if (engine.currentTime > 3 || index <= 0) {
        engine.seek(0)
        return
      }
      await load(index - 1, true)
    },

    seek: (sec) => {
      engine.seek(sec)
      set({ position: engine.currentTime })
    },

    setVolume: (v) => {
      const volume = clamp(Math.round(v * 100) / 100, 0, VOLUME_MAX)
      engine.setVolume(volume)
      set({ volume, muted: false })
    },

    toggleMute: () => {
      const muted = !get().muted
      engine.setVolume(muted ? 0 : get().volume)
      set({ muted })
    },

    setRate: (r) => {
      const rate = clamp(Math.round(r * 100) / 100, RATE_MIN, RATE_MAX)
      engine.setRate(rate)
      const next = { ...sound(), rate }
      commitSound({ ...next, activePresetId: detectPreset(next) })
    },

    setPreservesPitch: (on) => {
      engine.setPreservesPitch(on)
      const next = { ...sound(), preservesPitch: on }
      commitSound({ ...next, activePresetId: detectPreset(next) })
    },

    setFx: (patch) => {
      const fx = { ...get().fx, ...patch }
      engine.setFx(fx)
      const next = { ...sound(), fx }
      commitSound({ ...next, activePresetId: detectPreset(next) })
    },

    applyPreset: (p, fromTrack = false) => {
      const s = presetSound(p)
      applySound(s)
      if (fromTrack) set(s)
      else commitSound(s)
    },

    bindCurrent: (on) => {
      const id = get().currentId
      if (!id) return
      dropBinding()
      useLibrary.getState().updateTrack(id, on ? bindingFor(sound()) : { presetId: undefined, sound: undefined })
    },

    setShuffle: (on) => {
      const { queue, original, index, currentId } = get()
      if (on) {
        const rest = queue.filter((_, i) => i !== index)
        const next = currentId ? [currentId, ...shuffleArray(rest)] : shuffleArray(queue)
        set({ shuffle: true, original: [...queue], queue: next, index: currentId ? 0 : index })
      } else {
        const base = original.length ? original : queue
        set({ shuffle: false, queue: base, index: currentId ? Math.max(0, base.indexOf(currentId)) : index })
      }
    },

    cycleRepeat: () => {
      const order: RepeatMode[] = ['off', 'all', 'one']
      set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] })
    },

    enqueue: (ids) => {
      if (get().index < 0) return void get().playQueue(ids, 0)
      set({ queue: [...get().queue, ...ids], original: [...get().original, ...ids] })
    },

    playNext: (ids) => {
      if (get().index < 0) return void get().playQueue(ids, 0)
      const q = [...get().queue]
      q.splice(get().index + 1, 0, ...ids)
      set({ queue: q, original: [...get().original, ...ids] })
    },

    removeFromQueue: (i) => {
      const { queue, index } = get()
      if (i === index) return
      set({ queue: queue.filter((_, k) => k !== i), index: i < index ? index - 1 : index })
    },

    transitionTo: async (index, seconds) => {
      if (index < 0 || index >= get().queue.length) return
      await load(index, true, seconds)
    },

    stop: () => {
      engine.unload()
      set({ queue: [], original: [], index: -1, currentId: null, playing: false, position: 0, duration: 0 })
    }
  }
})

// Keep store state in sync with the audio element.
engine.on('play', () => usePlayer.setState({ playing: true }))
engine.on('playing', () => usePlayer.setState({ playing: true }))
engine.on('pause', () => usePlayer.setState({ playing: false }))
engine.on('timeupdate', () => usePlayer.setState({ position: engine.currentTime }))
engine.on('durationchange', () => {
  const duration = engine.duration
  usePlayer.setState({ duration })
  const id = usePlayer.getState().currentId
  const t = id ? useLibrary.getState().tracks[id] : undefined
  if (t && duration && Math.abs((t.duration || 0) - duration) > 1) useLibrary.getState().updateTrack(t.id, { duration })
})
engine.on('ended', () => void usePlayer.getState().next(true))

/** Index the queue moves to when the current track finishes on its own (-1 = stop). */
export function autoNextIndex(s: Pick<PlayerState, 'index' | 'queue' | 'repeat'>): number {
  if (s.repeat === 'one' || s.index < 0) return -1
  if (s.index + 1 < s.queue.length) return s.index + 1
  return s.repeat === 'all' && s.queue.length ? 0 : -1
}

// Crossfade / gapless: instead of polling, sleep until the exact moment the next stage begins
// (preload, then start) and re-plan whenever position, speed, queue or settings change.
let transitioning = false
let transitionTimer: number | null = null
function planNext(): void {
  if (transitionTimer) {
    clearTimeout(transitionTimer)
    transitionTimer = null
  }
  const st = usePlayer.getState()
  if (!st.playing || transitioning || engine.paused) return
  const { crossfade, gapless } = useSettings.getState().settings.playback
  if (!crossfade && !gapless) return
  const next = autoNextIndex(st)
  const track = next >= 0 ? useLibrary.getState().tracks[st.queue[next]] : undefined
  if (!track) return
  const opts = { remaining: engine.remaining, length: engine.duration / (st.rate || 1), crossfade, gapless }
  const plan = planTransition(opts)
  if (plan.action === 'start') {
    transitioning = true
    void st.transitionTo(next, plan.seconds).finally(() => {
      transitioning = false
      planNext()
    })
    return
  }
  if (plan.action === 'preload') {
    if (track.stream) void sourceUrl(track).catch(() => {})
    else engine.preload(streamUrl(track.path))
  }
  const wait = secondsUntilNextStage(opts)
  if (Number.isFinite(wait)) transitionTimer = window.setTimeout(planNext, Math.max(10, wait * 1000))
}
for (const ev of ['playing', 'pause', 'seeked', 'durationchange', 'ended']) engine.on(ev, planNext)
usePlayer.subscribe((s, prev) => {
  if (s.rate !== prev.rate || s.queue !== prev.queue || s.index !== prev.index || s.repeat !== prev.repeat || s.playing !== prev.playing) planNext()
})
useSettings.subscribe((s, prev) => {
  if (s.settings.playback.crossfade !== prev.settings.playback.crossfade || s.settings.playback.gapless !== prev.settings.playback.gapless) planNext()
})

// ── the next track is made ready while the current one plays ────────────────────
// A few seconds into a track the next one is prepared: a song from the internet is looked up and
// downloaded into a temporary file, and whatever comes next is buffered on the standby deck, so
// the change of tracks has no pause (with or without crossfade). The song after it is looked up too.
let prepareTimer: number | null = null
let prepareSeq = 0

function nextIndexFor(s: Pick<PlayerState, 'index' | 'queue' | 'repeat'>): number {
  if (s.index < 0) return -1
  if (s.index + 1 < s.queue.length) return s.index + 1
  return s.repeat === 'all' && s.queue.length > 1 ? 0 : -1
}

async function prepareNext(): Promise<void> {
  const seq = ++prepareSeq
  const st = usePlayer.getState()
  const next = nextIndexFor(st)
  if (next < 0 || st.repeat === 'one') return
  const tracks = useLibrary.getState().tracks
  const track = tracks[st.queue[next]]
  if (!track) return
  const t0 = performance.now()
  try {
    const src = await sourceOf(track)
    if (src.streamId) await window.velvet.stream.prefetch(src.streamId)
    const now = usePlayer.getState()
    // still the next track, and no transition is using the standby deck
    if (seq === prepareSeq && now.queue[nextIndexFor(now)] === track.id && !transitioning) {
      engine.preload(src.url)
      if (track.stream) logUi('info', `next song ready in ${Math.round(performance.now() - t0)} ms`)
    }
  } catch {
    // it will be looked up again when its turn comes
  }
  // …and the song after it only needs its link
  const after = tracks[st.queue[next + 1]]
  if (after?.stream && seq === prepareSeq) void sourceOf(after).catch(() => {})
}

function schedulePrepare(): void {
  if (prepareTimer) clearTimeout(prepareTimer)
  prepareTimer = window.setTimeout(() => {
    prepareTimer = null
    if (usePlayer.getState().playing) void prepareNext()
  }, 3000)
}
engine.on('playing', schedulePrepare)
usePlayer.subscribe((s, prev) => {
  if (s.currentId !== prev.currentId || s.queue !== prev.queue || s.repeat !== prev.repeat) schedulePrepare()
})

let errorStreak = 0
/** tracks already retried over the other transport this session */
const altTried = new Set<string>()
engine.on('playing', () => (errorStreak = 0))
engine.on('error', () => {
  const { queue, currentId, position } = usePlayer.getState()
  if (!engine.audio.getAttribute('src')) return
  const err = engine.audio.error
  const track = currentId ? useLibrary.getState().tracks[currentId] : undefined
  const ext = track?.path.split('.').pop()?.toLowerCase() ?? '?'
  engine.lastProblem = `media error ${err?.code ?? '?'} ${err?.message ?? ''}`.trim()
  logUi('warn', `${engine.lastProblem} (.${ext}, ${track?.stream ? 'internet' : currentTransport()})`)
  // a song from the internet: its link may have expired — look it up once more
  if (track?.stream && !altTried.has(track.id)) {
    altTried.add(track.id)
    void (async () => {
      try {
        // a new direct link for the same page (the old one expired or was refused)
        await engine.load(await sourceUrl(track, true), position)
        await engine.play()
      } catch {
        // the error event of the second attempt reports it
      }
    })()
    return
  }
  // the same file over the other transport (Windows: loopback server ↔ velvet protocol)
  const alt = track && !track.stream ? altStreamUrl(track.path) : null
  if (track && alt && !altTried.has(track.id)) {
    altTried.add(track.id)
    void (async () => {
      try {
        await engine.load(alt, position)
        await engine.play()
        switchTransport()
      } catch {
        // the error event of the second attempt reports it
      }
    })()
    return
  }
  usePlayer.setState({ playing: false })
  if (errorStreak === 0 && currentId) reportPlayError(currentId, err ? i18n.t(`player.mediaErrors.${err.code}`, { defaultValue: err.message || String(err.code) }) : '')
  // skip unplayable files, but don't loop forever over a broken queue
  if (++errorStreak < Math.min(queue.length, 5)) void usePlayer.getState().next(true)
})

let lastReport = { id: '', at: 0 }

// playback moved to the plain element by itself: say so (effects and >100% are off there)
engine.on('mode', () => {
  if (engine.mode === 'direct' && engine.modeReason !== 'setting') useUi.getState().toast(i18n.t('player.simpleAudioAuto'), 'info')
})

/** Says why a track didn't start instead of pretending it plays (once per track and failure). */
function reportPlayError(trackId: string, reason: string): void {
  const now = Date.now()
  if (lastReport.id === trackId && now - lastReport.at < 3000) return
  lastReport = { id: trackId, at: now }
  const title = useLibrary.getState().tracks[trackId]?.title ?? ''
  useUi.getState().toast(i18n.t('player.playError', { title, reason: reason.slice(0, 160) }), 'error')
}

// Persist volume / speed / effects between sessions.
let persistTimer: number | null = null
usePlayer.subscribe((s, prev) => {
  if (
    s.volume === prev.volume &&
    s.rate === prev.rate &&
    s.preservesPitch === prev.preservesPitch &&
    s.fx === prev.fx &&
    s.shuffle === prev.shuffle &&
    s.repeat === prev.repeat &&
    s.activePresetId === prev.activePresetId
  )
    return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    // while a per-track preset is active, persist the user's own sound instead
    const st = usePlayer.getState()
    const base = st.restoreSound ?? st
    useSettings.getState().setSection('playback', {
      volume: st.volume,
      rate: base.rate,
      preservesPitch: base.preservesPitch,
      reverb: base.fx.reverb,
      bass: base.fx.bass,
      mid: base.fx.mid,
      treble: base.fx.treble,
      activePresetId: base.activePresetId,
      shuffle: st.shuffle,
      repeat: st.repeat
    })
  }, 300)
})

// Remember the queue and position so the next launch continues where you left off.
function saveSession(): void {
  const { queue, index } = usePlayer.getState()
  try {
    if (index < 0) localStorage.removeItem(SESSION_KEY)
    else localStorage.setItem(SESSION_KEY, JSON.stringify({ queue: queue.slice(0, 5000), index, position: engine.currentTime }))
  } catch {
    // storage unavailable: resuming is a convenience only
  }
}
usePlayer.subscribe((s, prev) => {
  if (s.queue !== prev.queue || s.index !== prev.index || s.playing !== prev.playing) saveSession()
})
window.setInterval(() => {
  if (usePlayer.getState().playing) saveSession()
}, 5000)
window.addEventListener('velvet:flush', saveSession)
// capture: runs before the library's own flush listener, so a binding still pending is saved with it
window.addEventListener('velvet:flush', flushBinding, { capture: true })
