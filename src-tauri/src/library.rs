//! Scanning folders and reading tags (lofty), in parallel.

use crate::types::{now_ms, Track};
use crate::{covers, media};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::PictureType;
use lofty::tag::{Accessor, ItemKey, Tag};
use rayon::prelude::*;
use regex::Regex;
use sha1::{Digest, Sha1};
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::LazyLock;

/// Same id as the Electron version: sha1 of the lower-cased path, 16 hex chars.
pub fn track_id_for_path(file: &str) -> String {
    hex::encode(Sha1::digest(file.to_lowercase().as_bytes()))[..16].to_string()
}

static ARTIST_TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.+?)\s+[-–—]\s+(.+)$").unwrap());

/// Guesses "Artist - Title" from a file name when tags are missing.
pub fn guess_from_file_name(file: &str) -> (String, String) {
    let stem = Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let name = stem.replace('_', " ").trim().to_string();
    match ARTIST_TITLE.captures(&name) {
        Some(c) => (c[1].trim().to_string(), c[2].trim().to_string()),
        None => (String::new(), name),
    }
}

/// Audio files under the given files/folders (12 levels deep, hidden entries skipped).
pub fn collect(inputs: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for input in inputs {
        let walker = walkdir::WalkDir::new(input)
            .follow_links(true)
            .max_depth(12)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_name().to_str().map(|n| n.starts_with('.')).unwrap_or(false));
        for entry in walker.flatten() {
            if entry.file_type().is_file() && media::is_audio(entry.path()) {
                let p = entry.path().to_string_lossy().into_owned();
                if seen.insert(p.clone()) {
                    out.push(p);
                }
            }
        }
    }
    out
}

fn first_text<'a>(tags: &'a [&'a Tag], f: impl Fn(&'a Tag) -> Option<String>) -> Option<String> {
    tags.iter()
        .find_map(|t| f(t).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
}

fn artists_of(tag: &Tag) -> Option<String> {
    for key in [ItemKey::TrackArtists, ItemKey::TrackArtist] {
        let list: Vec<String> = tag
            .get_strings(key)
            .flat_map(|s| s.split('\0'))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !list.is_empty() {
            return Some(list.join(", "));
        }
    }
    None
}

pub fn read_track(file: &str, source: &str) -> Track {
    let (artist, title) = guess_from_file_name(file);
    let mut track = Track {
        id: track_id_for_path(file),
        path: file.to_string(),
        title,
        artist,
        source: source.to_string(),
        added_at: now_ms(),
        ..Default::default()
    };
    // unreadable tags: keep the file-name guess, the player fills in the duration
    let Ok(tagged) = lofty::read_from_path(file) else { return track };
    track.duration = tagged.properties().duration().as_secs_f64();
    let mut tags: Vec<&Tag> = Vec::new();
    if let Some(t) = tagged.primary_tag() {
        tags.push(t);
    }
    tags.extend(
        tagged
            .tags()
            .iter()
            .filter(|t| Some(t.tag_type()) != tagged.primary_tag().map(|p| p.tag_type())),
    );

    if let Some(v) = first_text(&tags, |t| t.title().map(|s| s.into_owned())) {
        track.title = v;
    }
    if let Some(v) = first_text(&tags, artists_of) {
        track.artist = v;
    }
    if let Some(v) = first_text(&tags, |t| t.album().map(|s| s.into_owned())) {
        track.album = v;
    }
    track.track_no = tags.iter().find_map(|t| t.track()).filter(|n| *n > 0);
    track.year = tags
        .iter()
        .find_map(|t| {
            t.date()
                .map(|d| d.year as u32)
                .or_else(|| t.get_string(ItemKey::Year).and_then(|y| y.get(..4)?.parse().ok()))
        })
        .filter(|y| *y > 0);
    let pic = tags
        .iter()
        .find_map(|t| t.get_picture_type(PictureType::CoverFront))
        .or_else(|| tags.iter().find_map(|t| t.pictures().first()));
    if let Some(p) = pic.filter(|p| !p.data().is_empty()) {
        let mime = p.mime_type().map(|m| m.as_str().to_string()).unwrap_or_else(|| "image/jpeg".into());
        track.cover_path = covers::save_buffer(p.data(), &mime).ok();
    }
    track
}

/// Reads every audio file under `inputs`, reporting `(done, total)` along the way.
pub fn scan(inputs: &[String], progress: impl Fn(usize, usize) + Sync) -> Vec<Track> {
    let files = collect(inputs);
    let total = files.len();
    let done = AtomicUsize::new(0);
    files
        .par_iter()
        .map(|f| {
            let t = read_track(f, "local");
            progress(done.fetch_add(1, Ordering::Relaxed) + 1, total);
            t
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_the_electron_version() {
        // sha1("c:\\music\\a.mp3") — the library and history keep working after the switch
        assert_eq!(
            track_id_for_path("C:\\Music\\A.mp3"),
            &hex::encode(Sha1::digest(b"c:\\music\\a.mp3"))[..16]
        );
        assert_eq!(track_id_for_path("C:\\Music\\A.mp3").len(), 16);
    }

    #[test]
    fn guesses_artist_and_title() {
        assert_eq!(
            guess_from_file_name("/m/Neon Coast - Midnight Drive.mp3"),
            ("Neon Coast".into(), "Midnight Drive".into())
        );
        assert_eq!(guess_from_file_name("/m/some_track.flac"), ("".into(), "some track".into()));
    }

    #[test]
    fn collects_audio_files_skipping_hidden_ones() {
        let dir = std::env::temp_dir().join(format!("velvet-scan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        for f in ["a.mp3", "sub/b.FLAC", ".hidden/c.mp3", "notes.txt"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let mut found: Vec<String> = collect(&[dir.to_string_lossy().into_owned()])
            .into_iter()
            .map(|p| Path::new(&p).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        found.sort();
        assert_eq!(found, vec!["a.mp3", "b.FLAC"]);
        // unreadable "audio" keeps the file name guess
        let t = read_track(&dir.join("a.mp3").to_string_lossy(), "local");
        assert_eq!(t.title, "a");
        assert_eq!(t.duration, 0.0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
