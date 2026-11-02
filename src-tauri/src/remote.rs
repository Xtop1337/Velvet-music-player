//! Everything that controls the player from outside the main window: tray icon, mini player,
//! global shortcuts, track notifications and the Windows media overlay / media keys (SMTC).
//! Playback itself stays in the main window; commands are forwarded to it.

use crate::types::{AppPrefs, MainStrings, RemoteState};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

#[derive(Default)]
pub struct Remote {
    pub prefs: Mutex<AppPrefs>,
    pub strings: Mutex<Option<MainStrings>>,
    pub state: Mutex<Option<RemoteState>>,
    tray: Mutex<Option<TrayIcon>>,
    registered: Mutex<Vec<String>>,
    pub quitting: AtomicBool,
    smtc: Mutex<Option<Smtc>>,
    smtc_playing: Arc<AtomicBool>,
    smtc_track: Mutex<Option<String>>,
}

fn command_for(action: &str) -> Option<Value> {
    Some(match action {
        "playPause" => json!({ "cmd": "toggle" }),
        "next" => json!({ "cmd": "next" }),
        "prev" => json!({ "cmd": "prev" }),
        "volumeUp" => json!({ "cmd": "volume", "value": 0.05 }),
        "volumeDown" => json!({ "cmd": "volume", "value": -0.05 }),
        "like" => json!({ "cmd": "like" }),
        "showWindow" => json!({ "cmd": "show" }),
        "miniPlayer" => json!({ "cmd": "mini" }),
        _ => return None,
    })
}

fn is_fkey(code: &str) -> bool {
    code.strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .map(|n| (1..=24).contains(&n))
        .unwrap_or(false)
}

/// A global shortcut without a modifier would swallow that key in every app.
pub fn global_allowed(combo: &str) -> bool {
    let mut parts: Vec<&str> = combo.split('+').collect();
    let code = parts.pop().unwrap_or("");
    !parts.is_empty() || is_fkey(code) || code.starts_with("Media") || code.starts_with("AudioVolume")
}

