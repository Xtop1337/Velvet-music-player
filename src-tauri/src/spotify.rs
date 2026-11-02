//! Spotify metadata. Spotify audio is DRM-protected, so only metadata is read here;
//! the importer finds the audio itself on YouTube / SoundCloud.
//!
//! Sources: the public embed page (no keys, playlists capped at ~100 tracks) and, when keys
//! are set in Settings → Import, the Web API with Client Credentials.

use crate::net::{client, BROWSER_UA};
use base64::Engine;
use regex::Regex;
use serde_json::Value;
use std::sync::{LazyLock, Mutex};

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SpotifyItem {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: f64,
    pub cover_url: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpotifyRelease {
    pub kind: String,
    pub name: String,
    pub cover_url: Option<String>,
    pub items: Vec<SpotifyItem>,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}
fn n(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}
fn arr<'a>(v: &'a Value, k: &str) -> Vec<&'a Value> {
    v.get(k).and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default()
}

fn id_from_uri(uri: &str) -> String {
    uri.rsplit(':').next().unwrap_or(uri).to_string()
}

/// The largest image among the shapes Spotify uses.
fn best_image(entity: &Value) -> Option<String> {
    let pools = [
        entity.get("visualIdentity").map(|v| arr(v, "image")).unwrap_or_default(),
        entity.get("coverArt").map(|v| arr(v, "sources")).unwrap_or_default(),
        arr(entity, "images"),
    ];
    for pool in pools {
        let mut imgs: Vec<&Value> = pool.into_iter().filter(|i| !s(i, "url").is_empty()).collect();
        let width = |i: &Value| i.get("maxWidth").and_then(Value::as_f64).unwrap_or_else(|| n(i, "width"));
        imgs.sort_by(|a, b| width(b).partial_cmp(&width(a)).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(first) = imgs.first() {
            return Some(s(first, "url"));
        }
    }
    None
}

static ARTIST_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*,\s*|\s+&\s+").unwrap());
static NEXT_DATA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?s)<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>"#).unwrap());

fn split_artists(subtitle: &str) -> Vec<String> {
    ARTIST_SEP
        .split(subtitle)
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect()
}

/// Parses the `__NEXT_DATA__` JSON of an embed page.
pub fn parse_embed_html(html: &str, kind: &str) -> Result<SpotifyRelease, String> {
    let m = NEXT_DATA.captures(html).ok_or("Spotify embed: metadata not found")?;
    let data: Value = serde_json::from_str(&m[1]).map_err(|e| e.to_string())?;
    let entity = data.pointer("/props/pageProps/state/data/entity").cloned().unwrap_or(Value::Null);
    let name = Some(s(&entity, "name"))
        .filter(|x| !x.is_empty())
        .unwrap_or_else(|| s(&entity, "title"));
    if name.is_empty() {
        return Err("Spotify embed: empty entity".into());
    }
    let cover = best_image(&entity);

    if kind == "track" {
        let artists: Vec<String> = arr(&entity, "artists")
            .iter()
            .map(|a| s(a, "name"))
            .filter(|a| !a.is_empty())
            .collect();
        let id = Some(id_from_uri(&s(&entity, "uri")))
            .filter(|x| !x.is_empty())
            .unwrap_or_else(|| s(&entity, "id"));
        return Ok(SpotifyRelease {
            kind: kind.into(),
            name: name.clone(),
            cover_url: cover.clone(),
            items: vec![SpotifyItem {
                url: format!("https://open.spotify.com/track/{id}"),
                id,
                title: name,
                artists: if artists.is_empty() {
                    split_artists(&s(&entity, "subtitle"))
                } else {
                    artists
                },
                album: entity.get("album").map(|a| s(a, "name")).unwrap_or_default(),
                duration_ms: n(&entity, "duration"),
                cover_url: cover,
            }],
        });
    }

    let album_artist = if kind == "album" { s(&entity, "subtitle") } else { String::new() };
    let items = arr(&entity, "trackList")
        .into_iter()
        .filter(|t| !s(t, "title").is_empty())
        .map(|t| {
            let id = id_from_uri(&s(t, "uri"));
            let sub = s(t, "subtitle");
            SpotifyItem {
                url: format!("https://open.spotify.com/track/{id}"),
                id,
                title: s(t, "title"),
                artists: split_artists(if sub.is_empty() { &album_artist } else { &sub }),
                album: if kind == "album" { name.clone() } else { String::new() },
                duration_ms: n(t, "duration"),
                cover_url: if kind == "album" { cover.clone() } else { None },
            }
        })
        .collect();
    Ok(SpotifyRelease {
        kind: kind.into(),
        name,
        cover_url: cover,
        items,
    })
}

