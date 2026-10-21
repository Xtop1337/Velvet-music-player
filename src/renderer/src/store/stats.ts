import { create } from 'zustand'
import type { HistoryEntry } from '@shared/types'
import { engine } from '@renderer/audio/engine'
import { countsAsPlay } from '@renderer/lib/stats'
import { useLibrary } from './library'
import { usePlayer } from './player'

const MAX_ENTRIES = 50_000

interface StatsState {
  history: HistoryEntry[]
  loaded: boolean
  load: () => Promise<void>
  clear: () => void
}

let saveTimer: number | null = null

export const useStats = create<StatsState>((set) => ({
  history: [],
  loaded: false,
  load: async () => {
    const data = await window.velvet.store.load<HistoryEntry[]>('history')
    set({ history: Array.isArray(data) ? data : [], loaded: true })
  },
  clear: () => set({ history: [] })
}))

useStats.subscribe((s, prev) => {
  if (!s.loaded || !prev.loaded || s.history === prev.history) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void window.velvet.store.save('history', useStats.getState().history)
  }, 1500)
})

// Count real listening time of the current track (wall-clock, so speed changes don't skew it).
let current: string | null = null
let listened = 0
let lastTick = performance.now()

function finish(): void {
  if (!current) return
  const id = current
  const t = useLibrary.getState().tracks[id]
  const s = Math.round(listened)
  current = null
  listened = 0
  if (!t || !countsAsPlay(s, t.duration / (usePlayer.getState().rate || 1))) return
  const st = useStats.getState()
  const history = st.history.length >= MAX_ENTRIES ? st.history.slice(-MAX_ENTRIES + 1) : st.history
  useStats.setState({ history: [...history, { t: id, at: Date.now(), s }] })
  useLibrary.getState().updateTrack(id, { playCount: (t.playCount ?? 0) + 1, lastPlayed: Date.now() })
}

window.setInterval(() => {
  const now = performance.now()
  const dt = (now - lastTick) / 1000
  lastTick = now
  const p = usePlayer.getState()
  if (p.currentId !== current) {
    finish()
    current = p.currentId
  }
  if (p.playing && !engine.paused && dt < 5) listened += dt
}, 1000)

engine.on('ended', finish)
window.addEventListener('beforeunload', () => {
  finish()
  if (saveTimer && useStats.getState().loaded) window.velvet.store.saveSync('history', useStats.getState().history)
})
