//! Update check against the GitHub releases of Velvet. When a newer version is published the
//! UI asks whether to update, and "Update" opens the release page on GitHub.

use crate::types::{now_ms, UpdateStatus};
use serde_json::Value;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

/// Where Velvet's releases are published.
pub const REPO: &str = "Xtop1337/Velvet-music-player";
const EVERY: Duration = Duration::from_secs(6 * 3600);
const NOTES_MAX: usize = 600;

#[derive(Default)]
pub struct Updater {
    status: Mutex<UpdateStatus>,
    timer: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub notes: String,
}

fn releases_url() -> String {
    std::env::var("VELVET_RELEASES_URL").unwrap_or_else(|_| format!("https://api.github.com/repos/{REPO}/releases/latest"))
}

/// `v2.10.1-beta` → `[2, 10, 1]`; missing or non-numeric parts count as 0.
pub fn version_parts(v: &str) -> [u64; 3] {
    let core = v.trim().trim_start_matches(['v', 'V']).split(['-', '+', ' ']).next().unwrap_or("");
    let mut out = [0u64; 3];
    for (i, part) in core.split('.').take(3).enumerate() {
        out[i] = part
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or(0);
    }
    out
}

pub fn newer(remote: &str, current: &str) -> bool {
    version_parts(remote) > version_parts(current)
}

/// The fields Velvet needs from `GET /repos/{repo}/releases/latest`.
pub fn parse_release(v: &Value) -> Option<Release> {
    let tag = v.get("tag_name").and_then(Value::as_str).filter(|t| !t.is_empty())?;
    let url = v
        .get("html_url")
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases/latest"));
    let body = v.get("body").and_then(Value::as_str).unwrap_or("").trim();
    let mut notes: String = body.chars().take(NOTES_MAX).collect();
    if body.chars().count() > NOTES_MAX {
        notes.push('…');
    }
    Some(Release {
        version: tag.trim_start_matches(['v', 'V']).to_string(),
        url,
        notes,
    })
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(200).collect()
}

async fn fetch_latest() -> Result<Option<Release>, String> {
    let res = crate::net::client()
        .get(releases_url())
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| first_line(&e.to_string()))?;
    // no published release yet
    if res.status().as_u16() == 404 {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("GitHub: HTTP {}", res.status().as_u16()));
    }
    let json: Value = res.json().await.map_err(|e| first_line(&e.to_string()))?;
    Ok(parse_release(&json))
}

impl Updater {
    pub fn status(&self) -> UpdateStatus {
        let s = self.status.lock().unwrap().clone();
        if s.state.is_empty() {
            UpdateStatus {
                state: "idle".into(),
                ..Default::default()
            }
        } else {
            s
        }
    }

    fn set(&self, app: &AppHandle, s: UpdateStatus) {
        *self.status.lock().unwrap() = s.clone();
        let _ = app.emit("update:status", s);
    }

    /// With `auto`, checks now and every 6 hours.
    pub fn configure(&self, app: &AppHandle, auto: bool) {
        if let Some(t) = self.timer.lock().unwrap().take() {
            t.abort();
        }
        if !auto {
            return;
        }
        let app2 = app.clone();
        *self.timer.lock().unwrap() = Some(tauri::async_runtime::spawn(async move {
            loop {
                app2.state::<crate::AppState>().updater.check(&app2).await;
                tokio::time::sleep(EVERY).await;
            }
        }));
    }

    pub async fn check(&self, app: &AppHandle) {
        if self.status().state == "checking" {
            return;
        }
        let current = app.package_info().version.to_string();
        self.set(
            app,
            UpdateStatus {
                state: "checking".into(),
                current: Some(current.clone()),
                ..Default::default()
            },
        );
        let s = match fetch_latest().await {
            Ok(Some(r)) if newer(&r.version, &current) => UpdateStatus {
                state: "available".into(),
                version: Some(r.version),
                current: Some(current),
                url: Some(r.url),
                notes: Some(r.notes).filter(|n| !n.is_empty()),
                checked_at: Some(now_ms()),
                ..Default::default()
            },
            Ok(_) => UpdateStatus {
                state: "none".into(),
                current: Some(current),
                checked_at: Some(now_ms()),
                ..Default::default()
            },
            Err(e) => UpdateStatus {
                state: "error".into(),
                current: Some(current),
                error: Some(e),
                ..Default::default()
            },
        };
        self.set(app, s);
    }

    /// Opens the release page on GitHub.
    pub fn open(&self, app: &AppHandle) -> Result<(), String> {
        let url = self
            .status()
            .url
            .unwrap_or_else(|| format!("https://github.com/{REPO}/releases/latest"));
        if !url.starts_with("https://github.com/") {
            return Err("not a GitHub link".into());
        }
        app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compares_versions() {
        assert!(newer("v2.1.0", "2.0.0"));
        assert!(newer("2.0.10", "2.0.9"));
        assert!(newer("3", "2.9.9"));
        assert!(!newer("v2.0.0", "2.0.0"));
        assert!(!newer("1.9.9", "2.0.0"));
        assert!(!newer("nightly", "2.0.0"));
        assert_eq!(version_parts("V2.1.3-beta.1"), [2, 1, 3]);
    }

    #[test]
    fn reads_the_latest_release() {
        let long = "x".repeat(700);
        let r = parse_release(&json!({ "tag_name": "v2.1.0", "html_url": "https://github.com/Xtop1337/Velvet-music-player/releases/tag/v2.1.0", "body": long })).unwrap();
        assert_eq!(r.version, "2.1.0");
        assert!(r.url.ends_with("/releases/tag/v2.1.0"));
        assert_eq!(r.notes.chars().count(), NOTES_MAX + 1);
        assert!(parse_release(&json!({ "message": "Not Found" })).is_none());
        let bare = parse_release(&json!({ "tag_name": "2.2.0" })).unwrap();
        assert_eq!(bare.url, format!("https://github.com/{REPO}/releases/latest"));
        assert_eq!(bare.notes, "");
    }
}
