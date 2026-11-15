//! Deezer's public API (no keys needed): similar artists, top tracks, artist radio, 30-second
//! previews, genres and release years. Velvet uses it for recommendations, radio and the
//! genre / year of tracks whose tags lack them.
//!
//! Answers are cached on disk (`cache/deezer.json`) for days, so repeated recommendations are
//! instant, and at most a few requests run at once (Deezer allows ~50 per 5 s).

use crate::paths;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::Semaphore;

const DAY: u64 = 86_400;
const MAX_ENTRIES: usize = 6000;

fn api() -> String {
    std::env::var("VELVET_DEEZER_API").unwrap_or_else(|_| "https://api.deezer.com".into())
}

static LIMIT: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(6));
/// request key → (answer, expires at, unix seconds)
static CACHE: Mutex<Option<HashMap<String, (Value, u64)>>> = Mutex::new(None);
static DIRTY: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn cache_file() -> std::path::PathBuf {
    paths::cache().join("deezer.json")
}

fn cached(key: &str) -> Option<Value> {
    let mut c = CACHE.lock().unwrap();
    let map = c.get_or_insert_with(|| {
        std::fs::read_to_string(cache_file())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    });
    map.get(key).filter(|(_, exp)| *exp > now()).map(|(v, _)| v.clone())
}

fn remember(key: String, v: &Value, ttl_days: u64) {
    let mut c = CACHE.lock().unwrap();
    let map = c.get_or_insert_with(HashMap::new);
    let t = now();
    map.insert(key, (v.clone(), t + ttl_days * DAY));
    if map.len() > MAX_ENTRIES {
        map.retain(|_, (_, exp)| *exp > t);
        // still too many: drop the ones expiring soonest
        if map.len() > MAX_ENTRIES {
            let mut exps: Vec<u64> = map.values().map(|(_, e)| *e).collect();
            exps.sort_unstable();
            let cut = exps[map.len() - MAX_ENTRIES];
            map.retain(|_, (_, e)| *e > cut);
        }
    }
    DIRTY.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// Writes the cache to disk (after a batch of requests).
pub fn save_cache() {
    if DIRTY.swap(0, std::sync::atomic::Ordering::Relaxed) == 0 {
        return;
    }
    let c = CACHE.lock().unwrap();
    if let Some(map) = c.as_ref() {
        let _ = std::fs::write(cache_file(), serde_json::to_string(map).unwrap_or_default());
    }
}

/// `GET {api}{path}` with a query, cached for `ttl_days`.
pub async fn get(path: &str, query: &[(&str, &str)], ttl_days: u64) -> Result<Value, String> {
    let key = format!("{path}?{}", query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"));
    if let Some(v) = cached(&key) {
        return Ok(v);
    }
    let _permit = LIMIT.acquire().await.map_err(|e| e.to_string())?;
    pace().await;
    for attempt in 0..2 {
        let res = crate::net::client()
            .get(format!("{}{path}", api()))
            .query(query)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("Deezer: {}", first_line(&e.to_string())))?;
        if !res.status().is_success() {
            return Err(format!("Deezer: HTTP {}", res.status().as_u16()));
        }
        let v: Value = res.json().await.map_err(|e| e.to_string())?;
        if let Some(err) = v.get("error") {
            // code 4: too many requests — wait a moment and try once more
            if err.get("code").and_then(Value::as_i64) == Some(4) && attempt == 0 {
                tokio::time::sleep(Duration::from_millis(1200)).await;
                continue;
            }
            return Err(format!("Deezer: {}", err.get("message").and_then(Value::as_str).unwrap_or("error")));
        }
        remember(key, &v, ttl_days);
        return Ok(v);
    }
    Err("Deezer: too many requests".into())
}

/// Deezer allows about 50 requests in 5 seconds: requests start at least 110 ms apart.
async fn pace() {
    static NEXT: Mutex<Option<tokio::time::Instant>> = Mutex::new(None);
    let at = {
        let mut next = NEXT.lock().unwrap();
        let now = tokio::time::Instant::now();
        let at = next.filter(|n| *n > now).unwrap_or(now);
        *next = Some(at + Duration::from_millis(110));
        at
    };
    tokio::time::sleep_until(at).await;
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(160).collect()
}

/// A track as Deezer describes it.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DzTrack {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub artist_id: u64,
    pub album: String,
    pub album_id: u64,
    /// album cover, ~250 px
    pub cover: Option<String>,
    /// album cover, ~500 px (Discord, the player)
    pub cover_big: Option<String>,
    pub duration: f64,
    /// 30-second mp3
    pub preview: Option<String>,
    /// popularity (higher = more popular)
    pub rank: u64,
    pub link: String,
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn url(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).filter(|u| u.starts_with("https://")).map(String::from)
}

