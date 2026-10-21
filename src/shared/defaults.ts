import type { Preset, Settings } from './types'

export const RATE_MIN = 0.25
export const RATE_MAX = 3
export const VOLUME_MAX = 2

export const BUILTIN_PRESETS: Preset[] = [
  { id: 'normal', name: 'Normal', rate: 1, preservesPitch: true, reverb: 0, bass: 0, mid: 0, treble: 0, builtIn: true },
  { id: 'slowed', name: 'Slowed', rate: 0.85, preservesPitch: false, reverb: 0.12, bass: 2, mid: 0, treble: -1, builtIn: true },
  { id: 'slowed-reverb', name: 'Slowed + Reverb', rate: 0.8, preservesPitch: false, reverb: 0.38, bass: 3, mid: 0, treble: -2, builtIn: true },
  { id: 'nightcore', name: 'Nightcore', rate: 1.25, preservesPitch: false, reverb: 0, bass: 0, mid: 0, treble: 1, builtIn: true },
  { id: 'sped-up', name: 'Sped Up', rate: 1.3, preservesPitch: false, reverb: 0.05, bass: 1, mid: 0, treble: 0, builtIn: true },
  { id: 'bass-boost', name: 'Bass Boost', rate: 1, preservesPitch: true, reverb: 0, bass: 8, mid: -1, treble: 1, builtIn: true },
  { id: 'vaporwave', name: 'Vaporwave', rate: 0.7, preservesPitch: false, reverb: 0.5, bass: 2, mid: -2, treble: -5, builtIn: true },
  { id: 'concert', name: 'Concert Hall', rate: 1, preservesPitch: true, reverb: 0.3, bass: 1, mid: 0, treble: 0, builtIn: true }
]

export const DEFAULT_SETTINGS: Settings = {
  language: 'ru',
  theme: 'snow',
  accent: '',
  accentFromCover: false,
  radius: 14,
  fontScale: 1,
  density: 'comfortable',
  backgroundMode: 'none',
  backgroundImage: '',
  backgroundVideo: '',
  backgroundBlur: 24,
  backgroundDim: 0.35,
  liveIntensity: 0.7,
  liveReactive: true,
  visualizer: 'bars',
  animations: true,
  discord: {
    enabled: true,
    clientId: '',
    showSpeed: true,
    showButtons: true,
    lookupCovers: true
  },
  importer: {
    downloadDir: '',
    format: 'mp3',
    spotifyClientId: '',
    spotifyClientSecret: '',
    createPlaylist: true
  },
  playback: {
    volume: 1,
    rate: 1,
    preservesPitch: true,
    reverb: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    activePresetId: 'normal',
    shuffle: false,
    repeat: 'off',
    crossfade: 0,
    gapless: false
  },
  customPresets: [],
  exporter: { format: 'mp3', dir: '', addToLibrary: true },
  desktop: { closeToTray: false, globalShortcuts: true, notifications: false, miniOnTop: true },
  updates: { auto: true }
}

/** Deep-merges stored settings over defaults so new fields get sane values. */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const s = stored ?? {}
  // older settings only had an image path
  const backgroundMode = s.backgroundMode ?? (s.backgroundImage ? 'image' : 'none')
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    backgroundMode,
    discord: { ...DEFAULT_SETTINGS.discord, ...(s.discord ?? {}) },
    importer: { ...DEFAULT_SETTINGS.importer, ...(s.importer ?? {}) },
    playback: { ...DEFAULT_SETTINGS.playback, ...(s.playback ?? {}) },
    customPresets: Array.isArray(s.customPresets) ? s.customPresets : [],
    exporter: { ...DEFAULT_SETTINGS.exporter, ...(s.exporter ?? {}) },
    desktop: { ...DEFAULT_SETTINGS.desktop, ...(s.desktop ?? {}) },
    updates: { ...DEFAULT_SETTINGS.updates, ...(s.updates ?? {}) }
  }
}

export const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'webm', 'aiff', 'aif', 'wma', 'alac']
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v']
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']
