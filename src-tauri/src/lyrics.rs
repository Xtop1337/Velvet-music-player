//! Lyrics: from the file's tags, else LRCLIB (exact lookups, then fuzzy search). Cached per track.

use crate::paths;
use crate::types::{now_ms, LyricsQuery, LyricsResult};
use lofty::file::TaggedFileExt;
use lofty::tag::ItemKey;
use regex::Regex;
use serde::Deserialize;
use std::sync::LazyLock;

const RETRY_EMPTY_MS: u64 = 7 * 86_400_000;
const UA: &str = "Velvet music player (https://github.com/)";

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}
re!(
    NOISE,
    r"(?i)\s*[(\[](?:official|lyrics?|audio|video|visuali[sz]er|mv|hd|hq|4k|remaster(?:ed)?|explicit|clean|prod\.?|free download|out now|slowed|sped ?up|speed ?up|nightcore|reverb|8d|bass ?boost(?:ed)?)[^)\]]*[)\]]"
);
re!(FEAT_BRACKET, r"(?i)\s*[(\[](?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]");
re!(FEAT_TAIL, r"(?i)\s+(?:feat|ft|featuring)\.?\s.+$");
re!(
    DASH_TAIL,
    r"(?i)\s*[-–—|]\s*(?:slowed|sped up|speed up|nightcore|reverb|lyrics?|official.*)$"
);
re!(SPACES, r"\s+");
re!(TOPIC, r"(?i)\s+-\s+topic$");
re!(ARTIST_SPLIT, r"(?i)\s*(?:,|;|&|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*");
re!(DASH, r"^(.+?)\s+[-–—]\s+(.+)$");
re!(NON_WORD, r"[^\p{L}\p{N}]+");
re!(LRC_LINE, r"(?m)^\s*\[\d{1,3}:\d{2}");

/// Strips decorations that stop lyric sites from matching.
pub fn clean_title(title: &str) -> String {
    let s = NOISE.replace_all(title, " ");
    let s = FEAT_BRACKET.replace_all(&s, " ");
    let s = FEAT_TAIL.replace(&s, "");
    let s = DASH_TAIL.replace(&s, "");
    SPACES.replace_all(&s, " ").trim().to_string()
}

