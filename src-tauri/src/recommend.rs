//! Recommendations from what the user listens to (the seeds are picked by the UI, see
//! `src/lib/recommend.ts`):
//!
//! - YouTube: the "Mix" (radio) YouTube builds for a track, read with yt-dlp.
//! - SoundCloud: the "related tracks" SoundCloud shows under a track, read with yt-dlp; their
//!   artwork and artist come from SoundCloud's public oEmbed.
//! - Spotify: Spotify closed its recommendations, related-artists and top-tracks endpoints to apps
//!   like this one, so similar artists come from Deezer's public API (no keys) and their tracks are
//!   found with Spotify search, using the user's own keys.

use crate::links::parse_music_link;
use crate::net::client;
use crate::search::to_results;
use crate::spotify::{self, SpotifyKeys};
use crate::tools::{require_ytdlp, ytdlp_json};
use crate::types::SearchResult;
use futures_util::future::join_all;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// Seeds used per request: each one is a yt-dlp run or a few API calls.
const MAX_SEEDS: usize = 3;
const MAX_RESULTS: usize = 40;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Seed {
    pub artist: String,
    pub title: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RecommendRequest {
    pub source: String,
    pub seeds: Vec<Seed>,
    pub spotify: Option<SpotifyKeys>,
}

/// "Øneheart — Snowfall (Slowed)" and "oneheart snowfall slowed" are the same track here.
pub fn track_key(artist: &str, title: &str) -> String {
    let norm = |s: &str| {
        s.to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { ' ' })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let artist = norm(artist.split([',', '&']).next().unwrap_or(""));
    format!("{artist}|{}", norm(title))
}

/// Takes from each list in turn (so every seed is represented near the top), without
/// duplicates and without the seeds themselves.
pub fn interleave(lists: Vec<Vec<SearchResult>>, seeds: &[Seed], max: usize) -> Vec<SearchResult> {
    let mut seen: HashSet<String> = seeds.iter().map(|s| track_key(&s.artist, &s.title)).collect();
    let mut ids = HashSet::new();
    let mut iters: Vec<_> = lists.into_iter().map(|l| l.into_iter()).collect();
    let mut out = Vec::new();
    loop {
        let mut any = false;
        for it in iters.iter_mut() {
            let Some(r) = it.next() else { continue };
            any = true;
            if ids.insert(r.id.clone()) && seen.insert(track_key(&r.artist, &r.title)) {
                out.push(r);
            }
        }
        if !any || out.len() >= max {
            break;
        }
    }
    out.truncate(max);
    out
}

pub async fn recommend(req: RecommendRequest) -> Result<Vec<SearchResult>, String> {
    let seeds: Vec<Seed> = req
        .seeds
        .into_iter()
        .filter(|s| !s.title.trim().is_empty() || !s.artist.trim().is_empty())
        .take(MAX_SEEDS)
        .collect();
    if seeds.is_empty() {
        return Ok(Vec::new());
    }
    let lists: Vec<Result<Vec<SearchResult>, String>> = match req.source.as_str() {
        "spotify" => {
            let keys = req.spotify.unwrap_or_default();
            if !keys.usable() {
                return Err(spotify::NO_KEYS.into());
            }
            spotify_lists(&seeds, &keys).await
        }
        "soundcloud" => {
            let bin = require_ytdlp().await?;
            join_all(seeds.iter().map(|s| soundcloud_related(&bin, s))).await
        }
        _ => {
            let bin = require_ytdlp().await?;
            join_all(seeds.iter().map(|s| youtube_mix(&bin, s))).await
        }
    };
    let first_error = lists.iter().find_map(|l| l.as_ref().err().cloned());
    let found: Vec<Vec<SearchResult>> = lists.into_iter().filter_map(Result::ok).collect();
    let out = interleave(found, &seeds, MAX_RESULTS);
    match (out.is_empty(), first_error) {
        (true, Some(e)) => Err(e),
        _ => Ok(out),
    }
}

fn entries(v: &Value) -> Vec<Value> {
    v.get("entries").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn seed_query(s: &Seed) -> String {
    format!("{} {}", s.artist, s.title).trim().to_string()
}

// ── YouTube ────────────────────────────────────────────────────────────────────

/// The video id of a YouTube watch / youtu.be / music.youtube.com link.
pub fn youtube_id(link: &str) -> Option<String> {
    let info = parse_music_link(link).filter(|l| l.service == "youtube" && l.kind == "track")?;
    let url = url::Url::parse(&info.url).ok()?;
    let id = url
        .query_pairs()
        .find(|(k, _)| k == "v")
        .map(|(_, v)| v.into_owned())
        .or_else(|| {
            let parts: Vec<&str> = url.path().split('/').filter(|p| !p.is_empty()).collect();
            match parts.as_slice() {
                ["shorts", id, ..] => Some(id.to_string()),
                [id] if url.host_str() == Some("youtu.be") => Some(id.to_string()),
                _ => None,
            }
        })?;
    (id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then_some(id)
}

async fn youtube_mix(bin: &str, seed: &Seed) -> Result<Vec<SearchResult>, String> {
    let id = match seed.url.as_deref().and_then(youtube_id) {
        Some(id) => id,
        None => {
            let v = ytdlp_json(bin, &["--flat-playlist".into(), format!("ytsearch1:{} audio", seed_query(seed))], Duration::from_secs(60)).await?;
            entries(&v)
                .first()
                .and_then(|e| e.get("id").and_then(Value::as_str))
                .map(String::from)
                .ok_or_else(|| "nothing found".to_string())?
        }
    };
    let mix = format!("https://www.youtube.com/watch?v={id}&list=RD{id}");
    let v = ytdlp_json(bin, &["--flat-playlist".into(), "--playlist-end".into(), "25".into(), mix], Duration::from_secs(90)).await?;
    Ok(to_results(&entries(&v), "youtube")
        .into_iter()
        .filter(|r| r.id != format!("youtube:{id}"))
        .collect())
}

// ── SoundCloud ─────────────────────────────────────────────────────────────────

fn soundcloud_track(link: &str) -> Option<String> {
    parse_music_link(link)
        .filter(|l| l.service == "soundcloud" && l.kind == "track")
        .map(|l| l.url)
}

/// `https://soundcloud.com/oneheart/snowfall` → "oneheart" (when nothing better is known).
fn slug_artist(url: &str) -> String {
    url.trim_start_matches("https://soundcloud.com/").split('/').next().unwrap_or("").replace(['-', '_'], " ")
}

/// Fills artist and artwork from SoundCloud's oEmbed ("<title> by <artist>").
pub fn apply_oembed(r: &mut SearchResult, v: &Value) {
    let author = v.get("author_name").and_then(Value::as_str).unwrap_or("").trim();
    let title = v.get("title").and_then(Value::as_str).unwrap_or("").trim();
    if !author.is_empty() {
        r.artist = author.to_string();
        let suffix = format!(" by {author}");
        if let Some(t) = title.strip_suffix(&suffix).filter(|t| !t.is_empty()) {
            r.title = t.to_string();
        }
    }
    if let Some(thumb) = v.get("thumbnail_url").and_then(Value::as_str).filter(|u| u.starts_with("https://")) {
        r.thumbnail = Some(thumb.to_string());
    }
}

fn oembed_url() -> String {
    std::env::var("VELVET_SC_OEMBED").unwrap_or_else(|_| "https://soundcloud.com/oembed".into())
}

async fn oembed(r: &mut SearchResult) {
    let res = client()
        .get(oembed_url())
        .query(&[("format", "json"), ("url", r.url.as_str())])
        .timeout(Duration::from_secs(8))
        .send()
        .await;
    if let Ok(res) = res {
        if let Ok(v) = res.json::<Value>().await {
            apply_oembed(r, &v);
        }
    }
}

async fn soundcloud_related(bin: &str, seed: &Seed) -> Result<Vec<SearchResult>, String> {
    let track = match seed.url.as_deref().and_then(soundcloud_track) {
        Some(u) => u,
        None => {
            let v = ytdlp_json(bin, &["--flat-playlist".into(), format!("scsearch1:{}", seed_query(seed))], Duration::from_secs(60)).await?;
            entries(&v)
                .first()
                .and_then(|e| e.get("webpage_url").or(e.get("url")).and_then(Value::as_str))
                .and_then(soundcloud_track)
                .ok_or_else(|| "nothing found".to_string())?
        }
    };
    let related = format!("{}/recommended", track.trim_end_matches('/'));
    let v = ytdlp_json(bin, &["--flat-playlist".into(), "--playlist-end".into(), "15".into(), related], Duration::from_secs(90)).await?;
    let mut results = to_results(&entries(&v), "soundcloud");
    // flat related entries carry little more than the link and title
    for r in results.iter_mut().filter(|r| r.artist.is_empty()) {
        r.artist = slug_artist(&r.url);
    }
    join_all(results.iter_mut().filter(|r| r.thumbnail.is_none()).map(oembed)).await;
    Ok(results)
}

// ── Spotify ────────────────────────────────────────────────────────────────────

fn deezer_api() -> String {
    std::env::var("VELVET_DEEZER_API").unwrap_or_else(|_| "https://api.deezer.com".into())
}

async fn deezer_json(path: &str, query: &[(&str, &str)]) -> Option<Value> {
    let res = client()
        .get(format!("{}{path}", deezer_api()))
        .query(query)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    res.status().is_success().then_some(())?;
    res.json().await.ok()
}

/// Artists Deezer considers similar to `name` (empty when Deezer doesn't know them).
pub async fn similar_artists(name: &str, max: usize) -> Vec<String> {
    let Some(found) = deezer_json("/search/artist", &[("q", name), ("limit", "1")]).await else {
        return Vec::new();
    };
    let Some(id) = found.pointer("/data/0/id").and_then(Value::as_u64) else {
        return Vec::new();
    };
    let Some(related) = deezer_json(&format!("/artist/{id}/related"), &[("limit", "10")]).await else {
        return Vec::new();
    };
    related
        .get("data")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get("name").and_then(Value::as_str)).map(String::from).take(max).collect())
        .unwrap_or_default()
}

fn same_artist(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    a.split(", ").any(|x| x.trim() == b.trim())
}

async fn artist_tracks(name: String, n: usize, keys: &SpotifyKeys) -> Result<Vec<SearchResult>, String> {
    let found = spotify::search(&format!("artist:\"{}\"", name.replace('"', "")), n + 2, keys).await?;
    Ok(found.into_iter().filter(|r| same_artist(&r.artist, &name)).take(n).collect())
}

async fn spotify_lists(seeds: &[Seed], keys: &SpotifyKeys) -> Vec<Result<Vec<SearchResult>, String>> {
    let mut artists: Vec<String> = Vec::new();
    for s in seeds {
        let a = s.artist.split([',', '&']).next().unwrap_or("").trim().to_string();
        if !a.is_empty() && !artists.iter().any(|x| x.eq_ignore_ascii_case(&a)) {
            artists.push(a);
        }
    }
    let similar = join_all(artists.iter().map(|a| similar_artists(a, 4))).await;
    // similar artists first (that's the discovery), then more of the seed artists themselves
    let mut plan: Vec<(String, usize)> = Vec::new();
    for (i, a) in artists.iter().enumerate() {
        for s in &similar[i] {
            if !plan.iter().any(|(x, _)| x.eq_ignore_ascii_case(s)) && !artists.iter().any(|x| x.eq_ignore_ascii_case(s)) {
                plan.push((s.clone(), 3));
            }
        }
        plan.push((a.clone(), if similar[i].is_empty() { 8 } else { 3 }));
    }
    join_all(plan.into_iter().map(|(name, n)| artist_tracks(name, n, keys))).await
}

// ── the fast path: your whole taste profile through Deezer's graph of similar artists ──

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Weighted {
    pub name: String,
    pub weight: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FastRequest {
    /// "youtube" | "soundcloud" | "spotify": where the results are downloaded from
    pub source: String,
    /// the user's artists, strongest first (see `src/lib/taste.ts`)
    pub artists: Vec<Weighted>,
    /// artists the user turned down
    pub exclude_artists: Vec<String>,
    /// `track_key`s not to suggest (turned down, or already in the library)
    pub exclude_keys: Vec<String>,
    /// share of new songs by the user's own artists (0..1)
    pub familiar: f64,
    pub limit: usize,
    pub spotify: Option<SpotifyKeys>,
}

/// Fails over to the yt-dlp path in the UI.
pub const DEEZER_DOWN: &str = "deezer-unavailable";

fn simple(s: &str) -> String {
    crate::matcher::normalize(s.split([',', '&']).next().unwrap_or(""))
}

fn to_result(t: &crate::deezer::DzTrack, source: &str, because: Option<&str>) -> SearchResult {
    SearchResult {
        id: format!("deezer:{}", t.id),
        title: t.title.clone(),
        artist: t.artist.clone(),
        duration: t.duration,
        url: t.link.clone(),
        thumbnail: t.cover.clone(),
        source: source.to_string(),
        preview: t.preview.clone(),
        album: Some(t.album.clone()).filter(|a| !a.is_empty()),
        cover_big: t.cover_big.clone(),
        because: because.map(String::from),
        genre: None,
    }
}

/// Reorders so the same artist doesn't play twice in a row when it can be avoided.
pub fn spread_artists(list: Vec<SearchResult>) -> Vec<SearchResult> {
    let mut rest: std::collections::VecDeque<SearchResult> = list.into();
    let mut out: Vec<SearchResult> = Vec::with_capacity(rest.len());
    while let Some(first) = rest.pop_front() {
        let last = out.last().map(|r| simple(&r.artist));
        if last.as_deref() == Some(simple(&first.artist).as_str()) {
            if let Some(pos) = rest.iter().position(|r| Some(simple(&r.artist)) != last) {
                let other = rest.remove(pos).unwrap();
                rest.push_front(first);
                out.push(other);
                continue;
            }
        }
        out.push(first);
    }
    out
}

/// Recommendations in a second or two (instantly from the cache): artists similar to many of
/// yours rank highest, then their best-known songs; ≤2 songs per artist; nothing turned down.
pub async fn fast(req: FastRequest) -> Result<Vec<SearchResult>, String> {
    use crate::deezer;
    let limit = req.limit.clamp(5, 80);
    let banned: HashSet<String> = req.exclude_artists.iter().map(|a| simple(a)).collect();
    let skip_keys: HashSet<String> = req.exclude_keys.iter().cloned().collect();
    let seeds: Vec<&Weighted> = req
        .artists
        .iter()
        .filter(|a| !a.name.trim().is_empty() && a.weight > 0.0 && !banned.contains(&simple(&a.name)))
        .take(12)
        .collect();
    if seeds.is_empty() {
        return Ok(Vec::new());
    }
    let max_w = seeds.iter().map(|s| s.weight).fold(0.0, f64::max).max(1e-9);
    let ids = join_all(seeds.iter().map(|s| deezer::artist_id(&s.name))).await;
    if ids.iter().all(Option::is_none) {
        // none of the names is an artist Deezer knows (uploader nicknames…), or it can't be reached
        return if deezer::reachable().await { Ok(Vec::new()) } else { Err(DEEZER_DOWN.into()) };
    }
    let seed_names: HashSet<String> = seeds.iter().map(|s| simple(&s.name)).collect();
    let related = join_all(ids.iter().map(|id| async move {
        match id {
            Some(i) => deezer::related(*i, 20).await,
            None => Vec::new(),
        }
    }))
    .await;

    // artist id → (name, score, the seed that contributed most)
    let mut cands: HashMap<u64, (String, f64, String, f64)> = HashMap::new();
    for (si, list) in related.iter().enumerate() {
        let w = seeds[si].weight / max_w;
        let n = list.len().max(1) as f64;
        for (pos, (aid, name)) in list.iter().enumerate() {
            let key = simple(name);
            if seed_names.contains(&key) || banned.contains(&key) {
                continue;
            }
            let add = w * (1.0 - pos as f64 / n).powf(0.7);
            let e = cands.entry(*aid).or_insert_with(|| (name.clone(), 0.0, seeds[si].name.clone(), 0.0));
            e.1 += add;
            if add > e.3 {
                e.3 = add;
                e.2 = seeds[si].name.clone();
            }
        }
    }
    let mut new_artists: Vec<(u64, String, f64, String)> = cands.into_iter().map(|(id, (n, s, b, _))| (id, n, s, b)).collect();
    new_artists.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    new_artists.truncate((limit * 2 / 3).clamp(8, 30));
    let familiar_n = ((limit as f64 * req.familiar.clamp(0.0, 1.0)) / 2.0).ceil() as usize;
    let familiar: Vec<(u64, String, f64, String)> = seeds
        .iter()
        .zip(&ids)
        .filter_map(|(s, id)| Some((((*id)?), s.name.clone(), 0.6 * s.weight / max_w, s.name.clone())))
        .take(familiar_n)
        .collect();
    let fam_ids: HashSet<u64> = familiar.iter().map(|f| f.0).collect();
    let artists: Vec<(u64, String, f64, String)> = new_artists.into_iter().chain(familiar).collect();
    let tops = join_all(artists.iter().map(|a| deezer::top(a.0, 6))).await;
    deezer::save_cache();
    if !artists.is_empty() && tops.iter().all(Vec::is_empty) {
        // the artists were known but nothing more came back: Deezer went away mid-way
        return Err(DEEZER_DOWN.into());
    }

    let max_rank = tops.iter().flatten().map(|t| t.rank).max().unwrap_or(1).max(1) as f64;
    let mut scored: Vec<(f64, &crate::deezer::DzTrack, &str, bool)> = Vec::new();
    for (ai, list) in tops.iter().enumerate() {
        let (aid, _, ascore, because) = &artists[ai];
        let is_familiar = fam_ids.contains(aid);
        let mut taken = 0;
        for (i, t) in list.iter().enumerate() {
            if taken >= 2 {
                break;
            }
            if skip_keys.contains(&track_key(&t.artist, &t.title)) || banned.contains(&simple(&t.artist)) {
                continue;
            }
            let pop = (t.rank as f64 / max_rank).sqrt();
            scored.push((ascore * (0.7 + 0.3 * pop) / (1.0 + 0.35 * i as f64), t, because.as_str(), is_familiar));
            taken += 1;
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let fam_cap = (limit as f64 * req.familiar.clamp(0.0, 1.0)).round() as usize;
    let (mut fam_count, mut seen) = (0usize, HashSet::new());
    let mut picked = Vec::new();
    for (_, t, because, is_fam) in scored {
        if picked.len() >= limit {
            break;
        }
        if is_fam && fam_count >= fam_cap {
            continue;
        }
        if !seen.insert(track_key(&t.artist, &t.title)) {
            continue;
        }
        fam_count += is_fam as usize;
        picked.push(to_result(t, &req.source, (!is_fam).then_some(because)));
    }
    let picked = spread_artists(picked);
    if req.source == "spotify" {
        return to_spotify(picked, &req.spotify.unwrap_or_default()).await;
    }
    Ok(picked)
}

/// The same songs as Spotify links (for downloading through the Spotify import).
async fn to_spotify(list: Vec<SearchResult>, keys: &SpotifyKeys) -> Result<Vec<SearchResult>, String> {
    use futures_util::stream::{self, StreamExt};
    if !keys.usable() {
        return Err(spotify::NO_KEYS.into());
    }
    let found: Vec<(SearchResult, Result<Vec<SearchResult>, String>)> = stream::iter(list)
        .map(|r| async move {
            let artist = r.artist.split([',', '&']).next().unwrap_or("").trim().replace('"', "");
            let q = format!("track:\"{}\" artist:\"{artist}\"", r.title.replace('"', ""));
            let hits = spotify::search(&q, 3, keys).await;
            (r, hits)
        })
        .buffered(5)
        .collect()
        .await;
    let mut out = Vec::new();
    let mut first_err = None;
    for (r, hits) in found {
        match hits {
            Ok(hits) => {
                let want = (crate::matcher::normalize(&r.title), simple(&r.artist));
                if let Some(h) = hits
                    .into_iter()
                    .find(|h| crate::matcher::normalize(&h.title) == want.0 && simple(&h.artist) == want.1)
                {
                    out.push(SearchResult { id: h.id, url: h.url, thumbnail: h.thumbnail.or(r.thumbnail), source: "spotify".into(), ..r });
                }
            }
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    match (out.is_empty(), first_err) {
        (true, Some(e)) => Err(e),
        _ => Ok(out),
    }
}

// ── songs like the user's own songs, from the service itself ────────────────────

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WaveRequest {
    /// "soundcloud" | "youtube": whose "related tracks" to use
    pub source: String,
    /// the user's songs to start from (up to 4)
    pub seeds: Vec<Seed>,
    pub exclude_keys: Vec<String>,
    pub exclude_artists: Vec<String>,
    /// try the other service for a seed the chosen one doesn't know
    pub fallback: bool,
    pub limit: usize,
}

/// What the UI calls a seed (and gets back in `because`).
pub fn seed_label(s: &Seed) -> String {
    if s.artist.trim().is_empty() {
        s.title.trim().to_string()
    } else {
        format!("{} — {}", s.artist.trim(), s.title.trim())
    }
}

static JUNK_TITLE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)\b(mix|megamix|mixtape|playlist|compilation|full album|live set|dj set|podcast|radio show|nonstop|non-stop|сборник|подборка|плейлист)\b|\b\d+\s*(hours?|hrs?|час(а|ов)?|мин(ут)?)\b|\btop\s*\d+\b|\bbest of\b",
    )
    .unwrap()
});

/// A single song (not an hour-long mix, a compilation or a 20-second snippet).
pub fn is_single_song(r: &SearchResult) -> bool {
    if r.duration > 0.0 && !(50.0..=600.0).contains(&r.duration) {
        return false;
    }
    !JUNK_TITLE.is_match(&r.title)
}

type Related = Vec<SearchResult>;
/// "service|seed" → the related songs found (kept for an hour: the lists don't change faster)
static RELATED: std::sync::Mutex<Option<HashMap<String, (std::time::Instant, Related)>>> = std::sync::Mutex::new(None);
const RELATED_TTL: Duration = Duration::from_secs(3600);

async fn related_on(bin: &str, seed: &Seed, source: &str) -> Result<Related, String> {
    let key = format!("{source}|{}|{}", seed.url.as_deref().unwrap_or(""), track_key(&seed.artist, &seed.title));
    if let Some((at, list)) = RELATED.lock().unwrap().as_ref().and_then(|m| m.get(&key).cloned()) {
        if at.elapsed() < RELATED_TTL {
            return Ok(list);
        }
    }
    let list = if source == "soundcloud" {
        soundcloud_related(bin, seed).await?
    } else {
        youtube_mix(bin, seed).await?
    };
    let mut cache = RELATED.lock().unwrap();
    let map = cache.get_or_insert_with(HashMap::new);
    map.retain(|_, (at, _)| at.elapsed() < RELATED_TTL);
    map.insert(key, (std::time::Instant::now(), list.clone()));
    Ok(list)
}

/// Songs the service itself lists next to each seed ("related tracks" on SoundCloud, the "Mix"
/// on YouTube). They stay in the seed's genre, and each comes with its own page, so playing one
/// needs no search. `because` names the seed a song came from.
pub async fn wave_candidates(req: WaveRequest) -> Result<Vec<SearchResult>, String> {
    let seeds: Vec<Seed> = req.seeds.into_iter().filter(|s| !s.title.trim().is_empty()).take(4).collect();
    if seeds.is_empty() {
        return Ok(Vec::new());
    }
    let bin = require_ytdlp().await?;
    let source = if req.source == "soundcloud" { "soundcloud" } else { "youtube" };
    let other = if source == "soundcloud" { "youtube" } else { "soundcloud" };
    let fallback = req.fallback;
    let lists: Vec<Result<Related, String>> = join_all(seeds.iter().map(|seed| {
        let bin = bin.clone();
        async move {
            match related_on(&bin, seed, source).await {
                Ok(list) if !list.is_empty() => Ok(list),
                first if fallback => match related_on(&bin, seed, other).await {
                    Ok(list) if !list.is_empty() => Ok(list),
                    _ => first,
                },
                first => first,
            }
        }
    }))
    .await;
    let first_error = lists.iter().find_map(|l| l.as_ref().err().cloned());
    let banned: HashSet<String> = req.exclude_artists.iter().map(|a| simple(a)).collect();
    let skip: HashSet<String> = req.exclude_keys.iter().cloned().collect();
    let found: Vec<Related> = lists
        .into_iter()
        .zip(&seeds)
        .filter_map(|(l, seed)| {
            let label = seed_label(seed);
            Some(
                l.ok()?
                    .into_iter()
                    .filter(is_single_song)
                    .filter(|r| !banned.contains(&simple(&r.artist)) && !skip.contains(&track_key(&r.artist, &r.title)))
                    .map(|r| SearchResult { because: Some(label.clone()), ..r })
                    .collect(),
            )
        })
        .collect();
    let out = interleave(found, &seeds, req.limit.clamp(5, 80));
    match (out.is_empty(), first_error) {
        (true, Some(e)) => Err(e),
        _ => Ok(out),
    }
}

// ── radio by track ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RadioRequest {
    pub artist: String,
    pub title: String,
    pub exclude_keys: Vec<String>,
    pub exclude_artists: Vec<String>,
    pub limit: usize,
}

/// Songs like a track: Deezer's radio of its artist (that artist and similar music) mixed with
/// the best-known songs of similar artists; the seed's own artist stays a minority.
pub async fn radio(req: RadioRequest) -> Result<Vec<SearchResult>, String> {
    use crate::deezer;
    let limit = req.limit.clamp(5, 50);
    let seed = deezer::find_track(&req.artist, &req.title).await;
    let aid = match seed.as_ref().map(|t| t.artist_id).filter(|id| *id != 0) {
        Some(id) => id,
        None => deezer::artist_id(req.artist.split([',', '&']).next().unwrap_or("").trim())
            .await
            .ok_or_else(|| DEEZER_DOWN.to_string())?,
    };
    let (station, related) = tokio::join!(deezer::artist_radio(aid), deezer::related(aid, 12));
    let tops = join_all(related.iter().take(8).map(|(id, _)| deezer::top(*id, 4))).await;
    deezer::save_cache();
    let banned: HashSet<String> = req.exclude_artists.iter().map(|a| simple(a)).collect();
    let mut seen: HashSet<String> = req.exclude_keys.iter().cloned().collect();
    seen.insert(track_key(&req.artist, &req.title));
    let seed_artist = simple(&req.artist);
    // station first, then the similar artists' songs one artist at a time
    let mut pool: Vec<&deezer::DzTrack> = station.iter().collect();
    let max_len = tops.iter().map(Vec::len).max().unwrap_or(0);
    for i in 0..max_len {
        for list in &tops {
            if let Some(t) = list.get(i) {
                pool.push(t);
            }
        }
    }
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    for t in pool {
        if out.len() >= limit {
            break;
        }
        let a = simple(&t.artist);
        if banned.contains(&a) || !seen.insert(track_key(&t.artist, &t.title)) {
            continue;
        }
        let n = per_artist.entry(a.clone()).or_insert(0);
        // the seed's artist: about one song in five; others: at most two per batch
        let cap = if a == seed_artist { 1 + out.len() / 5 } else { 2 };
        if *n >= cap {
            continue;
        }
        *n += 1;
        out.push(to_result(t, "radio", Some(&req.artist)));
    }
    if out.is_empty() && station.is_empty() && tops.iter().all(Vec::is_empty) {
        return Err(DEEZER_DOWN.into());
    }
    Ok(spread_artists(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn r(id: &str, artist: &str, title: &str) -> SearchResult {
        SearchResult {
            id: id.into(),
            title: title.into(),
            artist: artist.into(),
            duration: 0.0,
            url: format!("https://x/{id}"),
            thumbnail: None,
            source: "youtube".into(),
            ..Default::default()
        }
    }

    #[test]
    fn interleaves_without_duplicates_or_the_seeds() {
        let seeds = [Seed { artist: "Øneheart".into(), title: "Snowfall".into(), url: None }];
        let out = interleave(
            vec![
                vec![r("1", "Øneheart", "Snowfall"), r("2", "A", "One"), r("3", "B", "Two")],
                vec![r("4", "C", "Three"), r("2", "A", "One"), r("5", "a", "ONE!")],
            ],
            &seeds,
            10,
        );
        // "1" is the seed itself, "5" the same song as "2"
        assert_eq!(out.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["4", "2", "3"]);
        assert_eq!(track_key("Øneheart, reidenshi", "Snowfall (Slowed)"), "øneheart|snowfall slowed");
    }

    #[test]
    fn reads_seed_links() {
        assert_eq!(youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(youtube_id("https://youtu.be/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(youtube_id("https://music.youtube.com/watch?v=dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(youtube_id("https://www.youtube.com/playlist?list=PL1"), None);
        assert_eq!(soundcloud_track("https://soundcloud.com/oneheart/snowfall?si=1").as_deref(), Some("https://soundcloud.com/oneheart/snowfall"));
        assert_eq!(soundcloud_track("https://soundcloud.com/oneheart/sets/x"), None);
        assert_eq!(slug_artist("https://soundcloud.com/neon-coast/track"), "neon coast");
    }

    #[test]
    fn maps_youtube_mix_and_soundcloud_related_entries() {
        // shapes as yt-dlp prints them with --flat-playlist
        let mix = to_results(
            &[
                json!({ "id": "abcdefghijk", "title": "Snowfall", "url": "https://www.youtube.com/watch?v=abcdefghijk", "channel": "Øneheart", "duration": 129 }),
                json!({ "id": "bbbbbbbbbbb", "title": "reidenshi - Lost", "url": "https://www.youtube.com/watch?v=bbbbbbbbbbb", "channel": "Music Hub" }),
            ],
            "youtube",
        );
        assert_eq!((mix[1].artist.as_str(), mix[1].title.as_str()), ("reidenshi", "Lost"));

        let mut sc = to_results(&[json!({ "id": "123", "title": "Lost", "url": "https://soundcloud.com/reidenshi/lost" })], "soundcloud");
        apply_oembed(
            &mut sc[0],
            &json!({ "title": "Lost by reidenshi", "author_name": "reidenshi", "thumbnail_url": "https://i1.sndcdn.com/artworks-x-t500x500.jpg" }),
        );
        assert_eq!(
            (sc[0].artist.as_str(), sc[0].title.as_str(), sc[0].thumbnail.as_deref()),
            ("reidenshi", "Lost", Some("https://i1.sndcdn.com/artworks-x-t500x500.jpg"))
        );
    }

    #[tokio::test]
    async fn spotify_recommendations_come_from_similar_artists() {
        let _env = crate::paths::TEST_ENV.lock().await;
        let track = |id: &str, artist: &str| {
            json!({ "id": id, "name": format!("Song {id}"), "duration_ms": 120000, "artists": [{ "name": artist }],
                    "album": { "name": "X", "images": [{ "url": "https://i.scdn.co/1", "width": 300 }] } })
        };
        let page = |items: Vec<Value>| json!({ "tracks": { "items": items, "next": null } }).to_string();
        let mock = crate::testutil::serve(vec![
            ("/deezer/search/artist", 200, json!({ "data": [{ "id": 7, "name": "Øneheart" }] }).to_string()),
            ("/deezer/artist/7/related", 200, json!({ "data": [{ "name": "reidenshi" }, { "name": "snowfall" }] }).to_string()),
            ("/token", 200, json!({ "access_token": "tok-rec", "expires_in": 3600 }).to_string()),
            ("/v1/search?type=track&limit=5&offset=0&q=artist%3A%22reidenshi%22", 200, page(vec![track("r1", "reidenshi"), track("zz", "Someone Else")])),
            ("/v1/search?type=track&limit=5&offset=0&q=artist%3A%22snowfall%22", 200, page(vec![track("s1", "snowfall")])),
            ("/v1/search?type=track&limit=5&offset=0&q=artist%3A%22%C3%98neheart%22", 200, page(vec![track("o1", "Øneheart")])),
        ])
        .await;
        std::env::set_var("VELVET_DEEZER_API", format!("{}/deezer", mock.base));
        std::env::set_var("VELVET_SPOTIFY_API", format!("{}/v1", mock.base));
        std::env::set_var("VELVET_SPOTIFY_TOKEN_URL", format!("{}/token", mock.base));
        let req = RecommendRequest {
            source: "spotify".into(),
            seeds: vec![Seed { artist: "Øneheart".into(), title: "Snowfall".into(), url: None }],
            spotify: Some(SpotifyKeys { client_id: "id-rec".into(), client_secret: "secret-rec".into() }),
        };
        let out = recommend(req).await.unwrap();
        // tracks of other artists that only matched the text are dropped
        assert_eq!(out.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["spotify:r1", "spotify:s1", "spotify:o1"]);
        let no_keys = recommend(RecommendRequest {
            source: "spotify".into(),
            seeds: vec![Seed { artist: "A".into(), title: "B".into(), url: None }],
            spotify: None,
        })
        .await;
        assert_eq!(no_keys.unwrap_err(), spotify::NO_KEYS);
        for k in ["VELVET_DEEZER_API", "VELVET_SPOTIFY_API", "VELVET_SPOTIFY_TOKEN_URL"] {
            std::env::remove_var(k);
        }
    }

    fn dz(id: u64, title: &str, artist: &str, aid: u64, rank: u64) -> Value {
        json!({ "id": id, "title": title, "readable": true, "duration": 200, "rank": rank,
                "preview": format!("https://cdnt-preview.dzcdn.net/{id}.mp3"), "link": format!("https://www.deezer.com/track/{id}"),
                "artist": { "id": aid, "name": artist }, "album": { "id": id, "title": "LP", "cover_medium": "https://e-cdns-images.dzcdn.net/m.jpg" } })
    }

    fn data(items: Vec<Value>) -> String {
        json!({ "data": items }).to_string()
    }

    async fn deezer_mock() -> crate::testutil::Mock {
        let mock = crate::testutil::serve(vec![
            ("/search/artist?q=Alpha", 200, data(vec![json!({ "id": 1, "name": "Alpha" })])),
            ("/search/artist?q=Beta", 200, data(vec![json!({ "id": 2, "name": "Beta" })])),
            ("/artist/1/related", 200, data(vec![json!({ "id": 10, "name": "Gamma" }), json!({ "id": 11, "name": "Delta" }), json!({ "id": 2, "name": "Beta" })])),
            ("/artist/2/related", 200, data(vec![json!({ "id": 11, "name": "Delta" }), json!({ "id": 12, "name": "Eps" })])),
            ("/artist/10/top", 200, data(vec![dz(100, "G1", "Gamma", 10, 900), dz(101, "G2", "Gamma", 10, 800), dz(102, "G3", "Gamma", 10, 700)])),
            ("/artist/11/top", 200, data(vec![dz(110, "D1", "Delta", 11, 900), dz(111, "D2", "Delta", 11, 500), dz(112, "D3", "Delta", 11, 400)])),
            ("/artist/12/top", 200, data(vec![dz(120, "E1", "Eps", 12, 900)])),
            ("/artist/1/top", 200, data(vec![dz(101, "A-new", "Alpha", 1, 950)])),
            ("/artist/2/top", 200, data(vec![dz(201, "B-new", "Beta", 2, 950)])),
            ("/search?q=", 200, data(vec![dz(1, "Seed Song", "Alpha", 1, 999)])),
            ("/artist/1/radio", 200, data(vec![dz(1, "Seed Song", "Alpha", 1, 999), dz(2, "A2", "Alpha", 1, 1), dz(3, "A3", "Alpha", 1, 1), dz(4, "A4", "Alpha", 1, 1), dz(100, "G1", "Gamma", 10, 1)])),
        ])
        .await;
        std::env::set_var("VELVET_DEEZER_API", &mock.base);
        mock
    }

    struct DataDir(std::path::PathBuf);
    impl DataDir {
        fn new() -> Self {
            let d = std::env::temp_dir().join(format!("velvet-rec-{}", uuid::Uuid::new_v4()));
            std::env::set_var("VELVET_DATA_DIR", &d);
            Self(d)
        }
    }
    impl Drop for DataDir {
        fn drop(&mut self) {
            std::env::remove_var("VELVET_DATA_DIR");
            std::env::remove_var("VELVET_DEEZER_API");
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn recommends_artists_similar_to_many_of_yours() {
        let _env = crate::paths::TEST_ENV.lock().await;
        let _dir = DataDir::new();
        let _mock = deezer_mock().await;
        let req = FastRequest {
            source: "youtube".into(),
            artists: vec![Weighted { name: "Alpha".into(), weight: 10.0 }, Weighted { name: "Beta".into(), weight: 5.0 }],
            exclude_artists: vec!["Eps".into()],
            exclude_keys: vec![],
            familiar: 0.0,
            limit: 10,
            spotify: None,
        };
        let out = fast(req.clone()).await.unwrap();
        let titles: Vec<&str> = out.iter().map(|r| r.title.as_str()).collect();
        // Delta is similar to both of your artists: its best song first; two songs per artist at
        // most; nothing from the excluded artist or from your own artists
        assert_eq!(titles, vec!["D1", "G1", "D2", "G2"], "{out:?}");
        assert_eq!(out[0].because.as_deref(), Some("Alpha"));
        assert_eq!(out[0].preview.as_deref(), Some("https://cdnt-preview.dzcdn.net/110.mp3"));
        assert_eq!(out[0].url, "https://www.deezer.com/track/110");
        assert_eq!(out[0].source, "youtube");
        // a song turned down is never suggested again
        let out = fast(FastRequest { exclude_keys: vec![track_key("Delta", "D1")], ..req }).await.unwrap();
        assert!(!out.iter().any(|r| r.title == "D1"), "{out:?}");
        assert!(out.iter().any(|r| r.title == "D2"));

        // with familiar songs allowed, new songs of your own artists join (without a "because")
        let req = FastRequest {
            source: "soundcloud".into(),
            artists: vec![Weighted { name: "Alpha".into(), weight: 10.0 }, Weighted { name: "Beta".into(), weight: 5.0 }],
            familiar: 0.3,
            limit: 10,
            ..Default::default()
        };
        let out = fast(req).await.unwrap();
        let fam: Vec<&SearchResult> = out.iter().filter(|r| r.artist == "Alpha" || r.artist == "Beta").collect();
        assert!(!fam.is_empty() && fam.len() <= 3, "{out:?}");
        assert!(fam.iter().all(|r| r.because.is_none()));
        // the same artist never twice in a row when it can be avoided
        assert!(out.windows(2).all(|w| w[0].artist != w[1].artist), "{out:?}");
    }

    #[tokio::test]
    async fn radio_keeps_the_seed_artist_a_minority() {
        let _env = crate::paths::TEST_ENV.lock().await;
        let _dir = DataDir::new();
        let _mock = deezer_mock().await;
        let out = radio(RadioRequest { artist: "Alpha".into(), title: "Seed Song".into(), limit: 10, ..Default::default() }).await.unwrap();
        let titles: Vec<&str> = out.iter().map(|r| r.title.as_str()).collect();
        assert!(!titles.contains(&"Seed Song"), "{titles:?}");
        let alpha = out.iter().filter(|r| r.artist == "Alpha").count();
        assert!((1..=2).contains(&alpha), "{titles:?}");
        assert!(out.iter().filter(|r| r.artist == "Gamma").count() <= 2);
        assert!(out.iter().any(|r| r.artist == "Gamma"));
    }

    #[tokio::test]
    async fn says_when_deezer_cannot_be_reached() {
        let _env = crate::paths::TEST_ENV.lock().await;
        let _dir = DataDir::new();
        std::env::set_var("VELVET_DEEZER_API", "http://127.0.0.1:9");
        let err = fast(FastRequest { artists: vec![Weighted { name: "Nobody".into(), weight: 1.0 }], limit: 10, ..Default::default() }).await.unwrap_err();
        assert_eq!(err, DEEZER_DOWN);
    }

    #[test]
    fn keeps_single_songs_only() {
        let song = |title: &str, duration: f64| SearchResult { title: title.into(), duration, ..r("x", "A", title) };
        assert!(is_single_song(&song("MONTAGEM CORAL", 95.0)));
        assert!(is_single_song(&song("Golden Hour (Slowed Remix)", 210.0)));
        assert!(is_single_song(&song("No duration known", 0.0)));
        assert!(!is_single_song(&song("PHONK MIX 2026", 200.0)));
        assert!(!is_single_song(&song("Best Phonk 1 Hour", 200.0)));
        assert!(!is_single_song(&song("Лучший фонк — подборка", 200.0)));
        assert!(!is_single_song(&song("Long one", 3600.0)));
        assert!(!is_single_song(&song("Snippet", 20.0)));
        let seed = Seed { artist: "DJ X".into(), title: "Funk Y".into(), url: None };
        assert_eq!(seed_label(&seed), "DJ X — Funk Y");
    }

    /// A stand-in for yt-dlp: answers `--version` and prints canned playlists for the
    /// SoundCloud "recommended" page, the YouTube mix and the one-result searches.
    #[cfg(unix)]
    fn fake_ytdlp(dir: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let sc = json!({ "entries": [
            { "id": "1", "title": "MONTAGEM TOMADA", "url": "https://soundcloud.com/djx/montagem-tomada", "uploader": "DJ X", "duration": 120, "genre": "Funk", "thumbnail": "https://i1.sndcdn.com/a.jpg" },
            { "id": "2", "title": "PHONK MIX 2026 (1 HOUR)", "url": "https://soundcloud.com/mixer/phonk-mix", "uploader": "Mixer", "duration": 3600, "thumbnail": "https://i1.sndcdn.com/b.jpg" },
            { "id": "3", "title": "Turned Down", "url": "https://soundcloud.com/no/turned-down", "uploader": "No", "duration": 150, "thumbnail": "https://i1.sndcdn.com/c.jpg" },
            { "id": "4", "title": "Anything", "url": "https://soundcloud.com/banned/anything", "uploader": "Banned Guy", "duration": 150, "thumbnail": "https://i1.sndcdn.com/d.jpg" },
            { "id": "5", "title": "SLAY!", "url": "https://soundcloud.com/eternxlkz/slay", "uploader": "Eternxlkz", "duration": 99, "genres": ["Phonk"], "thumbnail": "https://i1.sndcdn.com/e.jpg" }
        ] });
        let yt = json!({ "entries": [
            { "id": "aaaaaaaaaaa", "title": "Seed Itself", "url": "https://www.youtube.com/watch?v=aaaaaaaaaaa", "channel": "Seeder", "duration": 100 },
            { "id": "bbbbbbbbbbb", "title": "KORDHELL - LIVE ANOTHER DAY", "url": "https://www.youtube.com/watch?v=bbbbbbbbbbb", "channel": "Phonk House", "duration": 130 }
        ] });
        let script = format!(
            "#!/bin/sh\ncase \"$*\" in\n  *--version*) echo 2026.01.01 ;;\n  *unknown-seed*) echo 'ERROR: nothing' >&2; exit 1 ;;\n  *recommended*) cat <<'JSON'\n{sc}\nJSON\n  ;;\n  *list=RD*) cat <<'JSON'\n{yt}\nJSON\n  ;;\n  *ytsearch1*) echo '{{\"entries\":[{{\"id\":\"aaaaaaaaaaa\"}}]}}' ;;\n  *) echo '{{\"entries\":[]}}' ;;\nesac\n"
        );
        let path = bin.join("yt-dlp");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        crate::tools::forget_ytdlp();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn finds_songs_related_to_the_users_own_on_the_chosen_service() {
        let _env = crate::paths::TEST_ENV.lock().await;
        let dir = DataDir::new();
        fake_ytdlp(&dir.0);
        let seed = Seed { artist: "DJ Funk".into(), title: "Funk Seed".into(), url: Some("https://soundcloud.com/djfunk/funk-seed".into()) };
        let out = wave_candidates(WaveRequest {
            source: "soundcloud".into(),
            seeds: vec![seed.clone()],
            exclude_keys: vec![track_key("No", "Turned Down")],
            exclude_artists: vec!["Banned Guy".into()],
            fallback: false,
            limit: 20,
        })
        .await
        .unwrap();
        // the hour-long mix, the refused song and the banned artist are left out
        assert_eq!(out.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["MONTAGEM TOMADA", "SLAY!"]);
        assert_eq!(out[0].because.as_deref(), Some("DJ Funk — Funk Seed"));
        assert_eq!(out[0].genre.as_deref(), Some("Funk"));
        assert_eq!(out[1].genre.as_deref(), Some("Phonk"));
        assert_eq!(out[0].url, "https://soundcloud.com/djx/montagem-tomada");
        assert_eq!(out[0].source, "soundcloud");

        // YouTube: the mix of the seed, without the seed itself
        let yt_seed = Seed { artist: "Seeder".into(), title: "Seed Itself".into(), url: Some("https://www.youtube.com/watch?v=aaaaaaaaaaa".into()) };
        let yt = wave_candidates(WaveRequest { source: "youtube".into(), seeds: vec![yt_seed], limit: 20, ..Default::default() }).await.unwrap();
        assert_eq!(yt.iter().map(|r| (r.artist.as_str(), r.title.as_str())).collect::<Vec<_>>(), vec![("KORDHELL", "LIVE ANOTHER DAY")]);

        // a seed the service doesn't know: an error without the fallback, the other service with it
        let lost = Seed { artist: "X".into(), title: "unknown-seed".into(), url: Some("https://soundcloud.com/x/unknown-seed".into()) };
        let req = |fallback| WaveRequest { source: "soundcloud".into(), seeds: vec![lost.clone()], fallback, limit: 20, ..Default::default() };
        assert!(wave_candidates(req(false)).await.is_err());
        crate::tools::forget_ytdlp();
    }
}
