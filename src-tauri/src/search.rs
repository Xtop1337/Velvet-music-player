//! Searching SoundCloud / YouTube (through yt-dlp) and Spotify (Web API with the user's keys),
//! and preview streams.

use crate::matcher::split_artist_title;
use crate::spotify::{self, SpotifyItem, SpotifyKeys};
use crate::tools::{require_ytdlp, ytdlp_json};
use crate::types::SearchResult;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty())
}

fn best_thumb(e: &Value) -> Option<String> {
    if let Some(t) = s(e, "thumbnail") {
        return Some(t.to_string());
    }
    let mut list: Vec<(&str, f64)> = e
        .get("thumbnails")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| Some((s(t, "url")?, t.get("width").and_then(Value::as_f64).unwrap_or(0.0))))
                .collect()
        })
        .unwrap_or_default();
    list.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    list.iter().find(|t| t.1 <= 640.0).or(list.first()).map(|t| t.0.to_string())
}

/// Turns yt-dlp search entries into result cards.
pub fn to_results(entries: &[Value], source: &str) -> Vec<SearchResult> {
    entries
        .iter()
        .filter_map(|e| {
            let url = s(e, "webpage_url").or(s(e, "url"))?;
            let title = s(e, "title")?;
            let uploader = s(e, "channel").or(s(e, "uploader")).unwrap_or("");
            let uploader = uploader.strip_suffix(" - Topic").unwrap_or(uploader);
            let (artist, title) = split_artist_title(title, uploader, s(e, "artist"));
            let id = s(e, "id").or(s(e, "url")).unwrap_or("");
            Some(SearchResult {
                id: format!("{source}:{id}"),
                title,
                artist,
                duration: e.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
                url: url.to_string(),
                thumbnail: best_thumb(e),
                source: source.to_string(),
                genre: s(e, "genre")
                    .or_else(|| e.get("genres").and_then(Value::as_array).and_then(|g| g.first()).and_then(Value::as_str))
                    .filter(|g| !g.trim().is_empty())
                    .map(String::from),
                ..Default::default()
            })
        })
        .collect()
}

fn entries(v: &Value) -> Vec<Value> {
    v.get("entries").and_then(Value::as_array).cloned().unwrap_or_default()
}

pub async fn search(query: &str, source: &str, limit: u32, keys: &SpotifyKeys) -> Result<Vec<SearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    if source == "spotify" {
        return spotify::search(q, limit as usize, keys).await;
    }
    let bin = require_ytdlp().await?;
    let prefix = if source == "soundcloud" { "scsearch" } else { "ytsearch" };
    let flat = ytdlp_json(
        &bin,
        &["--flat-playlist".into(), format!("{prefix}{limit}:{q}")],
        Duration::from_secs(60),
    )
    .await?;
    let found = entries(&flat);
    let mut results = to_results(&found, source);
    // SoundCloud flat results can come back without titles: resolve a smaller page fully
    if results.is_empty() && !found.is_empty() {
        let full = ytdlp_json(&bin, &[format!("{prefix}{}:{q}", limit.min(10))], Duration::from_secs(120)).await?;
        results = to_results(&entries(&full), source);
    }
    Ok(results)
}

/// What the UI knows about a result it wants to hear.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PreviewRequest {
    pub url: String,
    pub title: String,
    pub artist: String,
    pub duration: f64,
}

pub fn is_spotify(url: &str) -> bool {
    url.starts_with("https://open.spotify.com/")
}

/// Spotify itself can't be streamed (DRM): the same audio the importer would download is found
/// on YouTube / SoundCloud and played from there.
pub async fn preview(r: &PreviewRequest) -> Result<String, String> {
    if !is_spotify(&r.url) {
        return preview_url(&r.url).await;
    }
    let bin = require_ytdlp().await?;
    let item = SpotifyItem {
        title: r.title.clone(),
        artists: r.artist.split(", ").map(str::trim).filter(|a| !a.is_empty()).map(String::from).collect(),
        duration_ms: r.duration * 1000.0,
        url: r.url.clone(),
        ..Default::default()
    };
    let found = crate::importer::find_audio(&bin, &item, false).await.ok_or_else(|| "no-match".to_string())?;
    preview_url(&found.url).await
}

/// Direct audio stream URL for previewing a result before downloading it.
pub async fn preview_url(url: &str) -> Result<String, String> {
    let bin = require_ytdlp().await?;
    let info = ytdlp_json(
        &bin,
        &[
            "--no-playlist".into(),
            "-f".into(),
            "bestaudio[protocol^=http][ext=m4a]/bestaudio[protocol^=http][ext=mp3]/bestaudio[protocol^=http]/bestaudio".into(),
            url.to_string(),
        ],
        Duration::from_secs(60),
    )
    .await?;
    s(&info, "url")
        .or_else(|| info.get("requested_formats")?.as_array()?.first().and_then(|f| s(f, "url")))
        .map(String::from)
        .ok_or_else(|| "no stream".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_youtube_flat_entries() {
        let r = to_results(
            &[
                json!({ "id": "abc", "title": "Snowfall", "url": "https://www.youtube.com/watch?v=abc", "channel": "Øneheart - Topic", "duration": 129,
                        "thumbnails": [{ "url": "small", "width": 120 }, { "url": "mid", "width": 480 }, { "url": "huge", "width": 1280 }] }),
                json!({ "id": "x", "url": "https://youtube.com/watch?v=x" }),
            ],
            "youtube",
        );
        assert_eq!(
            r,
            vec![SearchResult {
                id: "youtube:abc".into(),
                title: "Snowfall".into(),
                artist: "Øneheart".into(),
                duration: 129.0,
                url: "https://www.youtube.com/watch?v=abc".into(),
                thumbnail: Some("mid".into()),
                source: "youtube".into(),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn splits_artist_title_uploads() {
        let r = to_results(
            &[
                json!({ "id": "1", "title": "Neon Coast - Midnight Drive", "uploader": "label", "webpage_url": "https://soundcloud.com/a/b" }),
            ],
            "soundcloud",
        );
        assert_eq!(
            (r[0].artist.as_str(), r[0].title.as_str(), r[0].url.as_str()),
            ("Neon Coast", "Midnight Drive", "https://soundcloud.com/a/b")
        );
    }
}
