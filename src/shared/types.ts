export type TrackSource = 'local' | 'soundcloud' | 'spotify' | 'youtube'

export interface Track {
  id: string
  path: string
  title: string
  artist: string
  album: string
  duration: number
  /** Cover image cached on disk (shown in the app). */
  coverPath?: string
  /** Public cover URL (used by Discord, which can't read local files). */
  coverUrl?: string
  /** True when coverUrl was looked up automatically and may be replaced. */
  coverUrlAuto?: boolean
  source: TrackSource
  sourceUrl?: string
  addedAt: number
  /** Preset applied automatically when this track starts. */
  presetId?: string
  /** Position on the album, from the tags. */
  trackNo?: number
  year?: number
  liked?: boolean
  /** When the track was liked (for sorting the favourites). */
  likedAt?: number
  playCount?: number
  lastPlayed?: number
  /** Lyrics typed or pasted by the user (plain text or LRC). */
  lyrics?: string
}

export interface HistoryEntry {
  /** track id */
  t: string
  /** finished listening at (ms) */
  at: number
  /** seconds actually listened */
  s: number
}

export interface Playlist {
  id: string
  name: string
  trackIds: string[]
  coverPath?: string
  createdAt: number
}

export interface LibraryData {
  version: 1
  tracks: Track[]
  playlists: Playlist[]
}

export interface Preset {
  id: string
  name: string
  /** 0.25 .. 3 */
  rate: number
  /** "Auto tonality": keep the original pitch while changing speed. */
  preservesPitch: boolean
  /** Reverb wet level 0 .. 1 */
  reverb: number
  /** EQ gains in dB, -12 .. 12 */
  bass: number
  mid: number
  treble: number
  builtIn?: boolean
}

export type VisualizerMode = 'bars' | 'wave' | 'circle' | 'particles'
export type BackgroundMode = 'none' | 'image' | 'cover' | 'video'

export type ThemeId = 'snow' | 'midnight' | 'aurora' | 'system'
export type Language = 'ru' | 'en'
export type RepeatMode = 'off' | 'all' | 'one'
export type ImportFormat = 'mp3' | 'm4a' | 'best'

export interface Settings {
  language: Language
  theme: ThemeId
  /** Empty string means "use the theme's own accent". */
  accent: string
  accentFromCover: boolean
  radius: number
  fontScale: number
  density: 'compact' | 'comfortable'
  backgroundMode: BackgroundMode
  backgroundImage: string
  backgroundVideo: string
  backgroundBlur: number
  backgroundDim: number
  /** Live cover background: how strong the motion/colour is, 0..1 */
  liveIntensity: number
  /** Live background pulses with the bass */
  liveReactive: boolean
  visualizer: VisualizerMode
  animations: boolean
  discord: {
    enabled: boolean
    clientId: string
    showSpeed: boolean
    showButtons: boolean
    lookupCovers: boolean
  }
  importer: {
    downloadDir: string
    format: ImportFormat
    spotifyClientId: string
    spotifyClientSecret: string
    createPlaylist: boolean
  }
  playback: {
    volume: number
    rate: number
    preservesPitch: boolean
    reverb: number
    bass: number
    mid: number
    treble: number
    activePresetId: string
    shuffle: boolean
    repeat: RepeatMode
    /** Seconds of overlap between tracks, 0 = off. */
    crossfade: number
    /** Start the next track exactly when the current one ends. */
    gapless: boolean
  }
  customPresets: Preset[]
  updates: {
    auto: boolean
  }
  desktop: {
    closeToTray: boolean
    globalShortcuts: boolean
    notifications: boolean
    miniOnTop: boolean
  }
  exporter: {
    format: 'mp3' | 'wav' | 'flac'
    /** empty = <download folder>/Exports */
    dir: string
    addToLibrary: boolean
  }
}

export interface NowPlayingPayload {
  title: string
  artist: string
  album: string
  coverUrl?: string
  sourceUrl?: string
  duration: number
  position: number
  rate: number
  playing: boolean
  /** Needed for automatic cover lookup. */
  trackId: string
  language: Language
}

export type DiscordStatus = 'disabled' | 'connecting' | 'connected' | 'error' | 'no-client-id'

export interface ImportOptions {
  url: string
  downloadDir: string
  format: ImportFormat
  spotifyClientId?: string
  spotifyClientSecret?: string
}

export type ImportJobState = 'resolving' | 'downloading' | 'done' | 'error' | 'cancelled'

export interface ImportProgress {
  jobId: string
  url: string
  state: ImportJobState
  /** Name of the release (album / playlist / track) once resolved. */
  title?: string
  kind?: 'track' | 'album' | 'playlist'
  total: number
  completed: number
  failed: number
  /** Current item being downloaded. */
  current?: string
  /** 0..1 progress of the current item. */
  percent: number
  error?: string
  /** Track ids created by this job, in order. */
  trackIds: string[]
}

export interface LyricsQuery {
  trackId: string
  path: string
  title: string
  artist: string
  album: string
  duration: number
  force?: boolean
}

export interface LyricsResult {
  synced?: string
  plain?: string
  instrumental?: boolean
  source: 'tags' | 'lrclib' | 'user' | 'none'
  error?: string
}

export interface ExportOptions {
  id: string
  path: string
  title: string
  artist: string
  album: string
  coverPath?: string
  /** Suffix added to the title, e.g. "Slowed + Reverb" or "0.8x". */
  label: string
  rate: number
  preservesPitch: boolean
  reverb: number
  bass: number
  mid: number
  treble: number
  format: 'mp3' | 'wav' | 'flac'
  outDir: string
}

export interface ExportProgress {
  id: string
  state: 'running' | 'done' | 'error'
  percent: number
  file?: string
  error?: string
  track?: Track
}

export type SearchSource = 'soundcloud' | 'youtube'

export interface SearchResult {
  id: string
  title: string
  artist: string
  duration: number
  url: string
  thumbnail?: string
  source: SearchSource
}

/** Compact player state shared with the mini player and tray. */
export interface RemoteState {
  trackId: string | null
  title: string
  artist: string
  album: string
  coverPath?: string
  playing: boolean
  position: number
  duration: number
  rate: number
  liked: boolean
  theme: 'snow' | 'midnight' | 'aurora'
  accent: string
  onAccent: string
  language: Language
}

export type PlayerCommand =
  | { cmd: 'toggle' | 'next' | 'prev' | 'like' | 'show' | 'mini' }
  | { cmd: 'seek'; value: number }
  | { cmd: 'volume'; value: number }

export interface AppPrefs {
  closeToTray: boolean
  globalShortcuts: boolean
  notifications: boolean
  miniOnTop: boolean
  language: Language
}

export interface UpdateStatus {
  state: 'dev' | 'unconfigured' | 'idle' | 'checking' | 'downloading' | 'ready' | 'none' | 'error'
  version?: string
  percent?: number
  error?: string
  checkedAt?: number
}

export interface YtDlpStatus {
  installed: boolean
  version?: string
  path?: string
  source?: 'bundled' | 'system' | 'downloaded'
}