/// "Mod+Alt+ArrowRight" (the UI's physical-key combos) → "CommandOrControl+Alt+ArrowRight".
pub fn to_accelerator(combo: &str) -> String {
    combo
        .split('+')
        .map(|p| match p {
            "Mod" => "CommandOrControl",
            "Ctrl" => "Control",
            "Meta" => "Super",
            other => other,
        })
        .collect::<Vec<_>>()
        .join("+")
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn send_main(app: &AppHandle, cmd: Value) {
    let _ = app.emit_to("main", "player:command", cmd);
}

/// Commands from the mini player, tray, shortcuts and media keys.
pub fn command(app: &AppHandle, cmd: Value) {
    match cmd.get("cmd").and_then(Value::as_str) {
        Some("show") => show_main(app),
        Some("mini") => toggle_mini(app),
        _ => send_main(app, cmd),
    }
}

impl Remote {
    fn strings(&self) -> MainStrings {
        self.strings.lock().unwrap().clone().unwrap_or_else(MainStrings::english)
    }

    /// Applies desktop preferences; returns the global shortcuts that could not be registered.
    pub fn set_prefs(&self, app: &AppHandle, p: AppPrefs, strings: MainStrings) -> Vec<String> {
        let changed = {
            let old = self.prefs.lock().unwrap();
            old.global_shortcuts != p.global_shortcuts || old.global_hotkeys != p.global_hotkeys
        };
        *self.prefs.lock().unwrap() = p.clone();
        *self.strings.lock().unwrap() = Some(strings);
        let failed = if changed || self.registered.lock().unwrap().is_empty() {
            self.apply_shortcuts(app)
        } else {
            Vec::new()
        };
        if let Some(mini) = app.get_webview_window("mini") {
            let _ = mini.set_always_on_top(p.mini_on_top);
        }
        if p.close_to_tray {
            self.ensure_tray(app);
        }
        self.update_tray(app);
        failed
    }

    fn apply_shortcuts(&self, app: &AppHandle) -> Vec<String> {
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();
        let mut registered = self.registered.lock().unwrap();
        registered.clear();
        let mut failed = Vec::new();
        let prefs = self.prefs.lock().unwrap().clone();
        if !prefs.global_shortcuts {
            return failed;
        }
        for (action, combos) in &prefs.global_hotkeys {
            let Some(cmd) = command_for(action) else { continue };
            for combo in combos {
                if !global_allowed(combo) {
                    failed.push(combo.clone());
                    continue;
                }
                let acc = to_accelerator(combo);
                let cmd = cmd.clone();
                let ok = gs
                    .on_shortcut(acc.as_str(), move |app, _, e| {
                        if e.state() == ShortcutState::Pressed {
                            command(app, cmd.clone());
                        }
                    })
                    .is_ok();
                if ok {
                    registered.push(acc);
                } else {
                    failed.push(combo.clone());
                }
            }
        }
        failed
    }

    pub fn ensure_tray(&self, app: &AppHandle) {
        if self.tray.lock().unwrap().is_some() {
            return;
        }
        let mut b = TrayIconBuilder::with_id("velvet")
            .tooltip("Velvet")
            .show_menu_on_left_click(false)
            .on_menu_event(|app, e| match e.id.as_ref() {
                "toggle" | "next" | "prev" => send_main(app, json!({ "cmd": e.id.as_ref() })),
                "show" => show_main(app),
                "mini" => toggle_mini(app),
                "quit" => crate::request_quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, e| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = e
                {
                    show_main(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            b = b.icon(icon.clone());
        }
        if let Ok(tray) = b.build(app) {
            *self.tray.lock().unwrap() = Some(tray);
        }
        self.update_tray(app);
    }

    fn update_tray(&self, app: &AppHandle) {
        let tray = self.tray.lock().unwrap();
        let Some(tray) = tray.as_ref() else { return };
        let s = self.strings();
        let st = self.state.lock().unwrap().clone();
        let now = match &st {
            Some(st) if !st.title.is_empty() => {
                if st.artist.is_empty() {
                    st.title.clone()
                } else {
                    format!("{} — {}", st.title, st.artist)
                }
            }
            _ => s.nothing.clone(),
        };
        let tip: String = format!("Velvet · {now}").chars().take(120).collect();
        let _ = tray.set_tooltip(Some(&tip));
        let playing = st.map(|s| s.playing).unwrap_or(false);
        let item = |id: &str, text: &str, enabled: bool| MenuItem::with_id(app, id, text, enabled, None::<&str>);
        let sep = || PredefinedMenuItem::separator(app);
        let menu = (|| -> tauri::Result<Menu<tauri::Wry>> {
            let label: String = now.chars().take(60).collect();
            Menu::with_items(
                app,
                &[
                    &item("now", &label, false)?,
                    &sep()?,
                    &item("toggle", if playing { &s.pause } else { &s.play }, true)?,
                    &item("next", &s.next, true)?,
                    &item("prev", &s.prev, true)?,
                    &sep()?,
                    &item("show", &s.show, true)?,
                    &item("mini", &s.mini, true)?,
                    &sep()?,
                    &item("quit", &s.quit, true)?,
                ],
            )
        })();
        if let Ok(menu) = menu {
            let _ = tray.set_menu(Some(menu));
        }
    }

    /// State pushed by the main window; forwarded to the mini player, tray, media overlay and notifications.
    pub fn set_state(&self, app: &AppHandle, next: RemoteState) {
        let prev = self.state.lock().unwrap().replace(next.clone());
        let _ = app.emit_to("mini", "player:state", &next);
        let changed = prev
            .as_ref()
            .map(|p| p.track_id != next.track_id || p.playing != next.playing || p.title != next.title)
            .unwrap_or(true);
        if changed {
            self.update_tray(app);
        }
        self.update_smtc(app, &next);
        let notify = self.prefs.lock().unwrap().notifications;
        if notify && next.track_id.is_some() && next.playing && prev.and_then(|p| p.track_id) != next.track_id {
            let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
            if !focused {
                let body = [next.artist.as_str(), next.album.as_str()]
                    .iter()
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" · ");
                let title = if next.title.is_empty() { "Velvet" } else { next.title.as_str() };
                let _ = app.notification().builder().title(title).body(body).show();
            }
        }
    }

    // ── media keys and the system media overlay ────────────────────────────────

    pub fn init_smtc(&self, app: &AppHandle) {
        let Some(main) = app.get_webview_window("main") else { return };
        #[cfg(windows)]
        let hwnd = main.hwnd().ok().map(|h| h.0);
        #[cfg(not(windows))]
        let hwnd = {
            let _ = &main;
            None
        };
        let config = souvlaki::PlatformConfig {
            display_name: "Velvet",
            dbus_name: "velvet",
            hwnd,
        };
        let Ok(mut controls) = souvlaki::MediaControls::new(config) else {
            return;
        };
        let app2 = app.clone();
        let playing = self.smtc_playing.clone();
        let attached = controls.attach(move |e: souvlaki::MediaControlEvent| {
            use souvlaki::MediaControlEvent as E;
            let is_playing = playing.load(Ordering::SeqCst);
            match e {
                E::Toggle => send_main(&app2, json!({ "cmd": "toggle" })),
                E::Play if !is_playing => send_main(&app2, json!({ "cmd": "toggle" })),
                E::Pause | E::Stop if is_playing => send_main(&app2, json!({ "cmd": "toggle" })),
                E::Next => send_main(&app2, json!({ "cmd": "next" })),
                E::Previous => send_main(&app2, json!({ "cmd": "prev" })),
                E::SetPosition(p) => send_main(&app2, json!({ "cmd": "seek", "value": p.0.as_secs_f64() })),
                E::Raise => show_main(&app2),
                E::Quit => crate::request_quit(&app2),
                _ => {}
            }
        });
        if attached.is_ok() {
            *self.smtc.lock().unwrap() = Some(Smtc(controls));
        }
    }

    fn update_smtc(&self, app: &AppHandle, s: &RemoteState) {
        self.smtc_playing.store(s.playing, Ordering::SeqCst);
        let track_changed = {
            let mut last = self.smtc_track.lock().unwrap();
            let key = format!("{:?}|{}|{}|{:?}", s.track_id, s.title, s.artist, s.cover_path);
            let changed = last.as_deref() != Some(key.as_str());
            *last = Some(key);
            changed
        };
        let s = s.clone();
        let app2 = app.clone();
        // the system media controls belong to the UI thread
        let _ = app.run_on_main_thread(move || {
            let remote = app2.state::<crate::AppState>();
            let mut guard = remote.remote.smtc.lock().unwrap();
            let Some(Smtc(controls)) = guard.as_mut() else { return };
            if track_changed {
                let cover = s.cover_path.as_ref().map(|p| format!("file://{p}"));
                let _ = controls.set_metadata(souvlaki::MediaMetadata {
                    title: Some(&s.title).filter(|t| !t.is_empty()).map(|t| t.as_str()),
                    artist: Some(&s.artist).filter(|t| !t.is_empty()).map(|t| t.as_str()),
                    album: Some(&s.album).filter(|t| !t.is_empty()).map(|t| t.as_str()),
                    cover_url: cover.as_deref(),
                    duration: (s.duration > 0.0).then(|| std::time::Duration::from_secs_f64(s.duration)),
                });
            }
            let progress = Some(souvlaki::MediaPosition(std::time::Duration::from_secs_f64(s.position.max(0.0))));
            let playback = if s.track_id.is_none() {
                souvlaki::MediaPlayback::Stopped
            } else if s.playing {
                souvlaki::MediaPlayback::Playing { progress }
            } else {
                souvlaki::MediaPlayback::Paused { progress }
            };
            let _ = controls.set_playback(playback);
        });
    }

    pub fn dispose(&self, app: &AppHandle) {
        let _ = app.global_shortcut().unregister_all();
        if let Some(tray) = self.tray.lock().unwrap().take() {
            let _ = tray.set_visible(false);
        }
        self.smtc.lock().unwrap().take();
    }
}

/// The system media controls are used from the UI thread only.
struct Smtc(souvlaki::MediaControls);
unsafe impl Send for Smtc {}

pub fn toggle_mini(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("mini") {
        let _ = w.close();
        return;
    }
    let on_top = app.state::<crate::AppState>().remote.prefs.lock().unwrap().mini_on_top;
    let built = WebviewWindowBuilder::new(app, "mini", crate::ui_url("#mini"))
        .title("Velvet Mini")
        .inner_size(400.0, 128.0)
        .min_inner_size(320.0, 128.0)
        .max_inner_size(1200.0, 128.0)
        .decorations(false)
        .transparent(!cfg!(target_os = "linux"))
        .shadow(false)
        .resizable(true)
        .maximizable(false)
        .always_on_top(on_top)
        .visible(false)
        .on_page_load(|w, p| {
            if p.event() == PageLoadEvent::Finished {
                let _ = w.show();
            }
        })
        .build();
    if let Ok(w) = built {
        let app2 = app.clone();
        w.on_window_event(move |e| {
            if let tauri::WindowEvent::Destroyed = e {
                let _ = app2.emit_to("main", "mini:closed", ());
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_combos_to_accelerators() {
        assert_eq!(to_accelerator("Mod+Alt+ArrowRight"), "CommandOrControl+Alt+ArrowRight");
        assert_eq!(to_accelerator("Ctrl+Shift+KeyL"), "Control+Shift+KeyL");
        assert!(global_allowed("Mod+Alt+Space"));
        assert!(global_allowed("F9"));
        assert!(global_allowed("MediaPlayPause"));
        assert!(!global_allowed("KeyL"));
        // every default combo parses as a system shortcut
        for c in [
            "Mod+Alt+Space",
            "Mod+Alt+ArrowRight",
            "Mod+Alt+ArrowLeft",
            "Mod+Alt+ArrowUp",
            "Mod+Alt+ArrowDown",
            "Ctrl+Shift+KeyL",
            "F9",
            "MediaPlayPause",
        ] {
            assert!(to_accelerator(c).parse::<tauri_plugin_global_shortcut::Shortcut>().is_ok(), "{c}");
        }
    }
}
