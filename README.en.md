<p align="center">
  🇷🇺 <a href="README.md">Русский</a> &nbsp;|&nbsp; 🇬🇧 <b>English</b>
</p>

# Velvet — music player

A desktop player built with **Rust (Tauri 2) + React + TypeScript**: speed up to 3x, slowed / nightcore / reverb presets,
volume up to 200% without distortion, Spotify-style Discord activity, playlists, a tag editor and import
by link from SoundCloud and Spotify.

Version 2 has been rewritten from Electron to Rust: instead of a bundled Chromium and Node.js, the window is drawn by the system WebView2
(already included in Windows 10/11), and all work with files, tags, Discord, import and export is done in Rust.
The installer is about 10 MB instead of ~100 MB, and when paused or minimized Velvet uses almost no CPU.

## Building on Windows

Install once:

1. **Rust** — <https://rustup.rs> (rustup-init.exe, all defaults).
2. **Microsoft C++ Build Tools** — <https://visualstudio.microsoft.com/visual-cpp-build-tools/>,
   in the installer select *Desktop development with C++*.
3. **Node.js 20+** — <https://nodejs.org>.

WebView2 is already installed on Windows 10/11; if it's missing, the Velvet installer downloads it automatically.

Then, in the project folder:

```bash
npm install
npm run dev        # development mode (window with hot reload of the UI)
npm run dist:win   # installer: src-tauri/target/release/bundle/nsis/Velvet_2.0.0_x64-setup.exe
```

The first Rust build takes 5–10 minutes; later ones are faster. Checks: `npm run typecheck`, `npm test`
(UI), `cargo test` and `cargo clippy` in the `src-tauri` folder (backend).

### Common errors

- `npm error Unsupported URL Type "dist:": dist:win` — you typed `npm install dist:win` instead of `npm run dist:win`.
- `linker 'link.exe' not found` / `error: Microsoft C++ build tools` — C++ Build Tools are not installed (step 2).
- `cargo: command not found` — open a new terminal window after installing Rust.

### Upgrading from the Electron version

Nothing to migrate: Velvet 2 uses the same data folder `%APPDATA%\Velvet` — library,
playlists, favourites, stats, settings, covers, lyrics cache and yt-dlp are picked up as is.
You can uninstall the old version via Windows "Apps" (your data is not deleted).

### ffmpeg

ffmpeg is no longer bundled with the installer: it's only needed for import (transcoding to MP3/M4A) and for exporting
slowed versions, so Velvet downloads it the first time it's needed (BtbN build with rubberband, ~140 MB,
verified with SHA-256) to `%APPDATA%\Velvet\bin`. If ffmpeg is already in your `PATH`, that one is used.

## Features

| | |
|---|---|
| **Speed** | 0.25x – 3x, slider, ±0.05x buttons, quick values, hotkeys `[` / `]`. The speed indicator sits in its own "pill" to the left of the progress bar. |
| **Auto pitch** | A toggle in the speed panel and in settings. On — pitch is preserved; off — pitch changes with speed (classic slowed / nightcore). |
| **Effects and presets** | Reverb, bass, mids, treble. Built-in presets: Normal, Slowed, Slowed + Reverb, Nightcore, Sped Up, Bass Boost, Vaporwave, Concert Hall. Custom presets are saved, and a preset can be bound to a track. |
| **Volume** | 0–200%, the percentage is shown next to the slider; the range above 100% is highlighted. Mouse wheel — ±5%, click on the percentage — 100%. |
| **Clean sound** | A custom look-ahead limiter (AudioWorklet) sits after the volume stage: it lowers the gain ahead of peaks, so even 200% + Bass Boost doesn't clip. Track switching and pause use a micro-fade with no clicks. |
| **Tags** | Title, artist, album, cover (file / link / clipboard). Can be written straight into the file (MP3, FLAC, M4A, OGG…). |
| **Playlists** | Create, rename, set a cover, drag tracks onto a playlist and within a playlist. |
| **Import** | SoundCloud (track, set, profile) and YouTube — directly via yt-dlp. Spotify (track, album, playlist) — metadata and covers from Spotify, audio matched on YouTube / SoundCloud. yt-dlp is downloaded automatically. |
| **Design** | Themes **Snow** (snow-white), **Midnight** (dark blue with white), **Glass / Aurora** (glass and cover colours), "System". Accent colour, colour from cover, corner radius, text size, density, background image with blur. |
| **Languages** | Auto-detected from the system language; Русский, English, Українська, Deutsch, Español, Français (Settings → Language). |
| **Crossfade and gapless** | Smooth transition between tracks of 0–12 s and playback without gaps. Off by default (Settings → Playback). |
| **Lyrics** | Smooth "karaoke" lyrics: only the lines around the current one are visible, and the current line fills in as it's sung. Sources — file tags, LRCLIB (with cleanup of titles like "(Official Video)", "slowed", "feat.") or your own LRC in the tag editor. Lyrics without timestamps scroll approximately. Click a line to seek. |
| **Favourites and stats** | ♥ on any track, a "Favourites" section. "Stats": listening time, top tracks/artists/albums for 7/30 days, the year and all time, a daily chart. |
| **Albums and artists** | Library as tracks, an album grid or artists; album and artist pages; sorting; multi-select (Ctrl/Shift-click, Ctrl+A). |
| **Mini player and tray** | A compact always-on-top window, tray icon, minimize to tray, track change notifications, global hotkeys Ctrl+Alt+Space / ←→ / ↑↓. |
| **Export slowed versions** | "Export with effects": saves the track with the current speed, pitch, reverb and EQ to MP3 320 / FLAC / WAV (ffmpeg + rubberband, −0.3 dBFS limiter). |
| **Search** | Search for tracks on SoundCloud and YouTube right in the player, preview and one-click download. |
| **Visualizer** | A dedicated full-window screen (button in the player or the V key). The bottom bar (progress, buttons, volume up to 200%, speed and effects) fades out when the mouse isn't over it. Modes use the cover's colours and a precise spectrum (FFT 8192): "Bars" — up to 128 bars with falling peaks and a reflection, "Wave" — a jitter-free oscilloscope with full detail, "Circle" — 180 mirrored bars, a waveform around the cover and rings on beats, "Particles" — particles from every part of the spectrum and a "living" core. Fullscreen — button in the corner or F; volume and speed at the bottom. |
| **Background** | Live from the cover (pulses to the bass), an image or a video. |
| **Hotkeys** | Customizable: change, add and remove shortcuts — in-app and global (work while Velvet is minimized). Work with any keyboard layout. |
| **Updates** | Checks GitHub for new versions and shows an "Update available" window (see below). |
| **Media keys** | ⏯ ⏭ ⏮ keys on the keyboard and the Windows media overlay (above the volume control) with title and cover. |