/// First credited artist, without "feat." guests.
pub fn main_artist(artist: &str) -> String {
    let s = TOPIC.replace(artist, "");
    ARTIST_SPLIT.split(&s).next().unwrap_or("").trim().to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Q {
    pub title: String,
    pub artist: String,
}

/// (title, artist) pairs to try, most specific first.
pub fn lyric_queries(title: &str, artist: &str) -> Vec<Q> {
    let mut t = title.trim().to_string();
    let mut a = artist.trim().to_string();
    // uploads named "Artist - Title" with no separate artist tag
    if let Some(c) = DASH.captures(&t.clone()) {
        if a.is_empty() || c[1].to_lowercase().contains(&main_artist(&a).to_lowercase()) {
            if a.is_empty() {
                a = c[1].to_string();
            }
            t = c[2].to_string();
        }
    }
    let mut out: Vec<Q> = Vec::new();
    let mut add = |ti: String, ar: String| {
        if !ti.is_empty()
            && !out
                .iter()
                .any(|o| o.title.to_lowercase() == ti.to_lowercase() && o.artist.to_lowercase() == ar.to_lowercase())
        {
            out.push(Q { title: ti, artist: ar });
        }
    };
    add(t.clone(), a.clone());
    add(clean_title(&t), a.clone());
    add(clean_title(&t), main_artist(&a));
    out
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LrclibRow {
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
    pub instrumental: Option<bool>,
    pub duration: Option<f64>,
}

fn norm(s: &str) -> String {
    NON_WORD.replace_all(&s.to_lowercase(), " ").trim().to_string()
}

fn has(s: &Option<String>) -> bool {
    s.as_deref().map(|v| !v.is_empty()).unwrap_or(false)
}

/// Picks the best LRCLIB search hit, or none when nothing is close enough.
pub fn pick_lrclib(rows: &[LrclibRow], duration: f64, want: Option<&Q>) -> Option<LrclibRow> {
    let score = |r: &LrclibRow| -> f64 {
        let mut s = if has(&r.synced_lyrics) { 10.0 } else { 0.0 };
        if duration > 0.0 {
            if let Some(d) = r.duration.filter(|d| *d > 0.0) {
                let diff = (d - duration).abs();
                s -= diff.min(20.0);
                if diff > 20.0 {
                    s -= 30.0 // most likely another song or a remix
                }
            }
        }
        if let Some(w) = want {
            if !w.artist.is_empty()
                && r.artist_name
                    .as_deref()
                    .map(|n| norm(n).contains(&norm(&main_artist(&w.artist))))
                    .unwrap_or(false)
            {
                s += 8.0;
            }
            if !w.title.is_empty()
                && r.track_name
                    .as_deref()
                    .map(|n| norm(n) == norm(&clean_title(&w.title)))
                    .unwrap_or(false)
            {
                s += 6.0;
            }
        }
        s
    };
    let mut best: Option<(&LrclibRow, f64)> = None;
    for r in rows
        .iter()
        .filter(|r| has(&r.synced_lyrics) || has(&r.plain_lyrics) || r.instrumental == Some(true))
    {
        let s = score(r);
        if best.map(|(_, b)| s > b).unwrap_or(true) {
            best = Some((r, s));
        }
    }
    best.filter(|(_, s)| *s >= -25.0).map(|(r, _)| r.clone())
}

fn to_result(r: Option<LrclibRow>) -> LyricsResult {
    let Some(r) = r else { return LyricsResult::none() };
    if r.instrumental == Some(true) && !has(&r.synced_lyrics) && !has(&r.plain_lyrics) {
        return LyricsResult {
            source: "lrclib".into(),
            instrumental: Some(true),
            ..Default::default()
        };
    }
    LyricsResult {
        synced: r.synced_lyrics.filter(|s| !s.is_empty()),
        plain: r.plain_lyrics.filter(|s| !s.is_empty()),
        source: "lrclib".into(),
        ..Default::default()
    }
}

/// Lyrics stored in the file; LRC text there counts as synced.
pub fn from_tags(path: &str) -> Option<LyricsResult> {
    let file = lofty::read_from_path(path).ok()?;
    for tag in file.tags() {
        for key in [ItemKey::Lyrics, ItemKey::UnsyncLyrics] {
            if let Some(text) = tag.get_string(key).map(str::trim).filter(|t| !t.is_empty()) {
                return Some(if LRC_LINE.is_match(text) {
                    LyricsResult {
                        synced: Some(text.to_string()),
                        source: "tags".into(),
                        ..Default::default()
                    }
                } else {
                    LyricsResult {
                        plain: Some(text.to_string()),
                        source: "tags".into(),
                        ..Default::default()
                    }
                });
            }
        }
    }
    None
}

async fn get(path: &str, query: &[(&str, String)]) -> Result<Option<serde_json::Value>, String> {
    let res = crate::net::client()
        .get(format!("https://lrclib.net/api{path}"))
        .header(reqwest::header::USER_AGENT, UA)
        .query(query)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().as_u16() == 404 {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("LRCLIB HTTP {}", res.status().as_u16()));
    }
    res.json().await.map(Some).map_err(|e| e.to_string())
}

fn rows(v: Option<serde_json::Value>) -> Vec<LrclibRow> {
    v.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

async fn from_lrclib(q: &LyricsQuery) -> Result<LyricsResult, String> {
    let queries = lyric_queries(&q.title, &q.artist);
    // 1. exact signature lookups (fast, precise)
    for (i, v) in queries.iter().enumerate() {
        let mut params = vec![("track_name", v.title.clone()), ("artist_name", v.artist.clone())];
        if i == 0 && !q.album.is_empty() {
            params.push(("album_name", q.album.clone()));
        }
        if q.duration > 0.0 {
            params.push(("duration", (q.duration.round() as i64).to_string()));
        }
        let row = get("/get", &params)
            .await?
            .and_then(|v| serde_json::from_value::<LrclibRow>(v).ok());
        let r = to_result(row);
        if r.source != "none" {
            return Ok(r);
        }
    }
    // 2. fuzzy search, by fields and then by free text
    for v in queries.iter().skip(queries.len().saturating_sub(2)) {
        let found = rows(get("/search", &[("track_name", v.title.clone()), ("artist_name", v.artist.clone())]).await?);
        if let Some(hit) = pick_lrclib(&found, q.duration, Some(v)) {
            return Ok(to_result(Some(hit)));
        }
    }
    let Some(last) = queries.last() else {
        return Ok(LyricsResult::none());
    };
    let free = rows(get("/search", &[("q", format!("{} {}", last.artist, last.title).trim().to_string())]).await?);
    Ok(to_result(pick_lrclib(&free, q.duration, Some(last))))
}

fn cache_file(track_id: &str) -> std::path::PathBuf {
    let dir = paths::cache().join("lyrics");
    let _ = std::fs::create_dir_all(&dir);
    let safe: String = track_id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    dir.join(format!("{safe}.json"))
}

pub async fn get_lyrics(q: LyricsQuery) -> LyricsResult {
    let file = cache_file(&q.track_id);
    if !q.force {
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                let at = v.get("at").and_then(|a| a.as_f64()).unwrap_or(0.0) as u64;
                if let Ok(cached) = serde_json::from_value::<LyricsResult>(v) {
                    if cached.source != "none" || now_ms().saturating_sub(at) < RETRY_EMPTY_MS {
                        return cached;
                    }
                }
            }
        }
    }
    let path = q.path.clone();
    let mut result = tauri::async_runtime::spawn_blocking(move || from_tags(&path)).await.ok().flatten();
    if result.is_none() && !q.title.is_empty() {
        match from_lrclib(&q).await {
            Ok(r) => result = Some(r),
            // offline: don't cache, report the error
            Err(e) => {
                return LyricsResult {
                    error: Some(e),
                    ..LyricsResult::none()
                }
            }
        }
    }
    let result = result.unwrap_or_else(LyricsResult::none);
    let mut stored = serde_json::to_value(&result).unwrap_or_default();
    stored["at"] = serde_json::json!(now_ms());
    let _ = std::fs::write(&file, stored.to_string());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(t: &str, a: &str) -> Q {
        Q {
            title: t.into(),
            artist: a.into(),
        }
    }

    #[test]
    fn cleans_decorated_titles() {
        assert_eq!(clean_title("Blinding Lights (Official Video)"), "Blinding Lights");
        assert_eq!(clean_title("Snowfall [slowed + reverb]"), "Snowfall");
        assert_eq!(clean_title("Song (feat. Someone) [Free Download]"), "Song");
        assert_eq!(clean_title("Song - Sped Up"), "Song");
        assert_eq!(clean_title("nakolki"), "nakolki");
    }

    #[test]
    fn takes_the_main_artist() {
        assert_eq!(main_artist("Neon Coast feat. Aurora"), "Neon Coast");
        assert_eq!(main_artist("A, B & C"), "A");
        assert_eq!(main_artist("Øneheart - Topic"), "Øneheart");
    }

    #[test]
    fn splits_uploads_and_builds_fallbacks() {
        assert_eq!(
            lyric_queries("Платон Чебурин - nakolki (Official Audio)", ""),
            vec![q("nakolki (Official Audio)", "Платон Чебурин"), q("nakolki", "Платон Чебурин")]
        );
        assert_eq!(
            lyric_queries("Drive (slowed)", "Neon Coast feat. Aurora").last().unwrap(),
            &q("Drive", "Neon Coast")
        );
    }

    #[test]
    fn prefers_synced_lyrics_of_the_same_song() {
        let row = |a: &str, synced: Option<&str>, plain: Option<&str>, d: f64| LrclibRow {
            track_name: Some("Drive".into()),
            artist_name: Some(a.into()),
            synced_lyrics: synced.map(String::from),
            plain_lyrics: plain.map(String::from),
            duration: Some(d),
            ..Default::default()
        };
        let best = pick_lrclib(
            &[
                row("Other", None, Some("a"), 200.0),
                row("Neon Coast", Some("[00:01]x"), None, 260.0),
                row("Neon Coast", Some("[00:01]y"), None, 201.0),
            ],
            200.0,
            Some(&q("Drive", "Neon Coast")),
        );
        assert_eq!(best.unwrap().synced_lyrics.as_deref(), Some("[00:01]y"));
        let other = LrclibRow {
            track_name: Some("X".into()),
            artist_name: Some("Y".into()),
            synced_lyrics: Some("[00:01]z".into()),
            duration: Some(400.0),
            ..Default::default()
        };
        assert!(pick_lrclib(&[other], 120.0, Some(&q("Drive", "Neon"))).is_none());
        assert!(pick_lrclib(&[LrclibRow::default()], 100.0, None).is_none());
    }
}
