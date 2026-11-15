//! Tracks played straight from the internet (radio, daily mixes): yt-dlp finds the audio on
//! YouTube / SoundCloud, and Velvet relays it to the player through its own server, so the
//! player's speed, effects and visualizer work as for local files (a page can't process audio
//! read from other sites).
//!
//! The UI asks `resolve` for a stream id, then plays `<loopback>/stream/<id>` (or the
//! `velvet://__stream/<id>` fallback); Range requests are passed through, so seeking works.

use crate::importer::find_audio;
use crate::matcher::Candidate;
use crate::spotify::SpotifyItem;
use crate::tools::{require_ytdlp, ytdlp_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

/// Direct links from YouTube expire after ~6 h.
const FRESH: Duration = Duration::from_secs(4 * 3600);
const FORMAT: &str = "bestaudio[protocol^=http][ext=m4a]/bestaudio[protocol^=http][ext=mp3]/bestaudio[protocol^=http]/bestaudio";

#[derive(Debug, Clone)]
struct Upstream {
    url: String,
    headers: Vec<(String, String)>,
    at: Instant,
    /// the whole audio, downloaded ahead of playback (see `prefetch`)
    file: Option<(std::path::PathBuf, String)>,
}

/// A song downloaded ahead is at most this big (longer ones are relayed as they play).
const MAX_PREFETCH: u64 = 40 * 1024 * 1024;
/// Downloaded songs kept at a time (the next few and the last few).
const KEEP_FILES: usize = 8;

fn temp_dir() -> std::path::PathBuf {
    let dir = crate::paths::cache().join("streams");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Removes every temporary download (at launch and on quit).
pub fn clear_temp() {
    if let Ok(dir) = std::fs::read_dir(temp_dir()) {
        for f in dir.flatten() {
            let _ = std::fs::remove_file(f.path());
        }
    }
}

/// Ids being downloaded right now (so a song is fetched once).
static FETCHING: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

/// Downloads the audio of a stream into a temporary file, so the next song starts at once and
/// seeks freely. Returns true when the file is ready (false: too big, failed, or unknown id —
/// the song is then simply relayed while it plays).
pub async fn prefetch(id: &str) -> bool {
    let Some(up) = upstream(id) else { return false };
    if up.file.is_some() {
        return true;
    }
    if !FETCHING.lock().unwrap().get_or_insert_with(Default::default).insert(id.to_string()) {
        // already being downloaded (asked twice): wait for that download instead of starting another
        for _ in 0..300 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if !FETCHING.lock().unwrap().as_ref().map(|s| s.contains(id)).unwrap_or(false) {
                break;
            }
        }
        return local_file(id).is_some();
    }
    let ok = download(id, &up).await.is_some();
    if let Some(set) = FETCHING.lock().unwrap().as_mut() {
        set.remove(id);
    }
    ok
}

async fn download(id: &str, up: &Upstream) -> Option<()> {
    use tokio::io::AsyncWriteExt as _;
    let mut req = crate::net::client().get(&up.url);
    for (k, v) in &up.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let mut res = req.send().await.ok()?;
    if !res.status().is_success() || res.content_length().map(|l| l > MAX_PREFETCH).unwrap_or(false) {
        return None;
    }
    let ctype = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mp4")
        .to_string();
    let dir = temp_dir();
    let part = dir.join(format!("{id}.part"));
    let done = dir.join(format!("{id}.bin"));
    let mut f = tokio::fs::File::create(&part).await.ok()?;
    let mut size = 0u64;
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                size += chunk.len() as u64;
                if size > MAX_PREFETCH || f.write_all(&chunk).await.is_err() {
                    drop(f);
                    let _ = tokio::fs::remove_file(&part).await;
                    return None;
                }
            }
            Ok(None) => break,
            Err(_) => {
                drop(f);
                let _ = tokio::fs::remove_file(&part).await;
                return None;
            }
        }
    }
    f.flush().await.ok()?;
    drop(f);
    tokio::fs::rename(&part, &done).await.ok()?;
    let mut map = STREAMS.lock().unwrap();
    let map = map.as_mut()?;
    map.get_mut(id)?.file = Some((done, ctype));
    // keep only the newest few files
    let mut with_files: Vec<(Instant, String)> = map.iter().filter(|(_, u)| u.file.is_some()).map(|(k, u)| (u.at, k.clone())).collect();
    with_files.sort();
    while with_files.len() > KEEP_FILES {
        let (_, old) = with_files.remove(0);
        if old == id {
            continue;
        }
        if let Some((path, _)) = map.get_mut(&old).and_then(|u| u.file.take()) {
            let _ = std::fs::remove_file(path);
        }
    }
    Some(())
}

