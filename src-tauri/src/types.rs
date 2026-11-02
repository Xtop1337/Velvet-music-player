//! Data shapes shared with the UI (`src/shared/types.ts`), serialized in camelCase.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url_auto: Option<bool>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    pub added_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_no: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
}

/// The few strings shown outside the web UI (Discord, tray). The UI sends them in the
/// current language (`src/shared/mainStrings.ts` stays the single source).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MainStrings {
    pub unknown_artist: String,
    pub unknown_track: String,
    pub paused: String,
    /// small badge text while playing
    pub playing: String,
    pub open_on: String,
    pub play: String,
    pub pause: String,
    pub next: String,
    pub prev: String,
    pub show: String,
    pub mini: String,
    pub quit: String,
    pub nothing: String,
    pub liked: String,
    pub close: String,
}

impl MainStrings {
    pub fn english() -> Self {
        Self {
            unknown_artist: "Unknown artist".into(),
            unknown_track: "Untitled".into(),
            paused: "Paused".into(),
            playing: "Playing".into(),
            open_on: "Open on".into(),
            play: "Play".into(),
            pause: "Pause".into(),
            next: "Next".into(),
            prev: "Previous".into(),
            show: "Open Velvet".into(),
            mini: "Mini player".into(),
            quit: "Quit".into(),
            nothing: "Nothing playing".into(),
            liked: "Liked".into(),
            close: "Close".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_url: Option<String>,
    pub source_url: Option<String>,
    pub duration: f64,
    pub position: f64,
    pub rate: f64,
    pub playing: bool,
    pub track_id: String,
    pub language: String,
    pub strings: Option<MainStrings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOptions {
    pub url: String,
    pub download_dir: String,
    pub format: String,
    pub spotify_client_id: Option<String>,
    pub spotify_client_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub job_id: String,
    pub url: String,
    /// resolving | downloading | done | error | cancelled
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub total: u32,
    pub completed: u32,
    pub failed: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub track_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LyricsQuery {
    pub track_id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synced: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instrumental: Option<bool>,
    /// tags | lrclib | user | none
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LyricsResult {
    pub fn none() -> Self {
        Self {
            source: "none".into(),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_path: Option<String>,
    pub label: String,
    pub rate: f64,
    pub preserves_pitch: bool,
    pub reverb: f64,
    pub bass: f64,
    pub mid: f64,
    pub treble: f64,
    /// mp3 | wav | flac
    pub format: String,
    pub out_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub id: String,
    /// running | done | error
    pub state: String,
    pub percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration: f64,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteState {
    pub track_id: Option<String>,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_path: Option<String>,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub rate: f64,
    pub liked: bool,
    pub theme: String,
    pub accent: String,
    pub on_accent: String,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppPrefs {
    pub close_to_tray: bool,
    pub global_shortcuts: bool,
    pub global_hotkeys: std::collections::BTreeMap<String, Vec<String>>,
    pub notifications: bool,
    pub mini_on_top: bool,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// idle | checking | available | none | error
    pub state: String,
    /// the newer version on GitHub
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// the running version
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    /// release page
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// release notes (shortened)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YtDlpStatus {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// bundled | system | downloaded
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Errors cross into the UI as plain strings, like the Electron version's `e.message`.
pub type CmdResult<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
