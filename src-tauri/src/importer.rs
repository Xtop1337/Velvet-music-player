//! Importing from links: SoundCloud / YouTube download directly with yt-dlp;
//! Spotify gives the metadata and the best YouTube / SoundCloud match gives the audio.

use crate::library::read_track;
use crate::links::parse_music_link;
use crate::matcher::{pick_best, safe_file_name, split_artist_title, Candidate, Want};
use crate::spotify::{self, SpotifyItem};
use crate::tools::{self, Cancel};
use crate::types::{ImportOptions, ImportProgress, Track};
use crate::{covers, paths, tags};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const PROG: &str = "VELVET_PROG";
const DONE: &str = "VELVET_JSON";

struct Job {
    progress: Mutex<ImportProgress>,
    cancel: Cancel,
}

#[derive(Default)]
pub struct Importer {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

struct DownloadMeta {
    title: String,
    artist: String,
    album: String,
    cover_url: Option<String>,
    source_url: String,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()).map(String::from)
}

struct Ctx {
    app: AppHandle,
    job: Arc<Job>,
}

impl Ctx {
    fn emit(&self) {
        let p = self.job.progress.lock().unwrap().clone();
        let _ = self.app.emit("import:progress", p);
    }
    fn update(&self, f: impl FnOnce(&mut ImportProgress)) {
        f(&mut self.job.progress.lock().unwrap());
        self.emit();
    }
    fn cancelled(&self) -> bool {
        self.job.cancel.is_cancelled()
    }
    fn fail(&self, error: String) {
        if self.cancelled() {
            return;
        }
        self.update(|p| {
            p.state = "error".into();
            p.error = Some(error);
        });
    }
    fn finish(&self) {
        if self.cancelled() {
            return;
        }
        self.update(|p| {
            p.state = if p.completed == 0 && p.failed > 0 {
                "error".into()
            } else {
                "done".into()
            };
            p.current = None;
            p.percent = 1.0;
            if p.state == "error" && p.error.is_none() {
                p.error = Some("all-failed".into());
            }
        });
    }
    fn add_track(&self, track: Track) {
        let job_id = {
            let mut p = self.job.progress.lock().unwrap();
            p.completed += 1;
            p.track_ids.push(track.id.clone());
            p.job_id.clone()
        };
        let _ = self.app.emit("import:track", (job_id, track));
    }
    fn item_failed(&self, e: String) {
        self.update(|p| {
            p.failed += 1;
            p.error = Some(e);
        });
    }
}

impl Importer {
    pub fn start(&self, app: AppHandle, opts: ImportOptions) -> String {
        let job_id = uuid::Uuid::new_v4().to_string();
        let job = Arc::new(Job {
            progress: Mutex::new(ImportProgress {
                job_id: job_id.clone(),
                url: opts.url.clone(),
                state: "resolving".into(),
                ..Default::default()
            }),
            cancel: Cancel::default(),
        });
        self.jobs.lock().unwrap().insert(job_id.clone(), job.clone());
        let ctx = Ctx { app, job };
        ctx.emit();
        tauri::async_runtime::spawn(async move {
            let Some(link) = parse_music_link(&opts.url) else {
                return ctx.fail("unsupported-link".into());
            };
            let run = if link.service == "spotify" {
                run_spotify(&ctx, &link.kind, link.id.as_deref().unwrap_or(""), &opts).await
            } else {
                run_direct(&ctx, &link.url, &opts).await
            };
            if let Err(e) = run {
                ctx.fail(e);
            }
        });
        job_id
    }

    pub fn cancel(&self, app: &AppHandle, job_id: &str) {
        let Some(job) = self.jobs.lock().unwrap().get(job_id).cloned() else {
            return;
        };
        let mut p = job.progress.lock().unwrap();
        if p.state == "done" {
            return;
        }
        job.cancel.cancel();
        p.state = "cancelled".into();
        let _ = app.emit("import:progress", p.clone());
    }
}

/// yt-dlp needs ffmpeg to convert audio; the first import downloads it.
async fn ensure_ffmpeg(ctx: &Ctx, opts: &ImportOptions) -> Result<Option<String>, String> {
    if let Some(ff) = tools::ffmpeg_existing().await {
        return Ok(Some(ff));
    }
    ctx.update(|p| {
        p.current = Some("ffmpeg".into());
        p.percent = 0.0;
    });
    let app = ctx.app.clone();
    let job = ctx.job.clone();
    let mut last = 0.0;
    match tools::ffmpeg_path(move |f| {
        if f - last >= 0.01 || f >= 1.0 {
            last = f;
            let mut p = job.progress.lock().unwrap();
            p.percent = f;
            let _ = app.emit("import:progress", p.clone());
        }
    })
    .await
    {
        Ok(ff) => Ok(Some(ff)),
        // the original audio can still be kept as it is
        Err(_) if opts.format == "best" => Ok(None),
        Err(e) => Err(e),
    }
}