/// The downloaded file of a stream, if it is complete.
fn local_file(id: &str) -> Option<(std::path::PathBuf, String)> {
    upstream(id)?.file.filter(|(p, _)| p.exists())
}

static STREAMS: Mutex<Option<HashMap<String, Upstream>>> = Mutex::new(None);
/// track key → (stream id, source page)
static RESOLVED: Mutex<Option<HashMap<String, (String, String)>>> = Mutex::new(None);

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StreamRequest {
    pub title: String,
    pub artist: String,
    pub duration: f64,
    /// a YouTube / SoundCloud page already known for the track
    pub page: Option<String>,
    /// "youtube" (default) or "soundcloud": where to look first
    pub prefer: Option<String>,
    /// ignore the remembered link (it failed)
    pub fresh: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub id: String,
    /// the page the audio comes from (for "Download")
    pub page: String,
}

fn key_of(r: &StreamRequest) -> String {
    r.page.clone().unwrap_or_else(|| crate::recommend::track_key(&r.artist, &r.title))
}

fn is_page(url: &str) -> bool {
    crate::links::parse_music_link(url)
        .map(|l| l.service != "spotify" && l.kind == "track")
        .unwrap_or(false)
}

/// Remembers an upstream link and returns its id (also used by tests).
pub fn register(url: String, headers: Vec<(String, String)>) -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let mut map = STREAMS.lock().unwrap();
    let map = map.get_or_insert_with(HashMap::new);
    for (_, old) in map.iter().filter(|(_, u)| u.at.elapsed() >= FRESH) {
        if let Some((path, _)) = &old.file {
            let _ = std::fs::remove_file(path);
        }
    }
    map.retain(|_, u| u.at.elapsed() < FRESH);
    map.insert(id.clone(), Upstream { url, headers, at: Instant::now(), file: None });
    id
}

fn upstream(id: &str) -> Option<Upstream> {
    STREAMS
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(id).cloned())
        .filter(|u| u.at.elapsed() < FRESH)
}

/// Direct audio link + the HTTP headers yt-dlp says the host wants.
pub fn direct_from_info(info: &Value) -> Option<(String, Vec<(String, String)>)> {
    let fmt = if info.get("url").and_then(Value::as_str).is_some() {
        info
    } else {
        info.get("requested_formats")?.as_array()?.first()?
    };
    let url = fmt.get("url")?.as_str()?.to_string();
    let headers = fmt
        .get("http_headers")
        .or_else(|| info.get("http_headers"))
        .and_then(Value::as_object)
        .map(|h| {
            h.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                // the player sends its own Range; compression would break byte ranges
                .filter(|(k, _)| !k.eq_ignore_ascii_case("range") && !k.eq_ignore_ascii_case("accept-encoding"))
                .collect()
        })
        .unwrap_or_default();
    Some((url, headers))
}

pub async fn resolve(r: StreamRequest) -> Result<StreamInfo, String> {
    let key = key_of(&r);
    let known = RESOLVED.lock().unwrap().as_ref().and_then(|m| m.get(&key).cloned());
    if let Some((id, page)) = &known {
        if !r.fresh && upstream(id).is_some() {
            return Ok(StreamInfo { id: id.clone(), page: page.clone() });
        }
    }
    let bin = require_ytdlp().await?;
    // the page found before only needs a new direct link
    let page = match r.page.as_deref().filter(|p| is_page(p)).map(String::from).or(known.map(|k| k.1)) {
        Some(p) => p,
        None => {
            let item = SpotifyItem {
                title: r.title.clone(),
                artists: r.artist.split(", ").map(str::trim).filter(|a| !a.is_empty()).map(String::from).collect(),
                duration_ms: r.duration * 1000.0,
                ..Default::default()
            };
            let found: Option<Candidate> = find_audio(&bin, &item, r.prefer.as_deref() == Some("soundcloud")).await;
            found.ok_or_else(|| "no-match".to_string())?.url
        }
    };
    let info = ytdlp_json(&bin, &["--no-playlist".into(), "-f".into(), FORMAT.into(), page.clone()], Duration::from_secs(60)).await?;
    let (url, headers) = direct_from_info(&info).ok_or_else(|| "no stream".to_string())?;
    let id = register(url, headers);
    RESOLVED
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(key, (id.clone(), page.clone()));
    Ok(StreamInfo { id, page })
}

/// Fetches (part of) the upstream audio. `range` is the player's Range header.
async fn fetch(id: &str, method: &str, range: Option<&str>) -> Result<reqwest::Response, String> {
    let up = upstream(id).ok_or_else(|| "unknown stream".to_string())?;
    let mut req = if method == "HEAD" {
        crate::net::client().head(&up.url)
    } else {
        crate::net::client().get(&up.url)
    };
    for (k, v) in &up.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(r) = range {
        req = req.header(reqwest::header::RANGE, r);
    }
    req.send().await.map_err(|e| e.to_string())
}

