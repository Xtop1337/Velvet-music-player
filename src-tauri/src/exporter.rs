//! Exporting a track with the player's sound (speed, pitch, EQ, reverb, limiter) through ffmpeg.

use crate::library::read_track;
use crate::matcher::safe_file_name;
use crate::types::{ExportOptions, ExportProgress};
use crate::{paths, tags, tools};
use lofty::file::AudioFile;
use std::path::{Path, PathBuf};

const CEILING: f64 = 0.966; // the same -0.3 dBFS ceiling as the player's limiter

/// The player's reverb impulse (src/audio), generated identically so exports sound the same.
/// The random generator reproduces the JavaScript arithmetic (doubles, then a 32-bit wrap).
pub fn impulse_samples(sample_rate: u32) -> Vec<f32> {
    let seconds = 2.6;
    let decay = 3.2;
    let length = (sample_rate as f64 * seconds).floor() as usize;
    let pre = (sample_rate as f64 * 0.018).floor() as usize;
    let mut data = vec![0f32; length * 2];
    let mut seed: u32 = 1_234_567;
    let mut rnd = || {
        let x = seed as f64 * 1_103_515_245.0 + 12_345.0;
        seed = ((x.floor() % 4_294_967_296.0) as u64 & 0x7fff_ffff) as u32;
        seed as f64 / 0x7fff_ffff as f64
    };
    for c in 0..2 {
        let mut lp = 0.0f64;
        for i in pre..length {
            let t = (i - pre) as f64 / (length - pre) as f64;
            lp += (rnd() * 2.0 - 1.0 - lp) * (0.55 - 0.4 * t);
            data[i * 2 + c] = (lp * (1.0 - t).powf(decay)) as f32;
        }
    }
    data
}

fn impulse_wav(sample_rate: u32) -> Result<PathBuf, String> {
    let file = paths::cache().join(format!("impulse-{sample_rate}.wav"));
    if file.exists() {
        return Ok(file);
    }
    let data = impulse_samples(sample_rate);
    let bytes = (data.len() * 4) as u32;
    let mut buf = Vec::with_capacity(44 + bytes as usize);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + bytes).to_le_bytes());
    buf.extend_from_slice(b"WAVEfmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    buf.extend_from_slice(&2u16.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&(sample_rate * 8).to_le_bytes());
    buf.extend_from_slice(&8u16.to_le_bytes());
    buf.extend_from_slice(&32u16.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&bytes.to_le_bytes());
    for v in data {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(&file, buf).map_err(|e| e.to_string())?;
    Ok(file)
}

fn atempo_chain(rate: f64) -> Vec<String> {
    let mut out = Vec::new();
    let mut r = rate;
    while r < 0.5 {
        out.push("atempo=0.5".to_string());
        r /= 0.5;
    }
    while r > 2.0 {
        out.push("atempo=2".to_string());
        r /= 2.0;
    }
    out.push(format!("atempo={r:.6}"));
    out
}

/// JavaScript-style number formatting for gains (3 → "3", -1.5 → "-1.5").
fn num(v: f64) -> String {
    let s = format!("{v}");
    s.strip_suffix(".0").map(String::from).unwrap_or(s)
}

/// What the installed ffmpeg can do.
#[derive(Clone, Copy)]
pub struct FfCaps {
    pub rubberband: bool,
    /// `afir=…:irnorm=` (ffmpeg 7+); older builds only know `gtype`
    pub irnorm: bool,
}

/// The ffmpeg filter graph that reproduces the player's sound.
pub fn build_filter_graph(o: &ExportOptions, sample_rate: u32, caps: FfCaps) -> String {
    let has_rubberband = caps.rubberband;
    let mut chain: Vec<String> = Vec::new();
    if (o.rate - 1.0).abs() > 0.0005 {
        if !o.preserves_pitch {
            chain.push(format!("asetrate={}", (sample_rate as f64 * o.rate).round() as u64));
            chain.push(format!("aresample={sample_rate}:resampler=soxr"));
        } else if has_rubberband {
            chain.push(format!("rubberband=tempo={:.6}:pitchq=quality", o.rate));
        } else {
            chain.extend(atempo_chain(o.rate));
        }
    }
    if o.bass != 0.0 {
        chain.push(format!("bass=g={}:f=110:w=0.7", num(o.bass)));
    }
    if o.mid != 0.0 {
        chain.push(format!("equalizer=f=1200:t=q:w=0.8:g={}", num(o.mid)));
    }
    if o.treble != 0.0 {
        chain.push(format!("treble=g={}:f=7500", num(o.treble)));
    }
    let pre = if chain.is_empty() { "anull".to_string() } else { chain.join(",") };
    let limiter = format!("alimiter=limit={CEILING}:level=false:attack=4:release=120");
    if o.reverb <= 0.0 {
        return format!("[0:a]{pre},{limiter}[out]");
    }
    let dry = format!("{:.4}", (o.reverb * std::f64::consts::PI * 0.3).cos());
    let wet = format!("{:.4}", (o.reverb * std::f64::consts::PI * 0.5).sin() * 0.9);
    [
        format!("[0:a]{pre},asplit=2[d][w]"),
        "[w]highpass=f=180[wh]".to_string(),
        format!(
            "[wh][1:a]afir=dry=1:wet=1:{}[wr]",
            if caps.irnorm { "gtype=-1:irnorm=1" } else { "gtype=gn" }
        ),
        format!("[d]volume={dry}[dv]"),
        format!("[wr]volume={wet}[wv]"),
        format!("[dv][wv]amix=inputs=2:normalize=0:duration=first,{limiter}[out]"),
    ]
    .join(";")
}

fn codec_args(format: &str) -> Vec<&'static str> {
    match format {
        "wav" => vec!["-c:a", "pcm_s16le"],
        "flac" => vec!["-c:a", "flac", "-compression_level", "8"],
        _ => vec!["-c:a", "libmp3lame", "-b:a", "320k"],
    }
}

