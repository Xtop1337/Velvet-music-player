import type { GlobalAction, HotkeyMap, LocalAction } from './hotkeys'

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
  /** Own speed and effects applied when this track starts (when it has no preset). */
  sound?: SoundSettings
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
  /** Genre from the tags, the user, or an online lookup. */
  genre?: string
  /** Tempo, beats per minute (tags or analysis). */
  bpm?: number
  /** Musical key, e.g. "A minor". */
  key?: string
  /** The key in Camelot notation ("8A"), for sorting and harmonic mixing. */
  camelot?: string
  /** Loudness / intensity 0..1 (analysis). */
  energy?: number
  /** When the audio analysis ran (also set when it could not read the file). */
  analyzedAt?: number
  /** When the online genre / year lookup ran. */
  lookedUpAt?: number
  /** When the song's own page (SoundCloud) was asked for its genre. */
  pageGenreAt?: number
  /** Manual shift of the lyrics, seconds (+ = later). */
  lyricsOffset?: number
  /** Stretch the lyrics to this file's length (on / off by hand; default: for slowed / sped-up titles). */
  lyricsStretch?: boolean
  /** The user's own note. */
  note?: string
  /** Set for a track played from the internet (radio, daily mixes): not a file, not saved. */
  stream?: StreamInfo
}

/** What the audio analysis found for a track (see `analysis.rs`). */
export interface AnalysisResult {
  id: string
  bpm?: number
  key?: string
  camelot?: string
  energy?: number
  genre?: string
  year?: number
}

/** Where a track from the internet comes from (see `stream.rs`). */
export interface StreamInfo {
  /** a YouTube / SoundCloud page, when known */
  page?: string
  /** a page to open / download from (Deezer, Spotify, …) */
  link?: string
  /** 30-second preview (Deezer) */
  preview?: string
  /** which service to look for the full audio on first */
  prefer?: 'youtube' | 'soundcloud'
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
  note?: string
}

export type SmartField =
  | 'plays'
  | 'playsRecent'
  | 'liked'
  | 'addedDays'
  | 'notPlayedDays'
  | 'genre'
  | 'artist'
  | 'album'
  | 'title'
  | 'year'
  | 'bpm'
  | 'key'
  | 'mode'
  | 'duration'
  | 'source'
  | 'hasNote'

export type SmartOp = 'gte' | 'lte' | 'eq' | 'neq' | 'contains' | 'notContains' | 'is' | 'isNot'

export interface SmartRule {
  field: SmartField
  op: SmartOp
  /** number, text, or "true"/"false" (kept as text so the editor can hold half-typed values) */
  value: string
}

/** A playlist that fills itself from rules ("played often but not liked", "added this week"…). */
export interface SmartPlaylist {
  id: string
  name: string
  rules: SmartRule[]
  match: 'all' | 'any'
  sort: { key: 'added' | 'plays' | 'lastPlayed' | 'title' | 'artist' | 'bpm' | 'random'; desc: boolean }
  /** 0 = no limit */
  limit: number
  createdAt: number
  note?: string
}

export interface LibraryData {
  version: 1
  tracks: Track[]
  smartPlaylists?: SmartPlaylist[]
  playlists: Playlist[]
}

/** Speed and effects without a name: what a track can have bound to it. */
export type SoundSettings = Pick<Preset, 'rate' | 'preservesPitch' | 'reverb' | 'bass' | 'mid' | 'treble'>

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
export type Language = 'ru' | 'en' | 'uk' | 'de' | 'es' | 'fr'
/** 'auto' follows the system language. */
export type LanguageSetting = Language | 'auto'
export type RepeatMode = 'off' | 'all' | 'one'
export type ImportFormat = 'mp3' | 'm4a' | 'best'

export interface Settings {
  language: LanguageSetting
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
    /** Local tracks: upload the track's own cover (public link) when none is found online. */
    uploadCovers: boolean
    /** Remove the activity while paused instead of showing "Paused". */
    hideWhenPaused: boolean
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
    /** Plain playback without Web Audio (no effects / >100%): for systems where the graph is silent. */
    simpleAudio: boolean
  }
  customPresets: Preset[]
  analysis: {
    /** detect BPM, key and energy in the background */
    enabled: boolean
    /** look up genre and year online (Deezer) for tracks without them */
    lookupOnline: boolean
  }
  updates: {
    auto: boolean
  }
  hotkeys: {
    local: HotkeyMap<LocalAction>
    global: HotkeyMap<GlobalAction>
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
  /** The cover on disk, uploaded for Discord when none is found online. */
  coverPath?: string
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
  /** a song known by its metadata (recommendations, radio): audio from YouTube / SoundCloud */
  matched?: MatchMeta
}

export interface MatchMeta {
  title: string
  artist: string
  album: string
  duration: number
  coverUrl?: string
  page?: string
  prefer?: 'youtube' | 'soundcloud'
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
  /** length (s) of the recording the timestamps were made for */
  duration?: number
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

export type SearchSource = 'soundcloud' | 'youtube' | 'spotify'

export interface SearchResult {
  id: string
  title: string
  artist: string
  duration: number
  url: string
  thumbnail?: string
  /** 'radio' for songs picked for the radio */
  source: SearchSource | 'radio'
  /** a 30-second preview that plays at once */
  preview?: string
  album?: string
  /** a larger cover */
  coverBig?: string
  /** the user's artist or song this suggestion comes from */
  because?: string
  /** the genre the service itself gives the song */
  genre?: string
}

export interface FastRecommendRequest {
  source: SearchSource
  artists: { name: string; weight: number }[]
  excludeArtists: string[]
  excludeKeys: string[]
  /** share of new songs by the user's own artists, 0..1 */
  familiar: number
  limit: number
  spotify?: SpotifyKeys | null
}

export interface WaveRequest {
  source: 'soundcloud' | 'youtube'
  seeds: RecommendSeed[]
  excludeKeys: string[]
  excludeArtists: string[]
  /** try the other service for a seed the chosen one doesn't know */
  fallback: boolean
  limit: number
}

export interface RadioRequest {
  artist: string
  title: string
  excludeKeys: string[]
  excludeArtists: string[]
  limit: number
}

/** The user's own Spotify Web API keys (Settings → Import). */
export interface SpotifyKeys {
  clientId: string
  clientSecret: string
}

/** A track from the user's listening that recommendations start from. */
export interface RecommendSeed {
  artist: string
  title: string
  /** where the track came from, when it was imported (lets the service start from it directly) */
  url?: string
}

export interface RecommendRequest {
  source: SearchSource
  seeds: RecommendSeed[]
  spotify?: SpotifyKeys | null
}

/** Compact player state shared with the mini player and tray. */
export interface RemoteState {
  trackId: string | null
  title: string
  artist: string
  album: string
  coverPath?: string
  /** a public cover (songs from the internet) */
  coverUrl?: string
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
  globalHotkeys: HotkeyMap<GlobalAction>
  notifications: boolean
  miniOnTop: boolean
  language: Language
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'none' | 'error'
  /** newer version published on GitHub */
  version?: string
  /** running version */
  current?: string
  /** release page on GitHub */
  url?: string
  /** release notes, shortened */
  notes?: string
  error?: string
  checkedAt?: number
}

export interface YtDlpStatus {
  installed: boolean
  version?: string
  path?: string
  source?: 'bundled' | 'system' | 'downloaded'
}
