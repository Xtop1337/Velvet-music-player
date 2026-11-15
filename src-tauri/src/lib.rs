//! Velvet's backend: everything the Electron main process did, in Rust.

mod analysis;
mod commands;
mod deezer;
mod covers;
mod discord;
mod exporter;
mod importer;
mod library;
mod links;
mod lyrics;
mod matcher;
mod media;
mod media_server;
mod net;
mod paths;
mod protocol;
mod recommend;
mod remote;
mod search;
mod spotify;
mod store;
mod stream;
mod tags;
#[cfg(test)]
mod testutil;
mod tools;
mod types;
mod updater;

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WindowEvent};

pub struct AppState {
    pub remote: remote::Remote,
    pub discord: discord::Discord,
    pub importer: importer::Importer,
    pub updater: updater::Updater,
    pub analysis: analysis::Worker,
    pub meta: deezer::MetaQueue,
    exiting: AtomicBool,
    flushing: AtomicBool,
}

/// Runs a future on the current tokio runtime, or on Tauri's when called from outside one.
pub fn spawn<F: Future<Output = ()> + Send + 'static>(f: F) {
    match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            h.spawn(f);
        }
        Err(_) => {
            tauri::async_runtime::spawn(f);
        }
    }
}

/// Quit from the tray, the window, an update…: the main window saves first (`app:flush`),
/// then confirms with `app_flushed`; a silent window still quits after 3 s.
pub fn request_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.remote.quitting.store(true, Ordering::SeqCst);
    if state.exiting.load(Ordering::SeqCst) || state.flushing.swap(true, Ordering::SeqCst) {
        return;
    }
    log::info!("quit requested");
    quit_watchdog();
    if app.get_webview_window("main").is_some() && app.emit_to("main", "app:flush", ()).is_ok() {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            finish_quit(&app2);
        });
    } else {
        finish_quit(app);
    }
}

pub fn finish_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.exiting.swap(true, Ordering::SeqCst) {
        return;
    }
    state.remote.quitting.store(true, Ordering::SeqCst);
    quit_watchdog();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app2.state::<AppState>();
        state.discord.shutdown().await;
        state.remote.dispose(&app2);
        stream::clear_temp();
        log::info!("exiting");
        app2.exit(0);
    });
}

/// Once quitting has started the process ends within a few seconds, whatever hangs
/// (a stuck UI thread, a driver, a pipe): nobody has to kill Velvet in Task Manager.
fn quit_watchdog() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = std::thread::Builder::new().name("quit-watchdog".into()).spawn(|| {
        std::thread::sleep(QUIT_DEADLINE);
        log::warn!("quit did not finish in {QUIT_DEADLINE:?}: ending the process");
        log::logger().flush();
        std::process::exit(0);
    });
}

/// Time for saving (`app:flush`, at most 3 s) and the clean exit after it.
const QUIT_DEADLINE: Duration = Duration::from_secs(6);

/// Where a window loads the UI. Release builds load it from the app's own `velvet` protocol, the
/// same origin as the local audio (no CORS between the page and its music); development keeps
/// the Vite dev server.
pub fn ui_url(fragment: &str) -> WebviewUrl {
    if tauri::is_dev() {
        WebviewUrl::App(format!("index.html{fragment}").into())
    } else {
        WebviewUrl::CustomProtocol(format!("velvet://localhost/index.html{fragment}").parse().expect("valid url"))
    }
}

fn main_window(app: &AppHandle) -> tauri::Result<()> {
    #[allow(unused_mut)]
    let mut b = tauri::WebviewWindowBuilder::new(app, "main", ui_url(""))
        .title("Velvet")
        .inner_size(1320.0, 840.0)
        .min_inner_size(960.0, 620.0)
        .center()
        .decorations(false)
        .visible(false)
        .background_color(tauri::window::Color(0xf5, 0xf7, 0xfb, 0xff));
    #[cfg(windows)]
    {
        b = b.additional_browser_args(BROWSER_ARGS);
    }
    b.build()?;
    Ok(())
}

