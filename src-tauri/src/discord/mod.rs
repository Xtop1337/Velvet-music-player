//! Discord Rich Presence: "Listening to …" with cover, title, artist and a progress bar,
//! like Spotify. When paused, the activity is re-created without a timer (Discord keeps
//! counting otherwise), or hidden if the user prefers.

pub mod ipc;

use crate::paths;
use crate::types::{MainStrings, NowPlaying};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::time::Instant;

/// Velvet's own Discord application ("Velvet"): presence works without any setup.
pub const DEFAULT_CLIENT_ID: &str = "1562774102274740256";
/// Logo and the small playing / paused badges, served from the project's GitHub repository
/// (Discord shows images from public https links, no upload to the developer portal needed).
pub const ASSETS: &str = "https://raw.githubusercontent.com/Xtop1337/Velvet-music-player/main/assets/discord";

const LISTENING: u32 = 2;
const STATUS_DISPLAY_STATE: u32 = 1;
const MIN_INTERVAL: Duration = Duration::from_millis(2500);
const RETRY: Duration = Duration::from_secs(15);

/// How Velvet talks to the Discord client (a fake one in tests).
pub trait Transport: Send {
    /// Connects and logs in; returns the user name.
    fn connect(&mut self, client_id: &str) -> impl Future<Output = Result<String, String>> + Send;
    /// `None` clears the activity.
    fn set_activity(&mut self, activity: Option<Value>) -> impl Future<Output = Result<(), String>> + Send;
    fn close(&mut self) -> impl Future<Output = ()> + Send;
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscordOptions {
    pub enabled: bool,
    pub client_id: String,
    pub show_speed: bool,
    pub show_buttons: bool,
    pub lookup_covers: bool,
    /// local tracks: when no cover is found online, upload the track's own (public link)
    pub upload_covers: bool,
    /// remove the activity while paused instead of showing "Paused"
    pub hide_when_paused: bool,
}

fn clip(text: &str, max: usize) -> String {
    let t = text.trim();
    let n = t.chars().count();
    if n < 2 {
        format!("{t:<2}")
    } else if n > max {
        format!("{}…", t.chars().take(max - 1).collect::<String>())
    } else {
        t.to_string()
    }
}

fn service_name(url: &str) -> &'static str {
    if url.contains("soundcloud.com") {
        "SoundCloud"
    } else if url.contains("spotify.com") {
        "Spotify"
    } else if url.contains("youtu") {
        "YouTube"
    } else {
        "Web"
    }
}

/// `0.8` → "0.8", `1.25` → "1.25", `2` → "2"
fn rate_label(rate: f64) -> String {
    let s = format!("{rate:.2}");
    let s = s.trim_end_matches('0');
    s.trim_end_matches('.').to_string()
}

/// The Rich Presence payload (Discord RPC format).
pub fn build_activity(p: &NowPlaying, show_speed: bool, show_buttons: bool, now_ms: u64) -> Value {
    let s = p.strings.clone().unwrap_or_else(MainStrings::english);
    let rate = if p.rate > 0.0 { p.rate } else { 1.0 };
    let speed = if show_speed && (rate - 1.0).abs() > 0.001 {
        format!(" · {}x", rate_label(rate))
    } else {
        String::new()
    };
    let artist = if p.artist.is_empty() {
        s.unknown_artist.clone()
    } else {
        p.artist.clone()
    };
    let title = if p.title.is_empty() {
        s.unknown_track.clone()
    } else {
        p.title.clone()
    };
    let logo = format!("{ASSETS}/logo.png");
    let large_image = p.cover_url.as_deref().filter(|u| u.starts_with("https://")).unwrap_or(&logo);
    let (small_image, small_text) = if p.playing {
        (
            format!("{ASSETS}/playing.png"),
            if s.playing.is_empty() {
                "Playing".to_string()
            } else {
                s.playing.clone()
            },
        )
    } else {
        (format!("{ASSETS}/paused.png"), s.paused.clone())
    };
    let large_text = if p.playing {
        let name = [&p.album, &p.title]
            .into_iter()
            .find(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| "Velvet".into());
        format!("{name}{speed}")
    } else {
        format!("⏸ {}", s.paused)
    };
    let mut a = json!({
        "type": LISTENING,
        "status_display_type": STATUS_DISPLAY_STATE,
        "details": clip(&title, 128),
        "state": clip(&if p.playing { artist.clone() } else { format!("⏸ {} · {artist}", s.paused) }, 128),
        "assets": {
            "large_image": large_image,
            "large_text": clip(&large_text, 128),
            "small_image": small_image,
            "small_text": clip(&small_text, 128)
        },
        "instance": false
    });
    if p.playing && p.duration > 0.0 {
        // timestamps are wall-clock time, so they are scaled by the playback rate
        let start = now_ms as f64 - (p.position / rate) * 1000.0;
        a["timestamps"] = json!({ "start": start.round() as i64, "end": (start + (p.duration / rate) * 1000.0).round() as i64 });
    }
    if let Some(url) = p.source_url.as_deref().filter(|u| show_buttons && u.starts_with("https://")) {
        a["buttons"] = json!([{ "label": format!("{} {}", s.open_on, service_name(url)), "url": url }]);
    }
    a
}