async fn fetch_embed(kind: &str, id: &str) -> Result<SpotifyRelease, String> {
    let res = client()
        .get(format!("https://open.spotify.com/embed/{kind}/{id}"))
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Spotify: HTTP {}", res.status().as_u16()));
    }
    parse_embed_html(&res.text().await.map_err(|e| e.to_string())?, kind)
}

/// Fills in cover + album for playlist items (the playlist embed doesn't list them).
pub async fn enrich_from_track_embed(item: SpotifyItem) -> SpotifyItem {
    if item.cover_url.is_some() && !item.album.is_empty() {
        return item;
    }
    match fetch_embed("track", &item.id).await.ok().and_then(|r| r.items.into_iter().next()) {
        Some(t) => SpotifyItem {
            cover_url: item.cover_url.clone().or(t.cover_url),
            album: if item.album.is_empty() { t.album } else { item.album.clone() },
            ..item
        },
        None => item,
    }
}

static TOKEN: Mutex<Option<(String, String, u64)>> = Mutex::new(None);

async fn api_token(id: &str, secret: &str) -> Result<String, String> {
    let key = format!("{id}:{secret}");
    let now = crate::types::now_ms();
    if let Some((value, k, expires)) = TOKEN.lock().unwrap().clone() {
        if k == key && expires > now + 30_000 {
            return Ok(value);
        }
    }
    let res = client()
        .post("https://accounts.spotify.com/api/token")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(&key)),
        )
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body("grant_type=client_credentials")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Spotify API auth failed: HTTP {}", res.status().as_u16()));
    }
    let json: Value = res.json().await.map_err(|e| e.to_string())?;
    let value = s(&json, "access_token");
    *TOKEN.lock().unwrap() = Some((value.clone(), key, now + (n(&json, "expires_in") * 1000.0) as u64));
    Ok(value)
}

async fn api(path: &str, auth: &str) -> Result<Value, String> {
    let url = if path.starts_with("http") {
        path.to_string()
    } else {
        format!("https://api.spotify.com/v1{path}")
    };
    let res = client().get(url).bearer_auth(auth).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Spotify API: HTTP {}", res.status().as_u16()));
    }
    res.json().await.map_err(|e| e.to_string())
}

fn api_track(t: &Value, album_override: Option<&Value>) -> SpotifyItem {
    let album = album_override.or_else(|| t.get("album")).cloned().unwrap_or(Value::Null);
    let id = s(t, "id");
    let url = t
        .get("external_urls")
        .map(|u| s(u, "spotify"))
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| format!("https://open.spotify.com/track/{id}"));
    SpotifyItem {
        title: s(t, "name"),
        artists: arr(t, "artists").iter().map(|a| s(a, "name")).filter(|a| !a.is_empty()).collect(),
        album: s(&album, "name"),
        duration_ms: n(t, "duration_ms"),
        cover_url: best_image(&album),
        url,
        id,
    }
}