pub fn parse_track(t: &Value) -> Option<DzTrack> {
    let id = t.get("id").and_then(Value::as_u64)?;
    let title = Some(text(t, "title")).filter(|s| !s.is_empty())?;
    let artist = t.get("artist").cloned().unwrap_or(Value::Null);
    let album = t.get("album").cloned().unwrap_or(Value::Null);
    // only tracks that can be played
    if t.get("readable").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    Some(DzTrack {
        id,
        title,
        artist: text(&artist, "name"),
        artist_id: artist.get("id").and_then(Value::as_u64).unwrap_or(0),
        album: text(&album, "title"),
        album_id: album.get("id").and_then(Value::as_u64).unwrap_or(0),
        cover: url(&album, "cover_medium"),
        cover_big: url(&album, "cover_big").or_else(|| url(&album, "cover_xl")),
        duration: t.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
        preview: url(t, "preview"),
        rank: t.get("rank").and_then(Value::as_u64).unwrap_or(0),
        link: url(t, "link").unwrap_or_else(|| format!("https://www.deezer.com/track/{id}")),
    })
}

pub fn parse_tracks(v: &Value) -> Vec<DzTrack> {
    v.get("data").and_then(Value::as_array).map(|a| a.iter().filter_map(parse_track).collect()).unwrap_or_default()
}

fn simple(s: &str) -> String {
    crate::matcher::normalize(s)
}

/// Deezer's id for an artist name (the exact name if it is among the first answers).
pub async fn artist_id(name: &str) -> Option<u64> {
    let v = get("/search/artist", &[("q", name), ("limit", "5")], 30).await.ok()?;
    let list = v.get("data").and_then(Value::as_array)?;
    let want = simple(name);
    if want.is_empty() {
        return None;
    }
    // only the artist with exactly this name: "the first answer" for an uploader's nickname
    // is somebody else, and their similar artists would be a different genre
    list.iter()
        .find(|a| simple(&text(a, "name")) == want)
        .and_then(|a| a.get("id").and_then(Value::as_u64))
}

/// True when Deezer answers at all (to tell "unknown artist" from "no connection").
pub async fn reachable() -> bool {
    get("/genre/0", &[], 30).await.is_ok()
}

/// Similar artists (id, name), most similar first.
pub async fn related(id: u64, limit: usize) -> Vec<(u64, String)> {
    let Ok(v) = get(&format!("/artist/{id}/related"), &[("limit", &limit.to_string())], 7).await else {
        return Vec::new();
    };
    v.get("data")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| Some((x.get("id")?.as_u64()?, text(x, "name"))))
                .filter(|(_, n)| !n.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub async fn top(id: u64, limit: usize) -> Vec<DzTrack> {
    get(&format!("/artist/{id}/top"), &[("limit", &limit.to_string())], 3).await.map(|v| parse_tracks(&v)).unwrap_or_default()
}

/// Deezer's radio of an artist: the artist and similar music, shuffled.
pub async fn artist_radio(id: u64) -> Vec<DzTrack> {
    get(&format!("/artist/{id}/radio"), &[("limit", "50")], 1).await.map(|v| parse_tracks(&v)).unwrap_or_default()
}

/// The Deezer track for "artist — title", when it can be told apart from covers and remixes.
pub async fn find_track(artist: &str, title: &str) -> Option<DzTrack> {
    let clean_title = crate::matcher::normalize(title);
    let q = if artist.trim().is_empty() {
        title.to_string()
    } else {
        format!("artist:\"{}\" track:\"{}\"", artist.replace('"', ""), title.replace('"', ""))
    };
    let v = get("/search", &[("q", q.as_str()), ("limit", "8")], 30).await.ok()?;
    let found = parse_tracks(&v);
    let want_artist = simple(artist.split([',', '&']).next().unwrap_or(""));
    found
        .iter()
        .find(|t| simple(&t.title) == clean_title && (want_artist.is_empty() || simple(&t.artist).contains(&want_artist)))
        .or_else(|| found.iter().find(|t| want_artist.is_empty() || simple(&t.artist).contains(&want_artist)))
        .cloned()
}

/// Genres and release year of an album.
pub async fn album_meta(id: u64) -> (Vec<String>, Option<u32>) {
    let Ok(v) = get(&format!("/album/{id}"), &[], 60).await else {
        return (Vec::new(), None);
    };
    let genres = v
        .pointer("/genres/data")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|g| text(g, "name")).filter(|g| !g.is_empty()).collect())
        .unwrap_or_default();
    let year = text(&v, "release_date").get(..4).and_then(|y| y.parse().ok()).filter(|y| *y > 1900);
    (genres, year)
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetaResult {
    pub id: String,
    pub genre: Option<String>,
    pub year: Option<u32>,
    /// the genre comes from the song's own page (more precise than a catalogue's)
    pub from_page: bool,
}