// ── cover lookup (iTunes Search API) for local tracks ──────────────────────────

static COVER_CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);
static ART_SIZE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/\d+x\d+bb\.").unwrap());

fn cover_cache_file() -> std::path::PathBuf {
    paths::cache().join("cover-lookup.json")
}

/// A public artwork URL for a local track (Discord can't show local files).
pub async fn lookup_cover_url(artist: &str, title: &str) -> Option<String> {
    let key = format!("{artist}|{title}").to_lowercase();
    {
        let mut cache = COVER_CACHE.lock().unwrap();
        let map = cache.get_or_insert_with(|| {
            std::fs::read_to_string(cover_cache_file())
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default()
        });
        if let Some(hit) = map.get(&key) {
            return hit.clone();
        }
    }
    let term = format!("{artist} {title}").trim().to_string();
    // a network problem is not cached: it is tried again next time
    let res = crate::net::client()
        .get(std::env::var("VELVET_ITUNES_URL").unwrap_or_else(|_| "https://itunes.apple.com/search".into()))
        .query(&[("term", term.as_str()), ("media", "music"), ("entity", "song"), ("limit", "5")])
        .send()
        .await
        .ok()?;
    let url = if res.status().is_success() {
        let json: Value = res.json().await.ok()?;
        let results = json.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
        let want = title.to_lowercase();
        let hit = results
            .iter()
            .find(|r| {
                r.get("trackName")
                    .and_then(Value::as_str)
                    .map(|n| n.to_lowercase().contains(&want))
                    .unwrap_or(false)
            })
            .or(results.first());
        hit.and_then(|h| h.get("artworkUrl100"))
            .and_then(Value::as_str)
            .map(|u| ART_SIZE.replace(u, "/600x600bb.").into_owned())
    } else {
        None
    };
    let mut cache = COVER_CACHE.lock().unwrap();
    let map = cache.get_or_insert_with(HashMap::new);
    map.insert(key, url.clone());
    let _ = std::fs::write(cover_cache_file(), serde_json::to_string(map).unwrap_or_default());
    url
}

// ── the track's own cover, uploaded (when nothing is found online) ──────────────

static UPLOAD_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// covers whose upload failed in this session (not retried on every play / pause)
static UPLOAD_FAILED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
const UPLOAD_RETRY: Duration = Duration::from_secs(10 * 60);
/// Discord shows the large image at up to 300 px; 512 keeps it sharp on any screen.
const UPLOAD_SIZE: u32 = 512;

fn upload_cache_file() -> std::path::PathBuf {
    paths::cache().join("cover-upload.json")
}

fn upload_url() -> String {
    std::env::var("VELVET_COVER_UPLOAD_URL").unwrap_or_else(|_| "https://catbox.moe/user/api.php".into())
}

/// The cover as a small JPEG (what is uploaded), or `None` if it isn't a readable image.
pub fn cover_jpeg(path: &str) -> Option<Vec<u8>> {
    let img = image::open(path).ok()?;
    let img = if img.width() > UPLOAD_SIZE || img.height() > UPLOAD_SIZE {
        img.thumbnail(UPLOAD_SIZE, UPLOAD_SIZE)
    } else {
        img
    };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86)
        .encode_image(&img.to_rgb8())
        .ok()?;
    Some(out)
}

