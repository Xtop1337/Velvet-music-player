//! External programs: yt-dlp (downloaded on demand, as before) and ffmpeg
//! (downloaded the first time an import or export needs it, verified with SHA-256).

use crate::net::client;
use crate::paths;
use crate::types::YtDlpStatus;
use futures_util::StreamExt;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

/// A process started without a console window.
pub fn command(bin: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(bin);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW
        c.creation_flags(0x0800_0000);
    }
    c.stdin(Stdio::null()).kill_on_drop(true);
    c
}

pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run_capture(bin: &str, args: &[String], timeout: Duration) -> Output {
    let child = command(bin).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    let child = match child {
        Ok(c) => c,
        Err(e) => {
            return Output {
                code: -1,
                stdout: String::new(),
                stderr: e.to_string(),
            }
        }
    };
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => Output {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        },
        Ok(Err(e)) => Output {
            code: -1,
            stdout: String::new(),
            stderr: e.to_string(),
        },
        Err(_) => Output {
            code: -1,
            stdout: String::new(),
            stderr: "timed out".into(),
        },
    }
}

/// Cancels a running job (its process is killed).
#[derive(Clone, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Cancel {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await
    }
}

/// Runs a program and hands each stdout line (split on \r and \n) to `on_line`.
/// Returns the exit code and the tail of stderr.
pub async fn run_lines(bin: &str, args: &[String], cancel: &Cancel, mut on_line: impl FnMut(&str)) -> (i32, String) {
    let mut child = match command(bin).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => return (-1, e.to_string()),
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > 20_000 {
                buf.drain(..buf.len() - 10_000);
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        tokio::select! {
            r = stdout.read(&mut chunk) => {
                let n: usize = r.unwrap_or_default();
                if n == 0 { break }
                pending.extend_from_slice(&chunk[..n]);
                while let Some(i) = pending.iter().position(|b| *b == b'\n' || *b == b'\r') {
                    let line: Vec<u8> = pending.drain(..=i).collect();
                    let text = String::from_utf8_lossy(&line[..line.len() - 1]).trim().to_string();
                    if !text.is_empty() { on_line(&text) }
                }
            }
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                break;
            }
        }
    }
    let rest = String::from_utf8_lossy(&pending).trim().to_string();
    if !rest.is_empty() {
        on_line(&rest);
    }
    let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
    let stderr = err_task.await.unwrap_or_default();
    (code, stderr)
}

/// The most useful line of a failed run's stderr.
pub fn last_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    let line = lines
        .iter()
        .rev()
        .find(|l| l.starts_with("ERROR"))
        .or(lines.last())
        .copied()
        .unwrap_or("");
    line.trim_start_matches("ERROR:").trim().chars().take(300).collect()
}

async fn download_to(url: &str, target: &Path, mut progress: impl FnMut(u64, Option<u64>)) -> Result<String, String> {
    let res = client().get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("download failed: HTTP {}", res.status().as_u16()));
    }
    let total = res.content_length();
    let mut file = tokio::fs::File::create(target).await.map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut done = 0u64;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        progress(done, total);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(hex::encode(hash.finalize()))
}

// ── yt-dlp ─────────────────────────────────────────────────────────────────────

fn ytdlp_exe() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

fn ytdlp_asset() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else if cfg!(target_arch = "aarch64") {
        "yt-dlp_linux_aarch64"
    } else {
        "yt-dlp_linux"
    }
}

static YTDLP: Mutex<Option<YtDlpStatus>> = Mutex::new(None);

pub async fn ytdlp_status(force: bool) -> YtDlpStatus {
    if !force {
        if let Some(s) = YTDLP.lock().unwrap().clone() {
            return s;
        }
    }
    let downloaded = paths::bin().join(ytdlp_exe());
    let candidates = [
        (downloaded.to_string_lossy().into_owned(), "downloaded"),
        (ytdlp_exe().to_string(), "system"),
    ];
    for (path, source) in candidates {
        if source != "system" && !Path::new(&path).exists() {
            continue;
        }
        let r = run_capture(&path, &["--version".into()], Duration::from_secs(20)).await;
        if r.code == 0 {
            let s = YtDlpStatus {
                installed: true,
                version: Some(r.stdout.trim().to_string()),
                path: Some(path),
                source: Some(source.into()),
            };
            *YTDLP.lock().unwrap() = Some(s.clone());
            return s;
        }
    }
    let s = YtDlpStatus {
        installed: false,
        ..Default::default()
    };
    *YTDLP.lock().unwrap() = Some(s.clone());
    s
}