const PASS: [&str; 4] = ["content-type", "content-length", "content-range", "accept-ranges"];

/// `GET /<token>/stream/<id>` on the loopback server: relays the upstream answer as it arrives.
pub async fn proxy(sock: &mut TcpStream, method: &str, id: &str, range: Option<&str>) -> std::io::Result<()> {
    use crate::media_server::respond;
    // already downloaded ahead: straight from the disk (instant start, free seeking)
    if let Some((path, ctype)) = local_file(id) {
        use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
        if let Ok(mut f) = tokio::fs::File::open(&path).await {
            let size = f.metadata().await.map(|m| m.len()).unwrap_or(0);
            let mut headers = vec![("Content-Type".to_string(), ctype), ("Accept-Ranges".into(), "bytes".into())];
            let (status, start, end) = match range.and_then(|r| crate::protocol::parse_range(r, size)) {
                Some(Err(())) => {
                    headers.push(("Content-Range".into(), format!("bytes */{size}")));
                    headers.push(("Content-Length".into(), "0".into()));
                    return respond(sock, "416 Range Not Satisfiable", &headers).await;
                }
                Some(Ok((s, e))) => {
                    headers.push(("Content-Range".into(), format!("bytes {s}-{e}/{size}")));
                    ("206 Partial Content", s, e)
                }
                None => ("200 OK", 0, size.saturating_sub(1)),
            };
            let len = if size == 0 { 0 } else { end - start + 1 };
            headers.push(("Content-Length".into(), len.to_string()));
            respond(sock, status, &headers).await?;
            if method == "HEAD" || len == 0 {
                return Ok(());
            }
            f.seek(std::io::SeekFrom::Start(start)).await?;
            tokio::io::copy(&mut f.take(len), sock).await?;
            return sock.flush().await;
        }
    }
    let res = match fetch(id, method, range).await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("stream {id}: {e}");
            let status = if e == "unknown stream" { "404 Not Found" } else { "502 Bad Gateway" };
            return respond(sock, status, &[("Content-Length".into(), "0".into())]).await;
        }
    };
    let status = res.status();
    let mut headers: Vec<(String, String)> = res
        .headers()
        .iter()
        .filter(|(k, _)| PASS.contains(&k.as_str()))
        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect();
    if !headers.iter().any(|(k, _)| k == "accept-ranges") {
        headers.push(("Accept-Ranges".into(), "bytes".into()));
    }
    let line = format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or(""));
    respond(sock, line.trim(), &headers).await?;
    if method == "HEAD" {
        return Ok(());
    }
    let mut res = res;
    // the player cancels by closing the connection: the write fails and the relay ends
    while let Ok(Some(chunk)) = res.chunk().await {
        sock.write_all(&chunk).await?;
    }
    sock.flush().await
}

