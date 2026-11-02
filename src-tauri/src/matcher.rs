//! Matching Spotify metadata to downloadable audio (same scoring as the Electron version).

use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub url: String,
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
}

pub struct Want<'a> {
    pub title: &'a str,
    pub artists: &'a [String],
    pub duration_sec: f64,
}

const JUNK: [&str; 15] = [
    "live",
    "cover",
    "remix",
    "slowed",
    "sped up",
    "speed up",
    "nightcore",
    "8d",
    "karaoke",
    "instrumental",
    "reverb",
    "bass boosted",
    "lyrics video",
    "reaction",
    "tutorial",
];

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}
re!(BRACKETS, r"\(.*?\)|\[.*?\]");
re!(FEAT, r"feat\.?|ft\.?");
re!(NON_WORD, r"[^\p{L}\p{N}]+");
re!(TOPIC, r"(?i) - topic$");
re!(OFFICIAL, r"(?i)official (audio|video)|provided to youtube");
re!(DECOR, r"(?i)\s*\[(free download|out now|premiere)[^\]]*\]\s*");
re!(DASH, r"^(.+?)\s+[-–—]\s+(.+)$");
re!(BAD_CHARS, r#"[<>:"/\\|?*\x00-\x1f]"#);
re!(SPACES, r"\s+");
re!(TRAIL, r"[. ]+$");

pub fn normalize(s: &str) -> String {
    let lower: String = s.to_lowercase().nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect();
    let s = BRACKETS.replace_all(&lower, " ");
    let s = FEAT.replace_all(&s, " ");
    NON_WORD.replace_all(&s, " ").trim().to_string()
}

fn words(s: &str) -> Vec<String> {
    normalize(s)
        .split(' ')
        .filter(|w| w.chars().count() > 1)
        .map(String::from)
        .collect()
}

/// Higher is better.
pub fn score(c: &Candidate, want: &Want) -> f64 {
    let mut score = 0.0;
    let hay = normalize(&format!("{} {}", c.title, c.channel.as_deref().unwrap_or("")));
    let title_words = words(want.title);
    let hits = title_words.iter().filter(|w| hay.contains(w.as_str())).count();
    if !title_words.is_empty() {
        score += hits as f64 / title_words.len() as f64 * 40.0;
    }
    if want.artists.iter().any(|a| {
        let n = normalize(a);
        !n.is_empty() && hay.contains(&n)
    }) {
        score += 25.0;
    }
    if c.channel.as_deref().map(|ch| TOPIC.is_match(ch)).unwrap_or(false) {
        score += 15.0;
    }
    if OFFICIAL.is_match(&c.title) {
        score += 5.0;
    }
    let wanted = want.title.to_lowercase();
    let title = c.title.to_lowercase();
    for j in JUNK {
        if title.contains(j) && !wanted.contains(j) {
            score -= 25.0;
        }
    }
    if let Some(d) = c.duration.filter(|d| *d > 0.0) {
        if want.duration_sec > 0.0 {
            let diff = (d - want.duration_sec).abs();
            if diff <= 2.0 {
                score += 30.0
            } else if diff <= 5.0 {
                score += 20.0
            } else if diff <= 12.0 {
                score += 8.0
            } else if diff > 30.0 {
                score -= 30.0
            }
        }
    }
    score
}

pub fn pick_best(cands: &[Candidate], want: &Want) -> Option<Candidate> {
    let mut best: Option<&Candidate> = None;
    let mut best_score = f64::NEG_INFINITY;
    for c in cands {
        let s = score(c, want);
        if s > best_score {
            best = Some(c);
            best_score = s;
        }
    }
    if best_score >= 20.0 {
        best.cloned()
    } else {
        None
    }
}

/// SoundCloud uploads are often titled "Artist - Title"; split them when the artist field is empty.
pub fn split_artist_title(title: &str, uploader: &str, artist: Option<&str>) -> (String, String) {
    let clean = DECOR.replace_all(title, " ").trim().to_string();
    if let Some(a) = artist.filter(|a| !a.is_empty()) {
        return (a.to_string(), clean);
    }
    match DASH.captures(&clean) {
        Some(c) => (c[1].trim().to_string(), c[2].trim().to_string()),
        None => (uploader.to_string(), clean),
    }
}

pub fn safe_file_name(name: &str) -> String {
    let s = BAD_CHARS.replace_all(name, "_");
    let s = SPACES.replace_all(&s, " ");
    let s = TRAIL.replace(&s, "");
    let s: String = s.trim().chars().take(150).collect();
    if s.is_empty() {
        "track".into()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(url: &str, title: &str, channel: &str, duration: f64) -> Candidate {
        Candidate {
            url: url.into(),
            title: title.into(),
            channel: Some(channel.into()),
            duration: Some(duration),
        }
    }

    #[test]
    fn prefers_the_original_with_matching_duration() {
        let artists = vec!["The Weeknd".to_string()];
        let want = Want {
            title: "Blinding Lights",
            artists: &artists,
            duration_sec: 200.0,
        };
        let best = pick_best(
            &[
                c("a", "The Weeknd - Blinding Lights (slowed + reverb)", "Slow Vibes", 260.0),
                c("b", "Blinding Lights (Remix)", "DJ X", 201.0),
                c("c", "Blinding Lights", "The Weeknd - Topic", 201.0),
                c("d", "The Weeknd - Blinding Lights (Official Video)", "TheWeekndVEVO", 263.0),
            ],
            &want,
        );
        assert_eq!(best.unwrap().url, "c");
        assert!(pick_best(&[c("x", "Completely different song", "Someone", 30.0)], &want).is_none());
    }

    #[test]
    fn splits_soundcloud_titles() {
        assert_eq!(
            split_artist_title("Artist Name - Track Title [Free Download]", "label", None),
            ("Artist Name".into(), "Track Title".into())
        );
        assert_eq!(
            split_artist_title("Just A Title", "uploader", None),
            ("uploader".into(), "Just A Title".into())
        );
        assert_eq!(
            split_artist_title("Track", "uploader", Some("Real Artist")),
            ("Real Artist".into(), "Track".into())
        );
    }

    #[test]
    fn makes_windows_safe_file_names() {
        assert_eq!(safe_file_name("AC/DC: Back In Black?"), "AC_DC_ Back In Black_");
        assert_eq!(safe_file_name("name. "), "name");
        assert_eq!(safe_file_name("  "), "track");
    }

    #[test]
    fn normalizes_accents_and_decorations() {
        assert_eq!(normalize("Beyoncé (Live) [HD] feat. X"), "beyonce x");
    }
}