/// Genre and year for a track without them in its tags.
pub async fn lookup_meta(id: &str, artist: &str, title: &str) -> MetaResult {
    let mut out = MetaResult { id: id.to_string(), ..Default::default() };
    if let Some(t) = find_track(artist, title).await {
        if t.album_id != 0 {
            let (genres, year) = album_meta(t.album_id).await;
            out.genre = genres.into_iter().next();
            out.year = year;
        }
    }
    out
}

/// Looks up genre / year for tracks one after another (a few per second), emitting `meta:result`.
#[derive(Default)]
pub struct MetaQueue {
    items: std::sync::Arc<Mutex<std::collections::VecDeque<(String, String, String)>>>,
    running: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl MetaQueue {
    pub fn add(&self, app: &tauri::AppHandle, items: Vec<(String, String, String)>) {
        {
            let mut q = self.items.lock().unwrap();
            for it in items {
                if !q.iter().any(|x| x.0 == it.0) {
                    q.push_back(it);
                }
            }
        }
        if self.running.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let (items, running, app) = (self.items.clone(), self.running.clone(), app.clone());
        tauri::async_runtime::spawn(async move {
            use tauri::Emitter;
            loop {
                let next = items.lock().unwrap().pop_front();
                let Some((id, artist, title)) = next else { break };
                // "page:<url>" in place of the artist: ask the song's own page for its genre
                let r = match artist.strip_prefix("page:") {
                    Some(url) => MetaResult { id: id.clone(), genre: crate::importer::page_genre(url).await, year: None, from_page: true },
                    None => lookup_meta(&id, &artist, &title).await,
                };
                let _ = app.emit("meta:result", &r);
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            save_cache();
            running.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub fn track_json(id: u64, title: &str, artist: &str, artist_id: u64, rank: u64) -> Value {
        json!({ "id": id, "title": title, "readable": true, "duration": 180, "rank": rank,
                "preview": format!("https://cdnt-preview.dzcdn.net/{id}.mp3"), "link": format!("https://www.deezer.com/track/{id}"),
                "artist": { "id": artist_id, "name": artist },
                "album": { "id": id * 10, "title": "Album", "cover_medium": "https://e-cdns-images.dzcdn.net/m.jpg", "cover_big": "https://e-cdns-images.dzcdn.net/b.jpg" } })
    }

    #[test]
    fn reads_tracks() {
        let v = json!({ "data": [track_json(1, "Snowfall", "Øneheart", 7, 500), { "id": 2, "title": "", "artist": {} }, { "id": 3, "title": "Locked", "readable": false }] });
        let t = parse_tracks(&v);
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].artist.as_str(), t[0].artist_id, t[0].album_id), ("Øneheart", 7, 10));
        assert_eq!(t[0].preview.as_deref(), Some("https://cdnt-preview.dzcdn.net/1.mp3"));
        assert_eq!(t[0].cover_big.as_deref(), Some("https://e-cdns-images.dzcdn.net/b.jpg"));
    }

    #[tokio::test]
    async fn finds_genre_and_year_and_caches() {
        let _env = crate::paths::TEST_ENV.lock().await;
        let dir = std::env::temp_dir().join(format!("velvet-dz-{}", uuid::Uuid::new_v4()));
        std::env::set_var("VELVET_DATA_DIR", &dir);
        *CACHE.lock().unwrap() = None;
        let mock = crate::testutil::serve(vec![
            ("/search?", 200, json!({ "data": [track_json(5, "Snowfall (Remix)", "Someone", 9, 1), track_json(6, "Snowfall", "Øneheart", 7, 2)] }).to_string()),
            ("/album/60", 200, json!({ "genres": { "data": [{ "name": "Electro" }] }, "release_date": "2021-03-04" }).to_string()),
        ])
        .await;
        std::env::set_var("VELVET_DEEZER_API", &mock.base);
        let m = lookup_meta("t1", "Øneheart", "Snowfall").await;
        assert_eq!((m.genre.as_deref(), m.year), (Some("Electro"), Some(2021)));
        // the same questions again come from the cache, also after a restart
        save_cache();
        *CACHE.lock().unwrap() = None;
        let again = lookup_meta("t1", "Øneheart", "Snowfall").await;
        assert_eq!(again, m);
        assert_eq!(mock.seen.lock().unwrap().len(), 2);
        std::env::remove_var("VELVET_DEEZER_API");
        std::env::remove_var("VELVET_DATA_DIR");
        *CACHE.lock().unwrap() = None;
        let _ = std::fs::remove_dir_all(dir);
    }
}