/// A public https link to the track's own cover. Each cover is uploaded once: links are
/// remembered by the image's hash (`cache/cover-upload.json`).
pub async fn upload_cover(path: &str) -> Option<String> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let hash = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(&bytes))
    };
    {
        let mut cache = UPLOAD_CACHE.lock().unwrap();
        let map = cache.get_or_insert_with(|| {
            std::fs::read_to_string(upload_cache_file())
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default()
        });
        if let Some(url) = map.get(&hash) {
            return Some(url.clone());
        }
        let failed = UPLOAD_FAILED.lock().unwrap();
        if failed.as_ref().and_then(|f| f.get(&hash)).map(|at| at.elapsed() < UPLOAD_RETRY).unwrap_or(false) {
            return None;
        }
    }
    let p = path.to_string();
    let jpeg = tokio::task::spawn_blocking(move || cover_jpeg(&p)).await.ok().flatten();
    let url = match jpeg {
        Some(jpeg) => send_cover(jpeg).await,
        None => None,
    };
    match &url {
        Some(u) => {
            let mut cache = UPLOAD_CACHE.lock().unwrap();
            let map = cache.get_or_insert_with(HashMap::new);
            map.insert(hash, u.clone());
            let _ = std::fs::write(upload_cache_file(), serde_json::to_string(map).unwrap_or_default());
        }
        None => {
            log::warn!("Discord: the cover could not be uploaded");
            UPLOAD_FAILED.lock().unwrap().get_or_insert_with(HashMap::new).insert(hash, Instant::now());
        }
    }
    url
}

async fn send_cover(jpeg: Vec<u8>) -> Option<String> {
    let part = reqwest::multipart::Part::bytes(jpeg).file_name("cover.jpg").mime_str("image/jpeg").ok()?;
    let form = reqwest::multipart::Form::new().text("reqtype", "fileupload").part("fileToUpload", part);
    let res = crate::net::client()
        .post(upload_url())
        .multipart(form)
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let text = res.text().await.ok()?;
    let url = text.trim();
    (url.starts_with("https://") && !url.contains(char::is_whitespace) && url.len() < 300).then(|| url.to_string())
}

/// Where Discord's cover comes from for a track without a public one: an online lookup
/// first, then the track's own cover uploaded, otherwise (`None`) Velvet's logo.
pub async fn find_cover(np: &NowPlaying, lookup: bool, upload: bool) -> Option<String> {
    if lookup && (!np.title.is_empty() || !np.artist.is_empty()) {
        if let Some(url) = lookup_cover_url(&np.artist, &np.title).await {
            return Some(url);
        }
    }
    let path = np.cover_path.as_deref().filter(|p| !p.is_empty())?;
    if upload {
        return upload_cover(path).await;
    }
    None
}

// ── presence state machine ─────────────────────────────────────────────────────

pub enum Msg {
    Configure(DiscordOptions),
    Update(Option<Box<NowPlaying>>),
    Cover(String, String),
    Shutdown(tokio::sync::oneshot::Sender<()>),
}

type StatusFn = Box<dyn Fn(&str, &str) + Send + Sync>;
type CoverFn = Box<dyn Fn(&str, &str) + Send + Sync>;

pub struct Presence<T: Transport> {
    t: T,
    opts: DiscordOptions,
    connected: bool,
    /// `Some(None)`: a clear is pending
    pending: Option<Option<NowPlaying>>,
    current: Option<NowPlaying>,
    last_sent: Option<Instant>,
    /// playing state of the last activity sent (`None`: none sent / cleared)
    last_playing: Option<bool>,
    retry_at: Option<Instant>,
    /// delay between clearing and re-sending on pause
    pause_gap: Duration,
    tx: UnboundedSender<Msg>,
    status: Arc<Mutex<String>>,
    on_status: StatusFn,
    on_cover: CoverFn,
    /// the track a cover is being (or was) looked for, so it's done once per track
    cover_for: Option<String>,
}

/// The user's own application if they set a valid one, otherwise Velvet's.
pub fn effective_id(opts: &DiscordOptions) -> &str {
    let own = opts.client_id.trim();
    if valid_client_id(own) {
        own
    } else {
        DEFAULT_CLIENT_ID
    }
}

fn valid_client_id(id: &str) -> bool {
    let id = id.trim();
    (15..=22).contains(&id.len()) && id.chars().all(|c| c.is_ascii_digit())
}