async fn run_direct(ctx: &Ctx, url: &str, opts: &ImportOptions) -> Result<(), String> {
    let bin = tools::require_ytdlp().await?;
    let info = tools::ytdlp_json(&bin, &["--flat-playlist".into(), url.to_string()], Duration::from_secs(60)).await?;
    if ctx.cancelled() {
        return Ok(());
    }
    let list = info.get("_type").and_then(Value::as_str) == Some("playlist") && info.get("entries").map(Value::is_array).unwrap_or(false);
    let entries: Vec<Value> = if list {
        info["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| s(e, "url").is_some() || s(e, "webpage_url").is_some())
            .cloned()
            .collect()
    } else {
        vec![info.clone()]
    };
    let title = s(&info, "title");
    let kind = if !list {
        "track"
    } else if url.contains("/sets/") || url.to_lowercase().contains("album") {
        "album"
    } else {
        "playlist"
    };
    ctx.update(|p| {
        p.title = title.clone();
        p.kind = Some(kind.into());
        p.total = entries.len() as u32;
        p.state = "downloading".into();
    });
    let ff = ensure_ffmpeg(ctx, opts).await?;

    for entry in entries {
        if ctx.cancelled() {
            return Ok(());
        }
        let entry_url = if list {
            s(&entry, "webpage_url").or_else(|| s(&entry, "url")).unwrap_or_default()
        } else {
            url.to_string()
        };
        ctx.update(|p| {
            p.current = Some(s(&entry, "title").unwrap_or_else(|| entry_url.clone()));
            p.percent = 0.0;
        });
        let service = if entry_url.contains("soundcloud") {
            "soundcloud"
        } else {
            "youtube"
        };
        match download(ctx, &bin, ff.as_deref(), &entry_url, opts, None, service).await {
            Ok(mut track) => {
                if kind == "album" && track.album.is_empty() {
                    track.album = title.clone().unwrap_or_default();
                }
                ctx.add_track(track);
                ctx.emit();
            }
            Err(_) if ctx.cancelled() => return Ok(()),
            Err(e) => ctx.item_failed(e),
        }
    }
    ctx.finish();
    Ok(())
}

async fn run_spotify(ctx: &Ctx, kind: &str, id: &str, opts: &ImportOptions) -> Result<(), String> {
    let release = spotify::fetch(kind, id, opts.spotify_client_id.as_deref(), opts.spotify_client_secret.as_deref()).await?;
    if ctx.cancelled() {
        return Ok(());
    }
    let bin = tools::require_ytdlp().await?;
    ctx.update(|p| {
        p.title = Some(release.name.clone());
        p.kind = Some(kind.into());
        p.total = release.items.len() as u32;
        p.state = "downloading".into();
    });
    let ff = ensure_ffmpeg(ctx, opts).await?;

    for item in release.items.iter().cloned() {
        if ctx.cancelled() {
            return Ok(());
        }
        ctx.update(|p| {
            p.current = Some(format!("{} — {}", item.artists.join(", "), item.title));
            p.percent = 0.0;
        });
        let result: Result<Track, String> = async {
            let item = if kind == "playlist" {
                spotify::enrich_from_track_embed(item).await
            } else {
                item
            };
            let m = find_audio(&bin, &item).await.ok_or_else(|| format!("not-found: {}", item.title))?;
            let meta = DownloadMeta {
                title: item.title.clone(),
                artist: item.artists.join(", "),
                album: item.album.clone(),
                cover_url: item.cover_url.clone().or_else(|| release.cover_url.clone()),
                source_url: item.url.clone(),
            };
            download(ctx, &bin, ff.as_deref(), &m.url, opts, Some(meta), "spotify").await
        }
        .await;
        match result {
            Ok(track) => {
                ctx.add_track(track);
                ctx.emit();
            }
            Err(_) if ctx.cancelled() => return Ok(()),
            Err(e) => ctx.item_failed(e),
        }
    }
    ctx.finish();
    Ok(())
}

async fn find_audio(bin: &str, item: &SpotifyItem) -> Option<Candidate> {
    let want = Want {
        title: &item.title,
        artists: &item.artists,
        duration_sec: item.duration_ms / 1000.0,
    };
    let query = format!("{} - {}", item.artists.join(" "), item.title);
    for search in [format!("ytsearch6:{query} audio"), format!("scsearch5:{query}")] {
        let Ok(res) = tools::ytdlp_json(bin, &["--flat-playlist".into(), search], Duration::from_secs(60)).await else {
            continue;
        };
        let cands: Vec<Candidate> = res
            .get("entries")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|e| {
                        Some(Candidate {
                            url: s(e, "webpage_url").or_else(|| s(e, "url"))?,
                            title: s(e, "title").unwrap_or_default(),
                            channel: s(e, "channel").or_else(|| s(e, "uploader")),
                            duration: e.get("duration").and_then(Value::as_f64),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if let Some(best) = pick_best(&cands, &want) {
            return Some(best);
        }
    }
    None
}

async fn download(
    ctx: &Ctx,
    bin: &str,
    ffmpeg: Option<&str>,
    url: &str,
    opts: &ImportOptions,
    meta: Option<DownloadMeta>,
    source: &str,
) -> Result<Track, String> {
    let dir = if opts.download_dir.is_empty() {
        paths::default_downloads()
    } else {
        PathBuf::from(&opts.download_dir)
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let thumbs = paths::cache().join("thumbs");
    std::fs::create_dir_all(&thumbs).map_err(|e| e.to_string())?;

    let name = match &meta {
        Some(m) => safe_file_name(&format!("{} - {}", m.artist, m.title)).replace('%', "%%"),
        None => "%(uploader)s - %(title)s".into(),
    };
    let format = if opts.format == "m4a" {
        "bestaudio[ext=m4a]/bestaudio/best"
    } else {
        "bestaudio/best"
    };
    let mut args: Vec<String> = vec![
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--progress",
        "--windows-filenames",
        "--no-mtime",
        "-f",
        format,
        "-x",
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    args.extend([
        "-o".into(),
        dir.join(format!("{name}.%(ext)s")).to_string_lossy().into_owned(),
        "-o".into(),
        format!("thumbnail:{}", thumbs.join("%(id)s.%(ext)s").to_string_lossy()),
        "--progress-template".into(),
        format!("download:{PROG} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s"),
        "--print".into(),
        format!("after_move:{DONE} %(.{{id,title,uploader,artist,album,track,thumbnail,duration,webpage_url,filepath}})j"),
    ]);
    if opts.format != "best" {
        args.extend(["--audio-format".into(), opts.format.clone(), "--audio-quality".into(), "0".into()]);
    }
    if let Some(ff) = ffmpeg {
        args.extend(["--ffmpeg-location".into(), ff.to_string()]);
    }
    args.extend(["--".into(), url.to_string()]);

    let mut result: Option<Value> = None;
    let (code, stderr) = tools::run_lines(bin, &args, &ctx.job.cancel, |line| {
        if let Some(rest) = line.strip_prefix(PROG) {
            let nums: Vec<f64> = rest.split_whitespace().map(|v| v.parse().unwrap_or(0.0)).collect();
            let (done, total, est) = (
                nums.first().copied().unwrap_or(0.0),
                nums.get(1).copied().unwrap_or(0.0),
                nums.get(2).copied().unwrap_or(0.0),
            );
            let t = if total > 0.0 { total } else { est };
            if t > 0.0 {
                ctx.update(|p| p.percent = (done / t).min(1.0));
            }
        } else if let Some(json) = line.strip_prefix(DONE) {
            result = serde_json::from_str(json.trim()).ok();
        }
    })
    .await;
    if ctx.cancelled() {
        return Err("cancelled".into());
    }
    let info = result.unwrap_or(Value::Null);
    let Some(filepath) = s(&info, "filepath").filter(|_| code == 0) else {
        let e = tools::last_error(&stderr);
        return Err(if e.is_empty() { format!("yt-dlp exited with {code}") } else { e });
    };

    let fp = filepath.clone();
    let src = source.to_string();
    let mut track = tauri::async_runtime::spawn_blocking(move || read_track(&fp, &src))
        .await
        .map_err(|e| e.to_string())?;
    let base_title = s(&info, "track")
        .or_else(|| s(&info, "title"))
        .unwrap_or_else(|| track.title.clone());
    let (artist, title) = split_artist_title(
        &base_title,
        &s(&info, "uploader").unwrap_or_default(),
        s(&info, "artist").as_deref(),
    );
    track.title = meta.as_ref().map(|m| m.title.clone()).unwrap_or(title);
    track.artist = meta.as_ref().map(|m| m.artist.clone()).unwrap_or(artist);
    track.album = meta
        .as_ref()
        .map(|m| m.album.clone())
        .or_else(|| s(&info, "album"))
        .unwrap_or_default();
    if track.duration == 0.0 {
        track.duration = info.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
    }
    track.source_url = Some(
        meta.as_ref()
            .map(|m| m.source_url.clone())
            .or_else(|| s(&info, "webpage_url"))
            .unwrap_or_else(|| url.to_string()),
    );
    track.cover_url = meta.as_ref().and_then(|m| m.cover_url.clone()).or_else(|| s(&info, "thumbnail"));
    track.cover_url_auto = Some(false);

    let thumb = s(&info, "id").map(|id| thumbs.join(format!("{id}.jpg")));
    let thumb_cover = || {
        thumb
            .as_ref()
            .filter(|t| t.exists())
            .and_then(|t| covers::from_file(&t.to_string_lossy()).ok())
    };
    track.cover_path = match meta.as_ref().and_then(|m| m.cover_url.clone()) {
        Some(u) => covers::from_url(&u).await.ok().or_else(thumb_cover),
        None => thumb_cover(),
    };
    if let Some(t) = &thumb {
        let _ = std::fs::remove_file(t);
    }
    let write = tags::TagWrite {
        path: track.path.clone(),
        title: track.title.clone(),
        artist: track.artist.clone(),
        album: track.album.clone(),
        cover_path: track.cover_path.clone(),
        ..Default::default()
    };
    // the library entry keeps the right metadata even if the file refuses tags
    let _ = tauri::async_runtime::spawn_blocking(move || tags::write(&write)).await;
    Ok(track)
}
