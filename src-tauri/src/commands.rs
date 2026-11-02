//! The commands behind `window.velvet` (see src/bridge.ts).

use crate::discord::DiscordOptions;
use crate::media::{AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS};
use crate::tags::TagWrite;
use crate::types::*;
use crate::{covers, exporter, library, lyrics, paths, remote, search, store, tools, AppState};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type R<T> = CmdResult<T>;

fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> Value {
    json!({
        "platform": platform(),
        "version": app.package_info().version.to_string(),
        "defaultDownloads": paths::default_downloads().to_string_lossy(),
    })
}

/// Where audio and video are streamed from: `None` means the `velvet` protocol (Windows),
/// otherwise the loopback server's base URL (Linux, see media_server.rs).
#[tauri::command]
pub fn media_base() -> Option<String> {
    #[cfg(target_os = "linux")]
    return crate::media_server::base();
    #[cfg(not(target_os = "linux"))]
    None
}

fn parse_hex(c: &str) -> Option<tauri::window::Color> {
    let h = c.trim().trim_start_matches('#');
    let v = |i: usize| u8::from_str_radix(h.get(i..i + 2)?, 16).ok();
    (h.len() >= 6)
        .then(|| Some(tauri::window::Color(v(0)?, v(2)?, v(4)?, 255)))
        .flatten()
}

