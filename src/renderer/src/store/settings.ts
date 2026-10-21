import { create } from 'zustand'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'
import type { Settings } from '@shared/types'

type Section = 'discord' | 'importer' | 'playback' | 'exporter' | 'desktop' | 'updates'

interface SettingsState {
  settings: Settings
  loaded: boolean
  load: () => Promise<void>
  set: (patch: Partial<Settings>) => void
  setSection: <K extends Section>(key: K, patch: Partial<Settings[K]>) => void
  reset: () => void
}

let saveTimer: number | null = null

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const stored = await window.velvet.store.load<Partial<Settings>>('settings')
    const settings = mergeSettings(stored)
    if (!settings.importer.downloadDir) {
      settings.importer.downloadDir = (await window.velvet.app.info()).defaultDownloads
    }
    set({ settings, loaded: true })
  },
  set: (patch) => set({ settings: { ...get().settings, ...patch } }),
  setSection: (key, patch) => {
    const s = get().settings
    set({ settings: { ...s, [key]: { ...s[key], ...patch } } })
  },
  reset: () => {
    const s = get().settings
    set({
      settings: {
        ...DEFAULT_SETTINGS,
        language: s.language,
        discord: s.discord,
        importer: s.importer,
        customPresets: s.customPresets
      }
    })
  }
}))

useSettings.subscribe((state, prev) => {
  if (!state.loaded || !prev.loaded || state.settings === prev.settings) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void window.velvet.store.save('settings', useSettings.getState().settings)
  }, 400)
})

window.addEventListener('beforeunload', () => {
  if (saveTimer && useSettings.getState().loaded) window.velvet.store.saveSync('settings', useSettings.getState().settings)
})