fn unique_file(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut file = dir.join(format!("{base}.{ext}"));
    let mut n = 2;
    while file.exists() {
        file = dir.join(format!("{base} ({n}).{ext}"));
        n += 1;
    }
    file
}

pub async fn export(o: ExportOptions, emit: impl Fn(&ExportProgress) + Send + Sync) -> Result<ExportProgress, String> {
    let running = |percent: f64, file: Option<String>| ExportProgress {
        id: o.id.clone(),
        state: "running".into(),
        percent,
        file,
        ..Default::default()
    };
    emit(&running(0.0, None));
    // the first export downloads ffmpeg; its progress is not the export's
    let ff = tools::ffmpeg_path(|_| {}).await?;
    let src = o.path.clone();
    let (sample_rate, duration) = tauri::async_runtime::spawn_blocking(move || {
        lofty::read_from_path(&src)
            .map(|f| {
                (
                    f.properties().sample_rate().unwrap_or(44_100),
                    f.properties().duration().as_secs_f64(),
                )
            })
            .unwrap_or((44_100, 0.0))
    })
    .await
    .unwrap_or((44_100, 0.0));
    let out_duration = duration / o.rate.max(0.01);
    let dir = if o.out_dir.is_empty() {
        paths::default_downloads().join("Exports")
    } else {
        PathBuf::from(&o.out_dir)
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let artist = if o.artist.is_empty() {
        String::new()
    } else {
        format!("{} - ", o.artist)
    };
    let format = if ["mp3", "wav", "flac"].contains(&o.format.as_str()) {
        o.format.as_str()
    } else {
        "mp3"
    };
    let file = unique_file(&dir, &safe_file_name(&format!("{artist}{} ({})", o.title, o.label)), format);
    let file_s = file.to_string_lossy().into_owned();

    let caps = FfCaps {
        rubberband: tools::has_rubberband(&ff).await,
        irnorm: tools::afir_has_irnorm(&ff).await,
    };
    let graph = build_filter_graph(&o, sample_rate, caps);
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-i", &o.path]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if o.reverb > 0.0 {
        args.extend(["-i".to_string(), impulse_wav(sample_rate)?.to_string_lossy().into_owned()]);
    }
    args.extend(
        ["-filter_complex", &graph, "-map", "[out]", "-map_metadata", "-1", "-vn"]
            .iter()
            .map(|s| s.to_string()),
    );
    args.extend(codec_args(format).iter().map(|s| s.to_string()));
    args.extend(["-progress", "pipe:1", "-nostats", &file_s].iter().map(|s| s.to_string()));

    emit(&running(0.0, Some(file_s.clone())));
    let (code, stderr) = tools::run_lines(&ff, &args, &tools::Cancel::default(), |line| {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) {
            if out_duration > 0.0 {
                emit(&running((us / 1e6 / out_duration).clamp(0.0, 0.99), Some(file_s.clone())));
            }
        }
    })
    .await;
    if code != 0 {
        let last = stderr.trim().lines().last().unwrap_or("").to_string();
        return Err(if last.is_empty() {
            format!("ffmpeg exited with {code}")
        } else {
            last
        });
    }

    let title = format!("{} ({})", o.title, o.label);
    let write = tags::TagWrite {
        path: file_s.clone(),
        title: title.clone(),
        artist: o.artist.clone(),
        album: o.album.clone(),
        cover_path: o.cover_path.clone(),
        ..Default::default()
    };
    let (file2, cover) = (file_s.clone(), o.cover_path.clone());
    let mut track = tauri::async_runtime::spawn_blocking(move || {
        // WAV may not take every tag; the file itself is fine
        let _ = tags::write(&write);
        read_track(&file2, "local")
    })
    .await
    .map_err(|e| e.to_string())?;
    track.title = title;
    track.artist = o.artist.clone();
    track.album = o.album.clone();
    if cover.is_some() {
        track.cover_path = cover;
    }
    let done = ExportProgress {
        id: o.id.clone(),
        state: "done".into(),
        percent: 1.0,
        file: Some(file_s),
        track: Some(track),
        error: None,
    };
    emit(&done);
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: FfCaps = FfCaps {
        rubberband: true,
        irnorm: true,
    };

    fn base() -> ExportOptions {
        ExportOptions {
            rate: 1.0,
            preserves_pitch: true,
            ..Default::default()
        }
    }

    #[test]
    fn resamples_for_slowed_sound_without_auto_tonality() {
        let g = build_filter_graph(
            &ExportOptions {
                rate: 0.8,
                preserves_pitch: false,
                ..base()
            },
            44_100,
            NEW,
        );
        assert!(g.contains("asetrate=35280"));
        assert!(g.contains("aresample=44100"));
        assert!(g.contains("alimiter=limit=0.966"));
    }

    #[test]
    fn uses_rubberband_or_chained_atempo() {
        assert!(build_filter_graph(&ExportOptions { rate: 1.5, ..base() }, 48_000, NEW).contains("rubberband=tempo=1.5"));
        let g = build_filter_graph(
            &ExportOptions { rate: 0.3, ..base() },
            48_000,
            FfCaps {
                rubberband: false,
                irnorm: true,
            },
        );
        assert_eq!(g.matches("atempo=").count(), 2);
        assert!(g.contains("atempo=0.5,atempo=0.600000"));
    }

    #[test]
    fn adds_eq_and_reverb_mixed_like_the_player() {
        let g = build_filter_graph(
            &ExportOptions {
                reverb: 0.38,
                bass: 3.0,
                treble: -2.0,
                ..base()
            },
            44_100,
            NEW,
        );
        assert!(g.contains("afir=dry=1:wet=1:gtype=-1:irnorm=1"));
        let old = build_filter_graph(
            &ExportOptions { reverb: 0.38, ..base() },
            44_100,
            FfCaps {
                rubberband: false,
                irnorm: false,
            },
        );
        assert!(old.contains("afir=dry=1:wet=1:gtype=gn[wr]"));
        assert!(g.contains("bass=g=3:"));
        assert!(g.contains("treble=g=-2:"));
        assert!(g.contains("afir="));
        assert!(g.contains("amix=inputs=2"));
        assert!(!g.contains("equalizer"));
    }

    #[test]
    fn impulse_matches_the_javascript_generator() {
        // values printed by the Electron version's generator in node
        let data = impulse_samples(8000);
        assert_eq!(data.len(), (8000.0f64 * 2.6) as usize * 2);
        assert_eq!(data[0], 0.0); // pre-delay
        let want: [(usize, f64); 6] = [
            (288, 0.4881204068660736),
            (289, -0.07486394792795181),
            (290, 0.22020988166332245),
            (5000, -0.18105468153953552),
            (20001, 0.043963681906461716),
            (41000, 4.447049306577355e-8),
        ];
        for (i, v) in want {
            assert_eq!(data[i], v as f32, "sample {i}");
        }
    }
}