## Discord activity

Works out of the box: Velvet has a built-in Discord application "Velvet" (Application ID `1562774102274740256`,
the `DEFAULT_CLIENT_ID` constant in `src-tauri/src/discord/mod.rs`). While Velvet and Discord are running, your profile
shows "Listening to Velvet": cover, title, artist, album and progress bar (speed-aware),
with a ▶ or ⏸ badge in the corner of the cover. When paused — "⏸ Paused" and the time stops; optionally, the activity
can be hidden while paused. The "Display current activity as a status message" option must be enabled in Discord
(Settings → Activity Privacy).

Discord loads the logo (when a track has no cover) and the ▶ / ⏸ badges from links to this repository —
the `assets/discord` folder must be on the `main` branch of the public repository
`Xtop1337/Velvet-music-player`. Track covers: for tracks from SoundCloud/Spotify — the original cover,
for local ones — found via iTunes Search (can be turned off) or a link set in the tag editor.

You only need your own Discord application if you want a name other than "Velvet": create one at
<https://discord.com/developers/applications> and enter its Application ID in
*Settings → Discord → Custom Discord application*. Leave the field empty to go back to Velvet.

## Updates

Velvet checks GitHub releases — <https://github.com/Xtop1337/Velvet-music-player/releases> — at start-up
and every 6 hours (can be turned off or checked manually in "Settings → About"). If a newer version
than the installed one is out, an "Update available" window shows the version number and what's new; the "Update" button
opens the release page, where you download the new installer. A reminder stays in the sidebar until you update.

## Spotify with and without keys

Without keys, Velvet reads Spotify's public embed page (up to ~100 tracks of a playlist). For full playlists,
create an app at <https://developer.spotify.com/dashboard> and paste the Client ID / Secret into
*Settings → Import*. Only download what you have the rights to.

## Project structure

```
src-tauri/                Rust backend (Tauri 2)
  src/lib.rs              window, plugins, close to tray, save before exit
  src/commands.rs         commands called by the UI (window.velvet)
  src/protocol.rs         velvet:// protocol for audio, covers and video (Range — seeking works)
  src/library.rs, tags.rs folder scanning and tags (lofty), in parallel (rayon)
  src/discord/            custom Discord RPC client (named pipe) and pause logic
  src/importer.rs, spotify.rs, matcher.rs, search.rs   import by link and search (yt-dlp)
  src/lyrics.rs, exporter.rs, tools.rs                 lyrics (LRCLIB), export (ffmpeg), yt-dlp/ffmpeg download
  src/remote.rs           tray, mini player, global hotkeys, notifications, Windows media keys
  src/updater.rs          checking for new versions on GitHub (Xtop1337/Velvet-music-player)
  tauri.conf.json         window, installer
src/                      UI (React)
  bridge.ts               window.velvet on top of Tauri commands and events
  audio/                  engine: decks A/B (crossfade) → EQ → reverb → volume → fade → limiter (Web Audio)
  store/                  zustand: player, library, settings, imports, ui
  components/, pages/     UI; components/WindowControls.tsx — window buttons
  mini/                   mini player window
  styles/                 themes.css (theme tokens), global.css
  i18n/                   ru, en, uk, de, es, fr
  shared/                 shared types, presets, hotkeys, link parser
tests/                    UI unit tests (vitest); backend tests are in src-tauri (cargo test)
```

Data (library, settings, cover cache, yt-dlp, ffmpeg) is stored in the app folder:
`%APPDATA%\Velvet` (Windows), `~/.config/Velvet` (Linux).