/// Downloads (or updates) the standalone yt-dlp into the data folder.
pub async fn install_ytdlp() -> Result<YtDlpStatus, String> {
    let url = format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}", ytdlp_asset());
    let target = paths::bin().join(ytdlp_exe());
    let tmp = target.with_extension("download");
    download_to(&url, &tmp, |_, _| {}).await.map_err(|e| format!("yt-dlp {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(ytdlp_status(true).await)
}

pub async fn require_ytdlp() -> Result<String, String> {
    let mut status = ytdlp_status(false).await;
    if !status.installed {
        status = install_ytdlp().await?;
    }
    status.path.ok_or_else(|| "yt-dlp is not available".to_string())
}

/// Runs yt-dlp with `-J` and parses its JSON output.
pub async fn ytdlp_json(bin: &str, args: &[String], timeout: Duration) -> Result<Value, String> {
    let mut all = vec!["--no-warnings".to_string(), "-J".to_string()];
    all.extend_from_slice(args);
    let r = run_capture(bin, &all, timeout).await;
    if r.code != 0 {
        let e = last_error(&r.stderr);
        return Err(if e.is_empty() {
            format!("yt-dlp exited with {}", r.code)
        } else {
            e
        });
    }
    serde_json::from_str(&r.stdout).map_err(|e| e.to_string())
}

// ── ffmpeg ─────────────────────────────────────────────────────────────────────

fn ffmpeg_exe() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

const FFMPEG_BASE: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
const FFMPEG_ZIP: &str = "ffmpeg-master-latest-win64-gpl.zip";

static FFMPEG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// ffmpeg if it is already here (downloaded before, or installed in the system).
pub async fn ffmpeg_existing() -> Option<String> {
    let local = paths::bin().join(ffmpeg_exe());
    if local.exists() {
        return Some(local.to_string_lossy().into_owned());
    }
    let r = run_capture("ffmpeg", &["-version".into()], Duration::from_secs(10)).await;
    (r.code == 0).then(|| "ffmpeg".to_string())
}

/// ffmpeg, downloading it on first use. `progress` gets 0..1 while downloading.
pub async fn ffmpeg_path(progress: impl FnMut(f64)) -> Result<String, String> {
    let _guard = FFMPEG_LOCK.lock().await;
    if let Some(p) = ffmpeg_existing().await {
        return Ok(p);
    }
    if !cfg!(windows) {
        return Err("ffmpeg not found: install it with your package manager".into());
    }
    download_ffmpeg(progress).await
}

fn expected_sha(checksums: &str, file: &str) -> Option<String> {
    checksums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let (sum, name) = (it.next()?, it.next()?);
        (name.trim_start_matches('*') == file).then(|| sum.to_lowercase())
    })
}

async fn download_ffmpeg(mut progress: impl FnMut(f64)) -> Result<String, String> {
    let bin = paths::bin();
    let zip_path = bin.join("ffmpeg.zip.download");
    let mut last_err = String::new();
    // "latest" is rebuilt daily: if the checksum list and the archive come from different
    // builds, one more try picks up a matching pair
    for _ in 0..2 {
        let sums = client()
            .get(format!("{FFMPEG_BASE}/checksums.sha256"))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        let want = expected_sha(&sums, FFMPEG_ZIP).ok_or("ffmpeg: checksum not published")?;
        let got = download_to(&format!("{FFMPEG_BASE}/{FFMPEG_ZIP}"), &zip_path, |d, t| {
            if let Some(t) = t.filter(|t| *t > 0) {
                progress(d as f64 / t as f64)
            }
        })
        .await?;
        if got == want {
            let out = tauri::async_runtime::spawn_blocking(move || extract_ffmpeg(&zip_path))
                .await
                .map_err(|e| e.to_string())?;
            return out;
        }
        last_err = "ffmpeg: checksum mismatch".into();
    }
    let _ = std::fs::remove_file(&zip_path);
    Err(last_err)
}