#[cfg(test)]
mod run_tests {
    use super::*;

    /// Runs a real export when ffmpeg is installed (skipped otherwise).
    #[tokio::test]
    async fn exports_with_ffmpeg_when_available() {
        let _env = crate::paths::TEST_ENV.lock().await;
        if tools::ffmpeg_existing().await.is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("velvet-exp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("VELVET_DATA_DIR", dir.join("data"));
        let src = dir.join("in.wav");
        // one second of a 440 Hz tone, 16-bit mono
        let rate = 44_100u32;
        let samples: Vec<i16> = (0..rate)
            .map(|i| ((i as f64 * 440.0 * 2.0 * std::f64::consts::PI / rate as f64).sin() * 8000.0) as i16)
            .collect();
        let mut wav = Vec::new();
        let bytes = (samples.len() * 2) as u32;
        for part in [
            &b"RIFF"[..],
            &(36 + bytes).to_le_bytes(),
            b"WAVEfmt ",
            &16u32.to_le_bytes(),
            &1u16.to_le_bytes(),
            &1u16.to_le_bytes(),
            &rate.to_le_bytes(),
            &(rate * 2).to_le_bytes(),
            &2u16.to_le_bytes(),
            &16u16.to_le_bytes(),
            b"data",
            &bytes.to_le_bytes(),
        ] {
            wav.extend_from_slice(part);
        }
        for s in samples {
            wav.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(&src, wav).unwrap();
        let o = ExportOptions {
            id: "x".into(),
            path: src.to_string_lossy().into_owned(),
            title: "Tone".into(),
            artist: "Test".into(),
            label: "Slowed + Reverb".into(),
            rate: 0.8,
            reverb: 0.38,
            bass: 3.0,
            treble: -2.0,
            format: "mp3".into(),
            out_dir: dir.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let r = export(o, |_| {}).await;
        let done = r.unwrap();
        assert_eq!(done.state, "done");
        let t = done.track.unwrap();
        assert_eq!(t.title, "Tone (Slowed + Reverb)");
        assert!((t.duration - 1.25).abs() < 0.15, "duration {}", t.duration);
        let _ = std::fs::remove_dir_all(dir);
    }
}
