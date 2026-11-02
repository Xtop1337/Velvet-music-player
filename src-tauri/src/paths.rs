//! Where Velvet keeps its data.
//!
//! The data folder is the same one the Electron version used (`%APPDATA%\Velvet` on Windows,
//! `~/.config/Velvet` on Linux): the library, playlists, settings, history, covers, lyrics cache
//! and yt-dlp are picked up as they are, and the cover paths stored in the library stay valid.

use std::path::PathBuf;

fn ensure(dir: PathBuf) -> PathBuf {
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn data() -> PathBuf {
    if let Ok(dir) = std::env::var("VELVET_DATA_DIR") {
        return ensure(PathBuf::from(dir));
    }
    let base = dirs::config_dir().unwrap_or_else(std::env::temp_dir);
    ensure(base.join("Velvet"))
}

pub fn covers() -> PathBuf {
    ensure(data().join("covers"))
}

pub fn bin() -> PathBuf {
    ensure(data().join("bin"))
}

pub fn cache() -> PathBuf {
    ensure(data().join("cache"))
}

pub fn default_downloads() -> PathBuf {
    let music = dirs::audio_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Music")))
        .unwrap_or_else(data);
    ensure(music.join("Velvet"))
}

/// Tests that point VELVET_DATA_DIR somewhere take turns.
#[cfg(test)]
pub static TEST_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