#[tauri::command]
pub fn window_theme(window: WebviewWindow, bg: String) {
    if let Some(c) = parse_hex(&bg) {
        let _ = window.set_background_color(Some(c));
    }
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> R<()> {
    if !url.starts_with("https://") {
        return Ok(());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
pub fn store_load(name: String) -> R<Option<Value>> {
    store::load(&name)
}

#[tauri::command]
pub async fn store_save(name: String, data: Value) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || store::save(&name, &data))
        .await
        .map_err(err)?
}

/// Scans with progress events (at most every 50 ms, plus the last one).
async fn scan_with_progress(app: AppHandle, inputs: Vec<String>) -> R<Vec<Track>> {
    tauri::async_runtime::spawn_blocking(move || {
        let last = Mutex::new(Instant::now() - std::time::Duration::from_secs(1));
        library::scan(&inputs, |done, total| {
            let mut l = last.lock().unwrap();
            if done == total || l.elapsed().as_millis() >= 50 {
                *l = Instant::now();
                let _ = app.emit("library:scan-progress", (done, total));
            }
        })
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn library_pick(app: AppHandle, window: WebviewWindow, kind: String) -> R<Vec<Track>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = app.dialog().file().set_parent(&window);
    if kind == "folder" {
        dialog.pick_folders(move |p| {
            let _ = tx.send(p);
        });
    } else {
        dialog.add_filter("Audio", &AUDIO_EXTENSIONS).pick_files(move |p| {
            let _ = tx.send(p);
        });
    }
    let picked = rx.await.ok().flatten().unwrap_or_default();
    let inputs: Vec<String> = picked
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    scan_with_progress(app, inputs).await
}

#[tauri::command]
pub async fn library_scan(app: AppHandle, paths: Vec<String>) -> R<Vec<Track>> {
    scan_with_progress(app, paths).await
}

#[tauri::command]
pub fn library_exists(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| std::path::Path::new(p).exists()).collect()
}

#[tauri::command]
pub fn library_reveal(app: AppHandle, path: String) -> R<()> {
    app.opener().reveal_item_in_dir(path).map_err(err)
}

#[tauri::command]
pub async fn tags_write(t: TagWrite) -> Value {
    match tauri::async_runtime::spawn_blocking(move || crate::tags::write(&t))
        .await
        .map_err(err)
        .and_then(|r| r)
    {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

async fn pick_one(app: &AppHandle, window: &WebviewWindow, filter: Option<(&str, &[&str])>, folder: bool) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_parent(window);
    if let Some((name, exts)) = filter {
        dialog = dialog.add_filter(name, exts);
    }
    if folder {
        dialog.pick_folder(move |p| {
            let _ = tx.send(p);
        });
    } else {
        dialog.pick_file(move |p| {
            let _ = tx.send(p);
        });
    }
    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn cover_pick(app: AppHandle, window: WebviewWindow) -> R<Option<String>> {
    match pick_one(&app, &window, Some(("Images", &IMAGE_EXTENSIONS)), false).await {
        Some(f) => covers::from_file(&f).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn cover_url(url: String) -> R<String> {
    covers::from_url(&url).await
}

#[tauri::command]
pub async fn cover_clipboard() -> R<Option<String>> {
    tauri::async_runtime::spawn_blocking(covers::from_clipboard).await.map_err(err)?
}

#[tauri::command]
pub async fn dialog_pick_dir(app: AppHandle, window: WebviewWindow) -> Option<String> {
    pick_one(&app, &window, None, true).await
}

#[tauri::command]
pub async fn dialog_pick_video(app: AppHandle, window: WebviewWindow) -> Option<String> {
    pick_one(&app, &window, Some(("Video", &VIDEO_EXTENSIONS)), false).await
}

#[tauri::command]
pub fn discord_configure(state: State<AppState>, opts: DiscordOptions) {
    state.discord.configure(opts)
}

#[tauri::command]
pub fn discord_update(state: State<AppState>, p: Option<NowPlaying>) {
    state.discord.update(p)
}

#[tauri::command]
pub fn discord_status(state: State<AppState>) -> String {
    state.discord.status()
}

#[tauri::command]
pub async fn export_start(app: AppHandle, o: ExportOptions) -> ExportProgress {
    let id = o.id.clone();
    let app2 = app.clone();
    match exporter::export(o, move |p| {
        let _ = app2.emit("export:progress", p);
    })
    .await
    {
        Ok(p) => p,
        Err(e) => {
            let p = ExportProgress {
                id,
                state: "error".into(),
                percent: 0.0,
                error: Some(e),
                ..Default::default()
            };
            let _ = app.emit("export:progress", &p);
            p
        }
    }
}

#[tauri::command]
pub async fn search_query(q: String, source: String) -> Value {
    match search::search(&q, &source, 20).await {
        Ok(results) => json!({ "results": results }),
        Err(e) => json!({ "results": [], "error": e }),
    }
}

#[tauri::command]
pub async fn search_preview(url: String) -> R<String> {
    search::preview_url(&url).await
}

#[tauri::command]
pub fn player_state(app: AppHandle, state: State<AppState>, s: RemoteState) {
    state.remote.set_state(&app, s)
}

#[tauri::command]
pub fn player_command(app: AppHandle, c: Value) {
    remote::command(&app, c)
}

#[tauri::command]
pub fn remote_last_state(state: State<AppState>) -> Option<RemoteState> {
    state.remote.state.lock().unwrap().clone()
}

#[tauri::command]
pub fn app_prefs(app: AppHandle, state: State<AppState>, p: AppPrefs, strings: MainStrings) -> Vec<String> {
    state.remote.set_prefs(&app, p, strings)
}

#[tauri::command]
pub fn mini_toggle(app: AppHandle) {
    remote::toggle_mini(&app)
}

#[tauri::command]
pub fn mini_close(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub fn update_configure(app: AppHandle, state: State<AppState>, auto: bool) {
    state.updater.configure(&app, auto)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) {
    app.state::<AppState>().updater.check(&app).await
}

#[tauri::command]
pub fn update_open(app: AppHandle, state: State<AppState>) -> R<()> {
    state.updater.open(&app)
}

#[tauri::command]
pub fn update_status(state: State<AppState>) -> UpdateStatus {
    state.updater.status()
}

#[tauri::command]
pub async fn lyrics_get(q: LyricsQuery) -> LyricsResult {
    lyrics::get_lyrics(q).await
}

#[tauri::command]
pub fn import_start(app: AppHandle, state: State<AppState>, opts: ImportOptions) -> String {
    state.importer.start(app.clone(), opts)
}

#[tauri::command]
pub fn import_cancel(app: AppHandle, state: State<AppState>, job_id: String) {
    state.importer.cancel(&app, &job_id)
}

#[tauri::command]
pub async fn ytdlp_status() -> YtDlpStatus {
    tools::ytdlp_status(true).await
}

#[tauri::command]
pub async fn ytdlp_install() -> R<YtDlpStatus> {
    tools::install_ytdlp().await
}

/// The main window has written its pending saves: the app may quit now.
#[tauri::command]
pub fn app_flushed(app: AppHandle) {
    crate::finish_quit(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_theme_colors() {
        assert_eq!(parse_hex("#0b1630"), Some(tauri::window::Color(0x0b, 0x16, 0x30, 255)));
        assert_eq!(parse_hex("nope"), None);
    }
}