impl<T: Transport> Presence<T> {
    fn set_status(&self, status: &str, user: &str) {
        *self.status.lock().unwrap() = status.to_string();
        (self.on_status)(status, user);
    }

    fn wants_connection(&self) -> bool {
        self.opts.enabled
    }

    fn next_deadline(&self) -> Option<Instant> {
        if !self.connected {
            return if self.wants_connection() { self.retry_at } else { None };
        }
        self.pending.as_ref()?;
        Some(self.last_sent.map(|t| t + MIN_INTERVAL).unwrap_or_else(Instant::now))
    }

    async fn tick(&mut self) {
        let now = Instant::now();
        if !self.connected && self.wants_connection() && self.retry_at.map(|r| now >= r).unwrap_or(false) {
            self.connect().await;
        }
        if self.connected && self.pending.is_some() && self.last_sent.map(|t| now >= t + MIN_INTERVAL).unwrap_or(true) {
            self.flush().await;
        }
    }

    async fn connect(&mut self) {
        self.set_status("connecting", "");
        let id = effective_id(&self.opts).to_string();
        match self.t.connect(&id).await {
            Ok(user) => {
                self.connected = true;
                self.retry_at = None;
                self.set_status("connected", &user);
                // on connect the current presence (or an empty one) is sent right away
                self.pending = Some(self.current.clone());
                self.last_sent = None;
                self.last_playing = None;
                self.find_cover();
            }
            Err(_) => {
                self.t.close().await;
                self.set_status("error", "");
                self.retry_at = Some(Instant::now() + RETRY);
            }
        }
    }

    async fn disconnect(&mut self) {
        if self.connected {
            let _ = self.t.set_activity(None).await;
        }
        self.t.close().await;
        self.connected = false;
    }

    fn update(&mut self, p: Option<NowPlaying>) {
        self.current = p.clone();
        self.pending = Some(p);
        self.find_cover();
    }

    /// Looks for a public cover of the current track, once per track, and only while Discord is
    /// connected: nothing is looked up or uploaded for a presence nobody sees.
    fn find_cover(&mut self) {
        let Some(np) = self.current.as_ref().filter(|_| self.connected) else { return };
        let public = np.cover_url.as_deref().map(|u| u.starts_with("https://")).unwrap_or(false);
        let (lookup, upload) = (self.opts.lookup_covers, self.opts.upload_covers);
        if public || !(lookup || upload) || self.cover_for.as_deref() == Some(np.track_id.as_str()) {
            return;
        }
        self.cover_for = Some(np.track_id.clone());
        let (tx, np) = (self.tx.clone(), np.clone());
        tokio::spawn(async move {
            if let Some(url) = find_cover(&np, lookup, upload).await {
                let _ = tx.send(Msg::Cover(np.track_id, url));
            }
        });
    }

    async fn handle(&mut self, msg: Msg) -> bool {
        match msg {
            Msg::Configure(o) => {
                let reconnect = effective_id(&o) != effective_id(&self.opts) || o.enabled != self.opts.enabled;
                if o.lookup_covers != self.opts.lookup_covers || o.upload_covers != self.opts.upload_covers {
                    // the cover of the current track is looked for again with the new options
                    self.cover_for = None;
                }
                self.opts = o;
                if !reconnect {
                    if let Some(c) = self.current.clone() {
                        self.update(Some(c));
                    }
                    return true;
                }
                self.disconnect().await;
                self.retry_at = None;
                if !self.opts.enabled {
                    self.set_status("disabled", "");
                } else {
                    self.retry_at = Some(Instant::now());
                }
            }
            Msg::Update(p) => self.update(p.map(|b| *b)),
            Msg::Cover(id, url) => {
                (self.on_cover)(&id, &url);
                if let Some(c) = self.current.clone().filter(|c| c.track_id == id) {
                    self.update(Some(NowPlaying { cover_url: Some(url), ..c }));
                }
            }
            Msg::Shutdown(done) => {
                self.disconnect().await;
                let _ = done.send(());
                return false;
            }
        }
        true
    }

