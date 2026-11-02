//! File types the player handles (same lists as `src/shared/defaults.ts`).

use std::path::Path;

pub const AUDIO_EXTENSIONS: [&str; 12] = [
    "mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "webm", "aiff", "aif", "wma", "alac",
];
pub const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "webm", "mov", "m4v"];
pub const IMAGE_EXTENSIONS: [&str; 6] = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

pub fn ext(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

pub fn is_audio(path: &Path) -> bool {
    AUDIO_EXTENSIONS.contains(&ext(path).as_str())
}

pub fn mime(ext: &str) -> &'static str {
    match ext {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "m4a" | "alac" => "audio/mp4",
        "aac" => "audio/aac",
        "webm" => "audio/webm",
        "aiff" | "aif" => "audio/aiff",
        "wma" => "audio/x-ms-wma",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

pub fn servable(ext: &str) -> bool {
    AUDIO_EXTENSIONS.contains(&ext) || IMAGE_EXTENSIONS.contains(&ext) || VIDEO_EXTENSIONS.contains(&ext)
}
