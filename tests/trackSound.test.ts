import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '@shared/types'

// The player store runs in the browser: give it a window, storage and a silent audio engine.
const { engine } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(e: Event) => void>>()
  const store = new Map<string, string>()
  Object.assign(globalThis, {
    window: globalThis,
    addEventListener: (type: string, cb: (e: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    removeEventListener: (type: string, cb: (e: Event) => void) => listeners.get(type)?.delete(cb),
    dispatchEvent: (e: Event) => {
      listeners.get(e.type)?.forEach((cb) => cb(e))
      return true
    },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    }
  })
  const engine = {
    rate: 1,
    preservesPitch: true,
    fx: { reverb: 0, bass: 0, mid: 0, treble: 0 },
    loaded: '',
    paused: true,
    currentTime: 0,
    duration: 0,
    remaining: 0,
    audio: { src: '', error: null, getAttribute: () => '' },
    on: () => () => {},
    setRate(r: number) {
      this.rate = r
    },
    setPreservesPitch(on: boolean) {
      this.preservesPitch = on
    },
    setFx(fx: Partial<typeof this.fx>) {
      this.fx = { ...this.fx, ...fx }
    },
    setVolume() {},
    async load(url: string) {
      this.loaded = url
    },
    async play() {},
    pause() {},
    seek() {},
    preload() {},
    unload() {},
    async crossfadeTo(url: string) {
      this.loaded = url
    }
  }
  return { engine }
})

vi.mock('../src/audio/engine', () => ({ engine }))
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => `velvet://localhost/${p}`, invoke: async () => null }))

const { usePlayer, trackSound, bindingFor } = await import('../src/store/player')
const { useLibrary } = await import('../src/store/library')

const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id, path: `/music/${id}.mp3`, title: id, artist: 'A', album: '', duration: 200, source: 'local', addedAt: 0, ...extra
})

function setLibrary(...tracks: Track[]): void {
  useLibrary.setState({ tracks: Object.fromEntries(tracks.map((t) => [t.id, t])), order: tracks.map((t) => t.id) })
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 350))

describe('speed bound to a track', () => {
  beforeEach(() => {
    usePlayer.setState({ rate: 1, preservesPitch: true, fx: { reverb: 0, bass: 0, mid: 0, treble: 0 }, activePresetId: 'normal', restoreSound: null, queue: [], index: -1, currentId: null })
    engine.rate = 1
  })

  it('binds a speed set with the slider (no preset) and applies it when the track starts again', async () => {
    setLibrary(track('a'), track('b'))
    const p = usePlayer.getState()
    await p.playQueue(['a', 'b'], 0)
    p.setRate(0.83)
    expect(usePlayer.getState().activePresetId).toBe('')
    usePlayer.getState().bindCurrent(true)
    expect(useLibrary.getState().tracks.a.sound).toMatchObject({ rate: 0.83, preservesPitch: true })
    expect(trackSound(useLibrary.getState().tracks.a)?.rate).toBe(0.83)

    // another track keeps the speed the user had (0.83 when binding); they set 1x there
    await usePlayer.getState().jumpTo(1)
    expect(engine.rate).toBe(0.83)
    usePlayer.getState().setRate(1)
    expect(useLibrary.getState().tracks.b.sound).toBeUndefined()

    // back to the bound track: its speed is applied automatically…
    await usePlayer.getState().jumpTo(0)
    expect(engine.rate).toBe(0.83)
    expect(usePlayer.getState().rate).toBe(0.83)
    // …and leaving it brings back the user's own
    await usePlayer.getState().jumpTo(1)
    expect(engine.rate).toBe(1)
  })

  it('stores a matching preset by id and turns the binding off again', async () => {
    setLibrary(track('a'))
    await usePlayer.getState().playQueue(['a'], 0)
    const slowed = { id: 'slowed', name: 'Slowed', rate: 0.8, preservesPitch: false, reverb: 0, bass: 2, mid: 0, treble: -1 }
    expect(bindingFor({ rate: 0.8, preservesPitch: false, fx: { reverb: 0, bass: 2, mid: 0, treble: -1 }, activePresetId: 'slowed' })).toEqual({ presetId: 'slowed', sound: undefined })
    expect(trackSound({ presetId: undefined, sound: slowed })?.rate).toBe(0.8)
    usePlayer.getState().bindCurrent(true)
    expect(useLibrary.getState().tracks.a.presetId).toBe('normal')
    usePlayer.getState().bindCurrent(false)
    expect(useLibrary.getState().tracks.a).toMatchObject({ presetId: undefined, sound: undefined })
    expect(trackSound(useLibrary.getState().tracks.a)).toBeNull()
  })

  it('saves changes made while a bound track plays to that track, not to every track', async () => {
    setLibrary(track('a', { sound: { rate: 0.9, preservesPitch: true, reverb: 0, bass: 0, mid: 0, treble: 0 } }), track('b'))
    await usePlayer.getState().playQueue(['a', 'b'], 0)
    expect(engine.rate).toBe(0.9)
    usePlayer.getState().setRate(0.7)
    await settle()
    expect(useLibrary.getState().tracks.a.sound?.rate).toBe(0.7)
    await usePlayer.getState().jumpTo(1)
    expect(engine.rate).toBe(1)
  })

  it('applies the binding when the last session is restored at launch', async () => {
    setLibrary(track('a', { sound: { rate: 1.25, preservesPitch: false, reverb: 0.2, bass: 0, mid: 0, treble: 0 } }))
    localStorage.setItem('velvet.session', JSON.stringify({ queue: ['a'], index: 0, position: 12 }))
    await usePlayer.getState().restore()
    expect(engine.rate).toBe(1.25)
    expect(engine.preservesPitch).toBe(false)
    expect(usePlayer.getState().restoreSound?.rate).toBe(1)
  })
})