fn extract_ffmpeg(zip_path: &PathBuf) -> Result<String, String> {
    let bin = paths::bin();
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for name in ["ffmpeg.exe", "ffprobe.exe"] {
        let entry = (0..archive.len())
            .find(|i| {
                archive
                    .by_index(*i)
                    .map(|f| f.name().map(|n| n.ends_with(&format!("/bin/{name}"))).unwrap_or(false))
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("{name} not found in the archive"))?;
        let mut src = archive.by_index(entry).map_err(|e| e.to_string())?;
        let tmp = bin.join(format!("{name}.tmp"));
        let mut dst = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut src, &mut dst).map_err(|e| e.to_string())?;
        drop(dst);
        std::fs::rename(&tmp, bin.join(name)).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(zip_path);
    Ok(bin.join(ffmpeg_exe()).to_string_lossy().into_owned())
}

static RUBBERBAND: Mutex<Option<bool>> = Mutex::new(None);

pub async fn has_rubberband(ff: &str) -> bool {
    if let Some(v) = *RUBBERBAND.lock().unwrap() {
        return v;
    }
    let r = run_capture(ff, &["-hide_banner".into(), "-filters".into()], Duration::from_secs(20)).await;
    let v = r.stdout.contains(" rubberband ");
    *RUBBERBAND.lock().unwrap() = Some(v);
    v
}

static IRNORM: Mutex<Option<bool>> = Mutex::new(None);

pub async fn afir_has_irnorm(ff: &str) -> bool {
    if let Some(v) = *IRNORM.lock().unwrap() {
        return v;
    }
    let r = run_capture(
        ff,
        &["-hide_banner".into(), "-h".into(), "filter=afir".into()],
        Duration::from_secs(20),
    )
    .await;
    let v = r.stdout.contains("irnorm");
    *IRNORM.lock().unwrap() = Some(v);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_checksum_line() {
        let sums = "aa  other.zip\n280B6E  ffmpeg-master-latest-win64-gpl.zip\n";
        assert_eq!(expected_sha(sums, FFMPEG_ZIP).as_deref(), Some("280b6e"));
        assert_eq!(expected_sha(sums, "missing.zip"), None);
    }

    #[test]
    fn extracts_ffmpeg_and_ffprobe_from_the_build_archive() {
        use std::io::Write;
        let _env = crate::paths::TEST_ENV.blocking_lock();
        let dir = std::env::temp_dir().join(format!("velvet-zip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("VELVET_DATA_DIR", &dir);
        let zip_path = dir.join("ff.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, body) in [
            ("ffmpeg-master/bin/ffmpeg.exe", "FF"),
            ("ffmpeg-master/bin/ffprobe.exe", "FP"),
            ("ffmpeg-master/bin/ffplay.exe", "PL"),
        ] {
            w.start_file(name, opts).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
        let out = extract_ffmpeg(&zip_path).unwrap();
        let bin = dir.join("bin");
        assert_eq!(std::fs::read_to_string(bin.join("ffmpeg.exe")).unwrap(), "FF");
        assert_eq!(std::fs::read_to_string(bin.join("ffprobe.exe")).unwrap(), "FP");
        assert!(!bin.join("ffplay.exe").exists());
        assert!(!zip_path.exists());
        assert!(out.ends_with(ffmpeg_exe()) || out.ends_with("ffmpeg.exe") || out.ends_with("ffmpeg"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reports_the_last_error_line() {
        assert_eq!(
            last_error("[info] x\nERROR: [youtube] abc: Video unavailable\nsome trace"),
            "[youtube] abc: Video unavailable"
        );
        assert_eq!(last_error("just this"), "just this");
    }

    #[tokio::test]
    async fn streams_lines_and_cancels() {
        if cfg!(windows) {
            return;
        }
        let mut lines = Vec::new();
        let (code, _) = run_lines("sh", &["-c".into(), "printf 'a\\rb\\nc'".into()], &Cancel::default(), |l| {
            lines.push(l.to_string())
        })
        .await;
        assert_eq!((code, lines), (0, vec!["a".to_string(), "b".into(), "c".into()]));
        let cancel = Cancel::default();
        let c2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            c2.cancel();
        });
        let started = std::time::Instant::now();
        run_lines("sleep", &["5".into()], &cancel, |_| {}).await;
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