/// The same relay for the `velvet` protocol (one bounded range per request).
pub fn protocol_response(id: &str, method: &str, range: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    // bound open-ended ranges like the file handler does
    let bounded = range.and_then(|r| {
        let spec = r.trim().strip_prefix("bytes=")?;
        let (a, b) = spec.split_once('-')?;
        let start: u64 = a.trim().parse().ok()?;
        let end = b.trim().parse::<u64>().ok().unwrap_or(start + crate::protocol::MAX_CHUNK - 1);
        Some(format!("bytes={start}-{}", end.min(start + crate::protocol::MAX_CHUNK - 1)))
    });
    let range = bounded.or_else(|| Some(format!("bytes=0-{}", crate::protocol::MAX_CHUNK - 1)));
    // already downloaded ahead: read the range from the disk
    if let Some((path, ctype)) = local_file(id) {
        use std::io::{Read as _, Seek as _};
        if let Ok(mut f) = std::fs::File::open(&path) {
            let size = f.metadata().map(|m| m.len()).unwrap_or(0);
            if let Some(Ok((start, end))) = range.as_deref().and_then(|r| crate::protocol::parse_range(r, size)) {
                let mut body = vec![0u8; (end - start + 1) as usize];
                if method == "HEAD" || (f.seek(std::io::SeekFrom::Start(start)).is_ok() && f.read_exact(&mut body).is_ok()) {
                    return Response::builder()
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .header(header::ACCEPT_RANGES, "bytes")
                        .header(header::CONTENT_TYPE, ctype)
                        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
                        .header(header::CONTENT_LENGTH, body.len().to_string())
                        .body(if method == "HEAD" { Vec::new() } else { body })
                        .unwrap();
                }
            }
        }
    }
    let result = tauri::async_runtime::handle().block_on(async {
        let res = fetch(id, method, range.as_deref()).await?;
        let status = res.status().as_u16();
        let headers: Vec<(String, String)> = res
            .headers()
            .iter()
            .filter(|(k, _)| PASS.contains(&k.as_str()))
            .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
            .collect();
        let body = if method == "HEAD" { Vec::new() } else { res.bytes().await.map_err(|e| e.to_string())?.to_vec() };
        Ok::<_, String>((status, headers, body))
    });
    match result {
        Ok((status, headers, body)) => {
            let mut b = Response::builder()
                .status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY))
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::ACCEPT_RANGES, "bytes");
            for (k, v) in headers {
                if k != "accept-ranges" {
                    b = b.header(k, v);
                }
            }
            b.body(body).unwrap()
        }
        Err(e) => {
            log::warn!("stream {id}: {e}");
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Vec::new())
                .unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_direct_link_and_its_headers() {
        let info = json!({ "url": "https://rr1.googlevideo.com/videoplayback?x=1", "http_headers": { "User-Agent": "UA", "Accept-Encoding": "gzip", "Range": "x" } });
        let (url, headers) = direct_from_info(&info).unwrap();
        assert_eq!(url, "https://rr1.googlevideo.com/videoplayback?x=1");
        assert_eq!(headers, vec![("User-Agent".to_string(), "UA".to_string())]);
        let merged = json!({ "requested_formats": [{ "url": "https://a/audio", "http_headers": {} }] });
        assert_eq!(direct_from_info(&merged).unwrap().0, "https://a/audio");
        assert!(direct_from_info(&json!({})).is_none());
    }

    #[tokio::test]
    async fn relays_ranges_from_the_upstream() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mock = crate::testutil::serve_with(vec![(
            "/audio",
            206,
            "0123456789".into(),
            vec![("Content-Type", "audio/mp4"), ("Content-Range", "bytes 10-19/100")],
        )])
        .await;
        let base = crate::media_server::start().await.unwrap();
        let id = register(format!("{}/audio", mock.base), vec![("User-Agent".into(), "Velvet-test".into())]);
        let res = reqwest::Client::new()
            .get(format!("{base}stream/{id}"))
            .header("Range", "bytes=10-19")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), 206);
        assert_eq!(res.headers()["content-range"], "bytes 10-19/100");
        assert_eq!(res.headers()["access-control-allow-origin"], "*");
        assert_eq!(res.text().await.unwrap(), "0123456789");
        let seen = mock.seen.lock().unwrap().clone();
        assert!(seen[0].headers.to_lowercase().contains("range: bytes=10-19"));
        assert!(seen[0].headers.contains("Velvet-test"));
        // unknown ids are refused
        let missing = reqwest::get(format!("{base}stream/nope")).await.unwrap();
        assert_eq!(missing.status().as_u16(), 404);
        let ping = reqwest::get(format!("{base}ping")).await.unwrap();
        assert_eq!(ping.status().as_u16(), 204);
    }

    #[tokio::test]
    async fn downloads_the_next_song_ahead_and_serves_it_from_disk() {
        let _env = crate::paths::TEST_ENV.lock().await;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = std::env::temp_dir().join(format!("velvet-st-{}", uuid::Uuid::new_v4()));
        std::env::set_var("VELVET_DATA_DIR", &dir);
        let body: String = (0..5000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        let mock = crate::testutil::serve_with(vec![("/song", 200, body.clone(), vec![("Content-Type", "audio/mpeg")])]).await;
        let base = crate::media_server::start().await.unwrap();
        let id = register(format!("{}/song", mock.base), Vec::new());
        assert!(prefetch(&id).await);
        assert!(prefetch(&id).await, "a second call finds the file");
        assert!(!prefetch("nope").await);
        // from now on the upstream isn't asked again: ranges come from the file
        let before = mock.seen.lock().unwrap().len();
        let res = reqwest::Client::new().get(format!("{base}stream/{id}")).header("Range", "bytes=100-199").send().await.unwrap();
        assert_eq!(res.status().as_u16(), 206);
        assert_eq!(res.headers()["content-range"], "bytes 100-199/5000");
        assert_eq!(res.headers()["content-type"], "audio/mpeg");
        assert_eq!(res.text().await.unwrap(), body[100..200]);
        let whole = reqwest::get(format!("{base}stream/{id}")).await.unwrap();
        assert_eq!(whole.text().await.unwrap().len(), 5000);
        assert_eq!(mock.seen.lock().unwrap().len(), before);
        let p = protocol_response(&id, "GET", Some("bytes=0-9"));
        assert_eq!((p.status().as_u16(), p.body().as_slice()), (206, &body.as_bytes()[..10]));
        clear_temp();
        assert!(local_file(&id).is_none());
        std::env::remove_var("VELVET_DATA_DIR");
        let _ = std::fs::remove_dir_all(dir);
    }
}
