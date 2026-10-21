import { create } from 'zustand'
import { BUILTIN_PRESETS, RATE_MAX, RATE_MIN, VOLUME_MAX } from '@shared/defaults'
import type { Preset, RepeatMode, Settings } from '@shared/types'
import { engine, type Fx } from '@renderer/audio/engine'
import { planTransition } from '@renderer/audio/transition'
import { clamp, shuffleArray } from '@renderer/lib/format'
import { mediaUrl } from '@renderer/lib/media'
import { useLibrary } from './library'
import { useSettings } from './settings'

interface Sound {
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

let loadToken = 0
const SESSION_KEY = 'velvet.session'

export const usePlayer = create<PlayerState>((set, get) => {
  const sound = (): Sound => {
    const { rate, preservesPitch, fx, activePresetId } = get()
    return { rate, preservesPitch, fx, activePresetId }
  }

  async function load(index: number, autoplay: boolean, overlap = 0): Promise<void> {
    const { queue } = get()
    const id = queue[index]
    const track = id ? useLibrary.getState().tracks[id] : undefined
    if (!track) return
    const token = ++loadToken

    // per-track preset
    const presetId = track.presetId
    const preset = presetId ? allPresets().find((p) => p.id === presetId) : undefined
    if (preset) {
      if (!get().restoreSound) set({ restoreSound: sound() })
      get().applyPreset(preset, true)
    } else if (get().restoreSound) {
      const s = get().restoreSound!
      set({ ...s, restoreSound: null })
      applySound(s)
    }

    set({ index, currentId: id, position: 0, duration: track.duration || 0 })
    if (overlap > 0 && !engine.paused) {
      try {
        await engine.crossfadeTo(mediaUrl(track.path), overlap)
      } catch {
        // fall back to a normal switch below
        if (token === loadToken) await engine.load(mediaUrl(track.path))
        else return
      }
      return
    }
    await engine.load(mediaUrl(track.path))
    if (token !== loadToken) return
    if (autoplay) {
      try {
        await engine.play()
      } catch {
        // autoplay can be interrupted by a newer load; ignore
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
      set({ queue, original: queue, index, currentId: id, duration: tracks[id].duration, position })
      await engine.load(mediaUrl(tracks[id].path), position)
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
      const { index, queue, repeat } = get()
      if (!queue.length) return
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
      set({ rate, activePresetId: detectPreset({ ...sound(), rate }), restoreSound: null })
    },

    setPreservesPitch: (on) => {
      engine.setPreservesPitch(on)
      set({ preservesPitch: on, activePresetId: detectPreset({ ...sound(), preservesPitch: on }), restoreSound: null })
    },

    setFx: (patch) => {
      const fx = { ...get().fx, ...patch }
      engine.setFx(fx)
      set({ fx, activePresetId: detectPreset({ ...sound(), fx }), restoreSound: null })
    },

    applyPreset: (p, fromTrack = false) => {
      const s: Sound = {
        rate: clamp(p.rate, RATE_MIN, RATE_MAX),
        preservesPitch: p.preservesPitch,
        fx: { reverb: p.reverb, bass: p.bass, mid: p.mid, treble: p.treble },
        activePresetId: p.id
      }
      applySound(s)
      set(fromTrack ? s : { ...s, restoreSound: null })
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

// Crossfade / gapless: watch the end of the track closely and start the next one early.
let transitioning = false
window.setInterval(() => {
  const st = usePlayer.getState()
  if (!st.playing || transitioning || engine.paused) return
  const { crossfade, gapless } = useSettings.getState().settings.playback
  if (!crossfade && !gapless) return
  const next = autoNextIndex(st)
  const track = next >= 0 ? useLibrary.getState().tracks[st.queue[next]] : undefined
  if (!track) return
  const plan = planTransition({ remaining: engine.remaining, length: engine.duration / (st.rate || 1), crossfade, gapless })
  if (plan.action === 'preload') engine.preload(mediaUrl(track.path))
  else if (plan.action === 'start') {
    transitioning = true
    void st.transitionTo(next, plan.seconds).finally(() => (transitioning = false))
  }
}, 30)

let errorStreak = 0
engine.on('playing', () => (errorStreak = 0))
engine.on('error', () => {
  const { queue } = usePlayer.getState()
  usePlayer.setState({ playing: false })
  if (!engine.audio.getAttribute('src')) return
  // skip unplayable files, but don't loop forever over a broken queue
  if (++errorStreak < Math.min(queue.length, 5)) void usePlayer.getState().next(true)
})

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
window.addEventListener('beforeunload', saveSession)