async fn fetch_api(kind: &str, id: &str, client_id: &str, secret: &str) -> Result<SpotifyRelease, String> {
    let auth = api_token(client_id, secret).await?;
    match kind {
        "track" => {
            let item = api_track(&api(&format!("/tracks/{id}"), &auth).await?, None);
            Ok(SpotifyRelease {
                kind: kind.into(),
                name: item.title.clone(),
                cover_url: item.cover_url.clone(),
                items: vec![item],
            })
        }
        "album" => {
            let a = api(&format!("/albums/{id}"), &auth).await?;
            let mut items = Vec::new();
            let mut page = a.get("tracks").cloned().unwrap_or(Value::Null);
            loop {
                for t in arr(&page, "items") {
                    items.push(api_track(t, Some(&a)));
                }
                let next = s(&page, "next");
                if next.is_empty() {
                    break;
                }
                page = api(&next, &auth).await?;
            }
            Ok(SpotifyRelease {
                kind: kind.into(),
                name: s(&a, "name"),
                cover_url: best_image(&a),
                items,
            })
        }
        _ => {
            let p = api(&format!("/playlists/{id}?fields=name,images"), &auth).await?;
            let mut items = Vec::new();
            let mut next = format!("/playlists/{id}/tracks?limit=100");
            while !next.is_empty() {
                let page = api(&next, &auth).await?;
                for row in arr(&page, "items") {
                    let t = row.get("track").cloned().unwrap_or(Value::Null);
                    let ty = Some(s(&t, "type")).filter(|x| !x.is_empty()).unwrap_or_else(|| "track".into());
                    if !s(&t, "id").is_empty() && ty == "track" {
                        items.push(api_track(&t, None));
                    }
                }
                next = s(&page, "next");
            }
            Ok(SpotifyRelease {
                kind: kind.into(),
                name: s(&p, "name"),
                cover_url: best_image(&p),
                items,
            })
        }
    }
}

pub async fn fetch(kind: &str, id: &str, client_id: Option<&str>, secret: Option<&str>) -> Result<SpotifyRelease, String> {
    if let (Some(cid), Some(sec)) = (client_id.filter(|v| !v.is_empty()), secret.filter(|v| !v.is_empty())) {
        // editorial playlists are not available to apps: fall back to the embed page
        if let Ok(r) = fetch_api(kind, id, cid, sec).await {
            return Ok(r);
        }
    }
    fetch_embed(kind, id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wrap(entity: Value) -> String {
        format!(
            r#"<html><body><script id="__NEXT_DATA__" type="application/json">{}</script></body></html>"#,
            json!({ "props": { "pageProps": { "state": { "data": { "entity": entity } } } } })
        )
    }

    #[test]
    fn parses_a_track_embed() {
        let r = parse_embed_html(
            &wrap(json!({
                "type": "track", "name": "Snowfall", "uri": "spotify:track:abc123",
                "artists": [{ "name": "Øneheart" }, { "name": "reidenshi" }], "duration": 129000,
                "visualIdentity": { "image": [{ "url": "https://i.scdn.co/small", "maxWidth": 64 }, { "url": "https://i.scdn.co/big", "maxWidth": 640 }] }
            })),
            "track",
        )
        .unwrap();
        assert_eq!(r.items.len(), 1);
        let t = &r.items[0];
        assert_eq!((t.id.as_str(), t.title.as_str(), t.duration_ms), ("abc123", "Snowfall", 129000.0));
        assert_eq!(t.artists, vec!["Øneheart", "reidenshi"]);
        assert_eq!(t.cover_url.as_deref(), Some("https://i.scdn.co/big"));
    }

    #[test]
    fn parses_an_album_embed() {
        let r = parse_embed_html(
            &wrap(json!({
                "type": "album", "name": "After Hours", "subtitle": "The Weeknd",
                "coverArt": { "sources": [{ "url": "https://i.scdn.co/album", "width": 640 }] },
                "trackList": [
                    { "uri": "spotify:track:t1", "title": "Alone Again", "subtitle": "The Weeknd", "duration": 250000 },
                    { "uri": "spotify:track:t2", "title": "Too Late", "subtitle": "", "duration": 239000 }
                ]
            })),
            "album",
        )
        .unwrap();
        assert_eq!(r.name, "After Hours");
        assert_eq!(
            r.items.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(),
            vec!["Alone Again", "Too Late"]
        );
        assert_eq!(r.items[1].artists, vec!["The Weeknd"]);
        assert_eq!(r.items[0].album, "After Hours");
        assert_eq!(r.items[0].cover_url.as_deref(), Some("https://i.scdn.co/album"));
    }

    #[test]
    fn fails_on_pages_without_metadata() {
        assert!(parse_embed_html("<html></html>", "track").is_err());
    }
}