    async fn flush(&mut self) {
        let Some(p) = self.pending.take() else { return };
        self.last_sent = Some(Instant::now());
        let was_playing = self.last_playing;
        self.last_playing = p.as_ref().map(|p| p.playing);
        let result = async {
            let Some(p) = p.filter(|p| p.playing || !self.opts.hide_when_paused) else {
                return self.t.set_activity(None).await;
            };
            if !p.playing && was_playing != Some(false) {
                // Discord keeps counting the previous activity's time unless the activity is
                // re-created, so on pause it is cleared first and sent again without timestamps
                self.t.set_activity(None).await?;
                tokio::time::sleep(self.pause_gap).await;
            }
            let a = build_activity(&p, self.opts.show_speed, self.opts.show_buttons, crate::types::now_ms());
            self.t.set_activity(Some(a)).await
        }
        .await;
        if result.is_err() {
            // the pipe broke (Discord closed or restarted): reconnect and send again
            self.last_playing = was_playing;
            self.t.close().await;
            self.connected = false;
            self.set_status("connecting", "");
            self.retry_at = Some(Instant::now() + RETRY);
        }
    }

    pub async fn run(mut self, mut rx: UnboundedReceiver<Msg>) {
        loop {
            let msg = match self.next_deadline() {
                Some(at) => tokio::select! {
                    m = rx.recv() => m,
                    _ = tokio::time::sleep_until(at) => { self.tick().await; continue }
                },
                None => rx.recv().await,
            };
            let Some(msg) = msg else { break };
            if !self.handle(msg).await {
                break;
            }
            self.tick().await;
        }
    }
}

/// The handle the app keeps: messages go to the presence task.
pub struct Discord {
    tx: UnboundedSender<Msg>,
    status: Arc<Mutex<String>>,
}

