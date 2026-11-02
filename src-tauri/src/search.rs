//! Searching SoundCloud / YouTube through yt-dlp, and preview streams.

use crate::matcher::split_artist_title;
use crate::tools::{require_ytdlp, ytdlp_json};
use crate::types::SearchResult;
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
            })
        })
        .collect()
}

fn entries(v: &Value) -> Vec<Value> {
    v.get("entries").and_then(Value::as_array).cloned().unwrap_or_default()
}

pub async fn search(query: &str, source: &str, limit: u32) -> Result<Vec<SearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
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
                source: "youtube".into()
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
