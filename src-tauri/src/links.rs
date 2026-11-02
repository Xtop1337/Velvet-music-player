//! Recognises Spotify / SoundCloud / YouTube links (same rules as `src/shared/links.ts`).

use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq)]
pub struct LinkInfo {
    /// spotify | soundcloud | youtube
    pub service: &'static str,
    /// track | album | playlist | user | short
    pub kind: String,
    pub id: Option<String>,
    pub url: String,
}

static SPOTIFY_URI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^spotify:(track|album|playlist):([A-Za-z0-9]+)$").unwrap());
static ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9]+$").unwrap());

pub fn parse_music_link(input: &str) -> Option<LinkInfo> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(c) = SPOTIFY_URI.captures(raw) {
        return Some(LinkInfo {
            service: "spotify",
            kind: c[1].into(),
            id: Some(c[2].into()),
            url: format!("https://open.spotify.com/{}/{}", &c[1], &c[2]),
        });
    }
    let with_scheme = if raw.to_lowercase().starts_with("http://") || raw.to_lowercase().starts_with("https://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url = url::Url::parse(&with_scheme).ok()?;
    let host = url.host_str()?.to_lowercase();
    let host = host
        .strip_prefix("www.")
        .or_else(|| host.strip_prefix("m."))
        .unwrap_or(&host)
        .to_string();
    let parts: Vec<&str> = url.path().split('/').filter(|p| !p.is_empty()).collect();
    let param = |k: &str| {
        url.query_pairs()
            .find(|(n, v)| n == k && !v.is_empty())
            .map(|(_, v)| v.into_owned())
    };

    match host.as_str() {
        "open.spotify.com" | "play.spotify.com" => {
            // links may carry a locale segment: /intl-de/track/<id>
            let segs: &[&str] = if parts.first().map(|p| p.starts_with("intl-")).unwrap_or(false) {
                &parts[1..]
            } else {
                &parts
            };
            let (kind, id) = (*segs.first()?, *segs.get(1)?);
            if ["track", "album", "playlist"].contains(&kind) && ALNUM.is_match(id) {
                return Some(LinkInfo {
                    service: "spotify",
                    kind: kind.into(),
                    id: Some(id.into()),
                    url: format!("https://open.spotify.com/{kind}/{id}"),
                });
            }
            None
        }
        "on.soundcloud.com" | "snd.sc" => (!parts.is_empty()).then(|| LinkInfo {
            service: "soundcloud",
            kind: "short".into(),
            id: None,
            url: url.to_string(),
        }),
        "soundcloud.com" => {
            if parts.is_empty() {
                return None;
            }
            let clean = format!("https://soundcloud.com/{}", parts.join("/"));
            let kind = if parts.len() == 1 || ["tracks", "albums", "popular-tracks", "reposts", "likes"].contains(&parts[1]) {
                "user"
            } else if parts[1] == "sets" {
                "playlist"
            } else {
                "track"
            };
            Some(LinkInfo {
                service: "soundcloud",
                kind: kind.into(),
                id: None,
                url: clean,
            })
        }
        "youtube.com" | "music.youtube.com" | "youtu.be" => {
            let link = |kind: &str| {
                Some(LinkInfo {
                    service: "youtube",
                    kind: kind.into(),
                    id: None,
                    url: url.to_string(),
                })
            };
            if param("list").is_some() && param("v").is_none() {
                return link("playlist");
            }
            if host == "youtu.be" || param("v").is_some() || parts.first() == Some(&"shorts") {
                return link("track");
            }
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_links() {
        let l = parse_music_link("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc").unwrap();
        assert_eq!(
            (l.service, l.kind.as_str(), l.id.as_deref(), l.url.as_str()),
            (
                "spotify",
                "track",
                Some("4uLU6hMCjMI75M1A2tKUQC"),
                "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
            )
        );
        assert_eq!(
            parse_music_link("https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy")
                .unwrap()
                .kind,
            "album"
        );
        assert_eq!(
            parse_music_link("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M").unwrap().kind,
            "playlist"
        );
        assert_eq!(
            parse_music_link("open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")
                .unwrap()
                .service,
            "spotify"
        );
        assert_eq!(parse_music_link("https://soundcloud.com/artist/some-track").unwrap().kind, "track");
        let set = parse_music_link("https://soundcloud.com/artist/sets/my-album?si=1").unwrap();
        assert_eq!(
            (set.kind.as_str(), set.url.as_str()),
            ("playlist", "https://soundcloud.com/artist/sets/my-album")
        );
        assert_eq!(parse_music_link("https://m.soundcloud.com/artist").unwrap().kind, "user");
        assert_eq!(parse_music_link("https://on.soundcloud.com/AbCd123").unwrap().kind, "short");
        assert_eq!(parse_music_link("https://youtu.be/dQw4w9WgXcQ").unwrap().kind, "track");
        assert_eq!(
            parse_music_link("https://www.youtube.com/playlist?list=PL123").unwrap().kind,
            "playlist"
        );
        assert!(parse_music_link("https://example.com/song.mp3").is_none());
        assert!(parse_music_link("https://open.spotify.com/artist/abc").is_none());
        assert!(parse_music_link("").is_none());
    }
}