/// Flags of every Velvet window's WebView2: Tauri's defaults, no autoplay gate (Electron had none
/// either), Velvet's own media keys (SMTC), and the page may reach Velvet's own loopback server
/// (local audio). All windows must use the *same* flags: WebView2 runs one browser process per
/// data folder and refuses to open a window with different ones (that broke the mini player).
#[cfg(windows)]
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,HardwareMediaKeyHandling,MediaSessionService,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults --autoplay-policy=no-user-gesture-required";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| remote::show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            // velvet.log in the app's log folder (%LOCALAPPDATA%\app.velvet.player\logs on Windows)
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("velvet".into()) }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .level(log::LevelFilter::Info)
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("wry", log::LevelFilter::Warn)
                .max_file_size(512 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("velvet", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || responder.respond(protocol::serve(&app, &request)));
        })
        .setup(|app| {
            main_window(app.handle())?;
            let handle = app.handle().clone();
            let (h1, h2) = (handle.clone(), handle.clone());
            let discord = discord::Discord::start(
                discord::ipc::Ipc::default(),
                Box::new(move |status, user| {
                    let _ = h1.emit("discord:status", (status, if user.is_empty() { None } else { Some(user) }));
                }),
                Box::new(move |track_id, url| {
                    let _ = h2.emit("discord:cover", (track_id, url));
                }),
            );
            app.manage(AppState {
                remote: remote::Remote::default(),
                discord,
                importer: importer::Importer::default(),
                updater: updater::Updater::default(),
                analysis: analysis::Worker::default(),
                meta: deezer::MetaQueue::default(),
                exiting: AtomicBool::new(false),
                flushing: AtomicBool::new(false),
            });
            log::info!(
                "Velvet {} on {} (webview {})",
                app.package_info().version,
                std::env::consts::OS,
                tauri::webview_version().unwrap_or_else(|e| format!("unknown: {e}"))
            );
            // loopback server: Linux streams media from it, Windows gives the media overlay its covers
            if let Err(e) = tauri::async_runtime::block_on(media_server::start()) {
                log::error!("media server: {e}");
            }
            // songs downloaded ahead of playback last session
            stream::clear_temp();
            app.state::<AppState>().remote.init_smtc(&handle);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // shown once the UI has painted, like Electron's ready-to-show
            if webview.label() == "main" && payload.event() == PageLoadEvent::Finished {
                let _ = webview.window().show();
            }
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                if state.exiting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let to_tray = state.remote.prefs.lock().unwrap().close_to_tray;
                if to_tray && !state.remote.quitting.load(Ordering::SeqCst) {
                    state.remote.ensure_tray(app);
                    let _ = window.hide();
                } else {
                    request_quit(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::media_base,
            commands::window_theme,
            commands::open_external,
            commands::store_load,
            commands::store_save,
            commands::library_pick,
            commands::library_scan,
            commands::library_exists,
            commands::library_reveal,
            commands::tags_write,
            commands::cover_pick,
            commands::cover_url,
            commands::cover_clipboard,
            commands::dialog_pick_dir,
            commands::dialog_pick_video,
            commands::discord_configure,
            commands::discord_update,
            commands::discord_status,
            commands::export_start,
            commands::search_query,
            commands::search_preview,
            commands::recommend,
            commands::stream_resolve,
            commands::stream_prefetch,
            commands::player_state,
            commands::player_command,
            commands::remote_last_state,
            commands::app_prefs,
            commands::mini_toggle,
            commands::mini_close,
            commands::update_configure,
            commands::update_check,
            commands::update_open,
            commands::update_status,
            commands::lyrics_get,
            commands::import_start,
            commands::import_cancel,
            commands::ytdlp_status,
            commands::ytdlp_install,
            commands::app_flushed,
            commands::ui_log,
            commands::analysis_start,
            commands::analysis_cancel,
            commands::meta_lookup,
            commands::recommend_fast,
            commands::radio_tracks,
            commands::wave_candidates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Velvet");
}