impl Discord {
    pub fn start<T: Transport + 'static>(t: T, on_status: StatusFn, on_cover: CoverFn) -> Self {
        let (tx, rx) = unbounded_channel();
        let status = Arc::new(Mutex::new("disabled".to_string()));
        let p = Presence {
            t,
            opts: DiscordOptions::default(),
            connected: false,
            pending: None,
            current: None,
            last_sent: None,
            last_playing: None,
            retry_at: None,
            pause_gap: Duration::from_millis(200),
            tx: tx.clone(),
            status: status.clone(),
            on_status,
            on_cover,
            cover_for: None,
        };
        crate::spawn(p.run(rx));
        Self { tx, status }
    }

    pub fn configure(&self, o: DiscordOptions) {
        let _ = self.tx.send(Msg::Configure(o));
    }

    pub fn update(&self, p: Option<NowPlaying>) {
        let _ = self.tx.send(Msg::Update(p.map(Box::new)));
    }

    pub fn status(&self) -> String {
        self.status.lock().unwrap().clone()
    }

    /// Clears the activity before the app quits.
    pub async fn shutdown(&self) {
        let (done, wait) = tokio::sync::oneshot::channel();
        if self.tx.send(Msg::Shutdown(done)).is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(2), wait).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings_ru() -> MainStrings {
        MainStrings {
            paused: "Пауза".into(),
            playing: "Играет".into(),
            open_on: "Открыть в".into(),
            ..MainStrings::english()
        }
    }

    fn base() -> NowPlaying {
        NowPlaying {
            track_id: "t".into(),
            title: "Midnight Drive".into(),
            artist: "Neon Coast".into(),
            album: "Afterglow".into(),
            cover_url: Some("https://i1.sndcdn.com/artworks-x-t500x500.jpg".into()),
            cover_path: None,
            source_url: Some("https://soundcloud.com/neon/midnight-drive".into()),
            duration: 200.0,
            position: 50.0,
            rate: 1.0,
            playing: true,
            language: "ru".into(),
            strings: Some(strings_ru()),
        }
    }

    #[test]
    fn builds_a_listening_activity() {
        let a = build_activity(&base(), true, true, 1_000_000);
        assert_eq!(a["type"], 2);
        assert_eq!(a["details"], "Midnight Drive");
        assert_eq!(a["state"], "Neon Coast");
        assert_eq!(a["assets"]["large_image"], "https://i1.sndcdn.com/artworks-x-t500x500.jpg");
        assert_eq!(a["assets"]["large_text"], "Afterglow");
        assert_eq!(a["assets"]["small_image"], format!("{ASSETS}/playing.png"));
        assert_eq!(a["assets"]["small_text"], "Играет");
        assert_eq!(a["timestamps"]["start"], 1_000_000 - 50_000);
        assert_eq!(a["timestamps"]["end"], 1_000_000 + 150_000);
        assert_eq!(
            a["buttons"][0],
            json!({ "label": "Открыть в SoundCloud", "url": "https://soundcloud.com/neon/midnight-drive" })
        );
    }

    #[test]
    fn scales_the_progress_bar_by_rate() {
        let a = build_activity(&NowPlaying { rate: 0.8, ..base() }, true, false, 0);
        // 200 s at 0.8x lasts 250 s of wall-clock time
        assert_eq!(
            a["timestamps"]["end"].as_i64().unwrap() - a["timestamps"]["start"].as_i64().unwrap(),
            250_000
        );
        assert_eq!(a["assets"]["large_text"], "Afterglow · 0.8x");
        assert!(a.get("buttons").is_none());
    }

    #[test]
    fn uses_the_logo_and_no_timer_when_paused() {
        let a = build_activity(
            &NowPlaying {
                cover_url: None,
                playing: false,
                strings: Some(MainStrings::english()),
                ..base()
            },
            false,
            true,
            0,
        );
        assert_eq!(a["assets"]["large_image"], format!("{ASSETS}/logo.png"));
        assert_eq!(a["assets"]["small_image"], format!("{ASSETS}/paused.png"));
        assert_eq!(a["assets"]["small_text"], "Paused");
        assert_eq!(a["state"], "⏸ Paused · Neon Coast");
        assert_eq!(a["assets"]["large_text"], "⏸ Paused");
        assert!(a.get("timestamps").is_none());
    }

    #[derive(Clone, Default)]
    struct Fake {
        calls: Arc<Mutex<Vec<&'static str>>>,
        acts: Arc<Mutex<Vec<Value>>>,
        ids: Arc<Mutex<Vec<String>>>,
    }

    impl Transport for Fake {
        async fn connect(&mut self, id: &str) -> Result<String, String> {
            self.ids.lock().unwrap().push(id.to_string());
            Ok("tester".into())
        }
        async fn set_activity(&mut self, a: Option<Value>) -> Result<(), String> {
            match a {
                Some(a) => {
                    self.calls.lock().unwrap().push("set");
                    self.acts.lock().unwrap().push(a);
                }
                None => self.calls.lock().unwrap().push("clear"),
            }
            Ok(())
        }
        async fn close(&mut self) {}
    }

    async fn connected(hide_when_paused: bool) -> (Discord, Fake) {
        let fake = Fake::default();
        let d = Discord::start(fake.clone(), Box::new(|_, _| {}), Box::new(|_, _| {}));
        d.configure(DiscordOptions {
            enabled: true,
            client_id: "123456789012345678".into(),
            show_speed: true,
            show_buttons: true,
            lookup_covers: false,
            upload_covers: false,
            hide_when_paused,
        });
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(d.status(), "connected");
        // on connect an empty presence is cleared once; count from here
        fake.calls.lock().unwrap().clear();
        fake.acts.lock().unwrap().clear();
        (d, fake)
    }

    fn paused_np() -> NowPlaying {
        NowPlaying {
            title: "nakolki".into(),
            artist: "Платон Чебурин".into(),
            playing: false,
            ..base()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn recreates_the_activity_without_a_timer_when_paused() {
        let (d, fake) = connected(false).await;
        d.update(Some(NowPlaying {
            playing: true,
            ..paused_np()
        }));
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(*fake.calls.lock().unwrap(), vec!["set"]);
        assert!(fake.acts.lock().unwrap()[0].get("timestamps").is_some());

        d.update(Some(paused_np()));
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(*fake.calls.lock().unwrap(), vec!["set", "clear", "set"]);
        let paused = fake.acts.lock().unwrap()[1].clone();
        assert!(paused.get("timestamps").is_none());
        assert_eq!(paused["state"], "⏸ Пауза · Платон Чебурин");

        // resuming sends a normal activity with timestamps again
        d.update(Some(NowPlaying {
            playing: true,
            position: 7.0,
            ..paused_np()
        }));
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(*fake.calls.lock().unwrap(), vec!["set", "clear", "set", "set"]);
        assert!(fake.acts.lock().unwrap()[2].get("timestamps").is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn can_hide_the_activity_while_paused() {
        let (d, fake) = connected(true).await;
        d.update(Some(NowPlaying {
            playing: true,
            ..paused_np()
        }));
        tokio::time::sleep(Duration::from_secs(3)).await;
        d.update(Some(paused_np()));
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(*fake.calls.lock().unwrap(), vec!["set", "clear"]);
    }

    #[test]
    fn uses_velvets_own_application_unless_one_is_set() {
        let with = |id: &str| DiscordOptions {
            client_id: id.into(),
            ..Default::default()
        };
        assert_eq!(effective_id(&with("")), DEFAULT_CLIENT_ID);
        assert_eq!(effective_id(&with("abc")), DEFAULT_CLIENT_ID);
        assert_eq!(effective_id(&with(" 123456789012345678 ")), "123456789012345678");
    }

    #[tokio::test(start_paused = true)]
    async fn connects_out_of_the_box_and_switches_to_an_own_application() {
        let fake = Fake::default();
        let d = Discord::start(fake.clone(), Box::new(|_, _| {}), Box::new(|_, _| {}));
        // default settings: enabled, no Application ID
        d.configure(DiscordOptions {
            enabled: true,
            ..Default::default()
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(d.status(), "connected");
        // an own application replaces Velvet's; typing garbage goes back to Velvet's
        d.configure(DiscordOptions {
            enabled: true,
            client_id: "123456789012345678".into(),
            ..Default::default()
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        d.configure(DiscordOptions {
            enabled: true,
            client_id: "12".into(),
            ..Default::default()
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            *fake.ids.lock().unwrap(),
            vec![DEFAULT_CLIENT_ID.to_string(), "123456789012345678".into(), DEFAULT_CLIENT_ID.into()]
        );
        // switching it off and on reconnects with the same one
        d.configure(DiscordOptions {
            enabled: false,
            ..Default::default()
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(d.status(), "disabled");
    }

    // ── covers: lookup → own cover uploaded → logo ─────────────────────────────

    struct CoverEnv {
        dir: std::path::PathBuf,
    }

    impl CoverEnv {
        fn new(upload: &str, itunes: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("velvet-cover-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            std::env::set_var("VELVET_DATA_DIR", &dir);
            std::env::set_var("VELVET_COVER_UPLOAD_URL", upload);
            std::env::set_var("VELVET_ITUNES_URL", itunes);
            *UPLOAD_CACHE.lock().unwrap() = None;
            *UPLOAD_FAILED.lock().unwrap() = None;
            *COVER_CACHE.lock().unwrap() = None;
            Self { dir }
        }

        /// A 900×600 PNG cover like the ones in the covers folder.
        fn cover(&self, seed: u8) -> String {
            let img = image::RgbImage::from_fn(900, 600, |x, y| image::Rgb([seed, (x % 255) as u8, (y % 255) as u8]));
            let p = self.dir.join(format!("cover-{seed}.png"));
            img.save(&p).unwrap();
            p.to_string_lossy().into_owned()
        }
    }

    impl Drop for CoverEnv {
        fn drop(&mut self) {
            for k in ["VELVET_DATA_DIR", "VELVET_COVER_UPLOAD_URL", "VELVET_ITUNES_URL"] {
                std::env::remove_var(k);
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn local(path: Option<String>) -> NowPlaying {
        NowPlaying {
            track_id: "local-1".into(),
            cover_url: None,
            cover_path: path,
            source_url: None,
            ..base()
        }
    }

    #[tokio::test]
    async fn uploads_the_tracks_own_cover_once_when_nothing_is_found_online() {
        let _env = crate::paths::TEST_ENV.lock().await;
        let mock = crate::testutil::serve(vec![
            ("/itunes", 200, json!({ "results": [] }).to_string()),
            ("/upload", 200, "https://files.catbox.moe/ab12cd.jpg\n".into()),
        ])
        .await;
        let env = CoverEnv::new(&format!("{}/upload", mock.base), &format!("{}/itunes", mock.base));
        let np = local(Some(env.cover(10)));

        assert_eq!(find_cover(&np, true, true).await.as_deref(), Some("https://files.catbox.moe/ab12cd.jpg"));
        {
            let seen = mock.seen.lock().unwrap();
            assert!(seen[0].line.starts_with("GET /itunes"), "the online lookup comes first");
            let up = &seen[1];
            assert!(up.line.starts_with("POST /upload"));
            let body = String::from_utf8_lossy(&up.body);
            assert!(body.contains("name=\"reqtype\"") && body.contains("fileupload") && body.contains("name=\"fileToUpload\""));
            // a small JPEG, not the original PNG
            let jpeg_at = up.body.windows(3).position(|w| w == [0xFF, 0xD8, 0xFF]).expect("jpeg data");
            let img = image::load_from_memory(&up.body[jpeg_at..]).unwrap();
            assert_eq!((img.width(), img.height()), (512, 341));
        }
        // the same image again (another track, after a restart) reuses the link
        *UPLOAD_CACHE.lock().unwrap() = None;
        assert_eq!(find_cover(&np, false, true).await.as_deref(), Some("https://files.catbox.moe/ab12cd.jpg"));
        assert_eq!(mock.seen.lock().unwrap().len(), 2);
        assert!(std::fs::read_to_string(env.dir.join("cache/cover-upload.json")).unwrap().contains("ab12cd"));
    }

    #[tokio::test]
    async fn prefers_a_cover_found_online_and_falls_back_to_the_logo() {
        let _env = crate::paths::TEST_ENV.lock().await;
        let found = json!({ "results": [{ "trackName": "Midnight Drive", "artworkUrl100": "https://is1-ssl.mzstatic.com/a/100x100bb.jpg" }] });
        let mock = crate::testutil::serve(vec![("/itunes", 200, found.to_string()), ("/upload", 500, "down".into())]).await;
        let env = CoverEnv::new(&format!("{}/upload", mock.base), &format!("{}/itunes", mock.base));
        let np = local(Some(env.cover(20)));
        assert_eq!(find_cover(&np, true, true).await.as_deref(), Some("https://is1-ssl.mzstatic.com/a/600x600bb.jpg"));
        assert_eq!(mock.seen.lock().unwrap().len(), 1, "nothing uploaded");

        // lookup off and the upload host down: the logo (None), and no retry on every pause
        assert_eq!(find_cover(&np, false, true).await, None);
        assert_eq!(find_cover(&np, false, true).await, None);
        assert_eq!(mock.seen.lock().unwrap().len(), 2);
        // no own cover, or uploading switched off: the logo
        assert_eq!(find_cover(&local(None), false, true).await, None);
        assert_eq!(find_cover(&local(Some(env.cover(30))), false, false).await, None);
        assert_eq!(mock.seen.lock().unwrap().len(), 2);
        let a = build_activity(&local(None), false, false, 0);
        assert_eq!(a["assets"]["large_image"], format!("{ASSETS}/logo.png"));
    }

    #[tokio::test]
    async fn the_presence_shows_the_uploaded_cover() {
        let _env = crate::paths::TEST_ENV.lock().await;
        let mock = crate::testutil::serve(vec![("/upload", 200, "https://files.catbox.moe/zz99.jpg".into())]).await;
        let env = CoverEnv::new(&format!("{}/upload", mock.base), &format!("{}/itunes", mock.base));
        let fake = Fake::default();
        let covers = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let seen = covers.clone();
        let d = Discord::start(
            fake.clone(),
            Box::new(|_, _| {}),
            Box::new(move |id, url| seen.lock().unwrap().push((id.to_string(), url.to_string()))),
        );
        // Discord off: nothing is looked up or uploaded
        d.configure(DiscordOptions {
            enabled: false,
            upload_covers: true,
            ..Default::default()
        });
        d.update(Some(local(Some(env.cover(40)))));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(mock.seen.lock().unwrap().is_empty());
        assert!(covers.lock().unwrap().is_empty());
        // once connected, the playing track's cover is uploaded
        d.configure(DiscordOptions {
            enabled: true,
            upload_covers: true,
            ..Default::default()
        });
        for _ in 0..100 {
            if fake.acts.lock().unwrap().iter().any(|a| a["assets"]["large_image"] == "https://files.catbox.moe/zz99.jpg") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(*covers.lock().unwrap(), vec![("local-1".to_string(), "https://files.catbox.moe/zz99.jpg".to_string())]);
        assert!(fake.acts.lock().unwrap().iter().any(|a| a["assets"]["large_image"] == "https://files.catbox.moe/zz99.jpg"));
        // further updates of the same track don't start another upload
        d.update(Some(NowPlaying { playing: false, ..local(Some(env.cover(40))) }));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(mock.seen.lock().unwrap().len(), 1);
    }
}
