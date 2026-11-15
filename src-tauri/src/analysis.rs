//! Tempo (BPM), musical key and energy of a track, computed from its audio.
//!
//! The audio is decoded with symphonia (mp3, aac/m4a, flac, ogg vorbis, wav, alac; other formats
//! through ffmpeg when it is already installed), mixed to mono at 11 025 Hz, and 90 s from the
//! middle of the track are analysed:
//! - BPM: an onset envelope (spectral flux) and its autocorrelation, with a preference for
//!   common tempos so half / double tempo errors are rare.
//! - Key: a chromagram matched against the Krumhansl–Kessler major / minor key profiles.
//! - Energy: loudness (RMS) mapped to 0..1.
//!
//! Analysis runs on one background thread (see `Worker`) and never blocks the UI.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const RATE: u32 = 11_025;
const WINDOW_SECS: f64 = 90.0;

const NOTES: [&str; 12] = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
/// Camelot numbers of the major keys C..B; a minor key shares the number of its relative major.
const CAMELOT_MAJOR: [u8; 12] = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bpm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camelot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
}

// ── key names ──────────────────────────────────────────────────────────────────

/// "A minor" / "8A" for a tonic (0 = C) and mode.
pub fn key_names(tonic: usize, minor: bool) -> (String, String) {
    let tonic = tonic % 12;
    let name = format!("{} {}", NOTES[tonic], if minor { "minor" } else { "major" });
    let camelot = if minor {
        // the relative major is 3 semitones up
        format!("{}A", CAMELOT_MAJOR[(tonic + 3) % 12])
    } else {
        format!("{}B", CAMELOT_MAJOR[tonic])
    };
    (name, camelot)
}

fn note_index(s: &str) -> Option<usize> {
    let mut chars = s.chars();
    let base = match chars.next()?.to_ascii_uppercase() {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return None,
    };
    let acc = match chars.next() {
        Some('#') | Some('♯') => 1,
        Some('b') | Some('♭') => 11,
        _ => 0,
    };
    Some((base + acc) % 12)
}

/// Reads a key written by DJ software or a tagger: "Am", "A minor", "F#", "Dbm", "8A", "12B", "Emin".
pub fn parse_key(text: &str) -> Option<(String, String)> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    // Camelot / Open Key style "8A"
    let upper = t.to_uppercase();
    if let Some(letter) = upper.chars().last().filter(|c| *c == 'A' || *c == 'B') {
        if let Ok(n) = upper[..upper.len() - 1].trim().parse::<u8>() {
            if (1..=12).contains(&n) {
                let major_tonic = CAMELOT_MAJOR.iter().position(|c| *c == n)?;
                return Some(if letter == 'B' {
                    key_names(major_tonic, false)
                } else {
                    key_names((major_tonic + 9) % 12, true)
                });
            }
        }
    }
    let tonic = note_index(t)?;
    let rest = t[t.char_indices().nth(1).map(|(i, _)| i).unwrap_or(t.len())..]
        .trim_start_matches(['#', 'b', '♯', '♭'])
        .trim()
        .to_lowercase();
    let minor = rest.starts_with('m') && !rest.starts_with("maj") || rest.contains("minor") || rest.contains("moll");
    Some(key_names(tonic, minor))
}

// ── FFT ────────────────────────────────────────────────────────────────────────

/// In-place radix-2 FFT (`re`/`im` length is a power of two).
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let a = start + k;
                let b = a + len / 2;
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
        len <<= 1;
    }
}

/// Magnitude spectra of Hann-windowed frames.
fn spectrogram(x: &[f32], size: usize, hop: usize) -> Vec<Vec<f32>> {
    let win: Vec<f32> = (0..size).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / size as f32).cos()).collect();
    let mut out = Vec::new();
    let mut re = vec![0.0; size];
    let mut im = vec![0.0; size];
    let mut pos = 0;
    while pos + size <= x.len() {
        for i in 0..size {
            re[i] = x[pos + i] * win[i];
            im[i] = 0.0;
        }
        fft(&mut re, &mut im);
        out.push((0..size / 2).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt()).collect());
        pos += hop;
    }
    out
}

// ── tempo ──────────────────────────────────────────────────────────────────────

/// Beats per minute of mono audio at `RATE`, or `None` when there is no steady pulse.
pub fn estimate_bpm(x: &[f32]) -> Option<f64> {
    const SIZE: usize = 1024;
    const HOP: usize = 128;
    let fps = RATE as f64 / HOP as f64;
    let spec = spectrogram(x, SIZE, HOP);
    if spec.len() < (fps * 8.0) as usize {
        return None;
    }
    // spectral flux on a compressed magnitude
    let mut prev: Vec<f32> = vec![0.0; SIZE / 2];
    let mut flux: Vec<f32> = Vec::with_capacity(spec.len());
    for frame in &spec {
        let mut f = 0.0;
        for (k, m) in frame.iter().enumerate() {
            let v = (1.0 + 100.0 * m).ln();
            let d = v - prev[k];
            if d > 0.0 {
                f += d;
            }
            prev[k] = v;
        }
        flux.push(f);
    }
    flux[0] = 0.0;
    // remove the slowly varying part, keep the attacks
    let w = (fps * 0.4) as usize;
    let mut onset = vec![0.0f32; flux.len()];
    let mut sum = 0.0f32;
    for i in 0..flux.len() {
        sum += flux[i];
        if i > 2 * w {
            sum -= flux[i - 2 * w - 1];
        }
        let lo = i.saturating_sub(2 * w);
        let mean = sum / (i - lo + 1) as f32;
        let c = i.saturating_sub(w);
        onset[c] = (flux[c] - mean).max(0.0);
    }
    let energy: f32 = onset.iter().map(|v| v * v).sum();
    if energy <= 1e-6 {
        return None;
    }
    // autocorrelation over 50..220 BPM, weighted towards ~120 BPM (log-normal, 1 octave wide)
    let lag_of = |bpm: f64| 60.0 * fps / bpm;
    let (min_lag, max_lag) = (lag_of(220.0).floor() as usize, lag_of(50.0).ceil() as usize);
    let n = onset.len();
    // up to 3× the longest lag: the score below looks at multiples of each lag
    let ac: Vec<f64> = (0..=3 * max_lag + 2)
        .map(|lag| {
            if lag >= n {
                return 0.0;
            }
            onset[..n - lag].iter().zip(&onset[lag..]).map(|(a, b)| (*a * *b) as f64).sum::<f64>() / (n - lag) as f64
        })
        .collect();
    let weight = |lag: f64| {
        let bpm = 60.0 * fps / lag;
        (-0.5 * ((bpm / 120.0).log2() / 0.9).powi(2)).exp()
    };
    // a tempo also shows up at 2× and 3× its lag: summing them makes the true beat stand out
    let score = |lag: usize| -> f64 {
        let mut s = ac[lag];
        for m in [2usize, 3] {
            let l = lag * m;
            if l + 1 < ac.len() {
                s += 0.5 * ac[l].max(ac[l - 1]).max(ac[l + 1]);
            }
        }
        s * weight(lag as f64)
    };
    let mut best = min_lag;
    for lag in min_lag..=max_lag.min(ac.len() - 2) {
        if score(lag) > score(best) {
            best = lag;
        }
    }
    if ac[best] <= 0.0 {
        return None;
    }
    // sub-frame precision
    let refine = |lag: usize| -> f64 {
        let (a, b, c) = (ac[lag - 1], ac[lag], ac[lag + 1]);
        let denom = a - 2.0 * b + c;
        let shift = if denom.abs() > 1e-12 { (0.5 * (a - c) / denom).clamp(-0.5, 0.5) } else { 0.0 };
        lag as f64 + shift
    };
    let mut lag = refine(best);
    // the prior prefers ~120 BPM: a pulse just as strong at half the lag means the tempo is double
    // (174 BPM drum & bass rather than 87), unless it is only the off-beats (hi-hats) at 90
    let half = (lag / 2.0).round() as usize;
    if half > min_lag / 2 + 1 && 60.0 * fps / (lag / 2.0) <= 190.0 {
        let strong = ac[half - 1].max(ac[half]).max(ac[half + 1]);
        if strong >= 0.9 * ac[best] {
            lag = refine(if ac[half - 1] > ac[half] { half - 1 } else if ac[half + 1] > ac[half] { half + 1 } else { half });
        }
    }
    let mut bpm = 60.0 * fps / lag;
    while bpm < 70.0 {
        bpm *= 2.0;
    }
    while bpm > 190.0 {
        bpm /= 2.0;
    }
    Some((bpm * 10.0).round() / 10.0)
}

// ── key ────────────────────────────────────────────────────────────────────────

const MAJOR: [f64; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR: [f64; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

fn pearson(a: &[f64; 12], b: &[f64]) -> f64 {
    let ma = a.iter().sum::<f64>() / 12.0;
    let mb = b.iter().sum::<f64>() / 12.0;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma).powi(2);
        db += (b[i] - mb).powi(2);
    }
    if da <= 0.0 || db <= 0.0 {
        0.0
    } else {
        num / (da * db).sqrt()
    }
}

/// Pitch-class energy (C..B) of mono audio at `RATE`.
pub fn chroma(x: &[f32]) -> [f64; 12] {
    const SIZE: usize = 8192;
    let spec = spectrogram(x, SIZE, SIZE / 2);
    let bin_hz = RATE as f64 / SIZE as f64;
    let mut out = [0.0f64; 12];
    for frame in &spec {
        let total: f32 = frame.iter().sum();
        if total <= 1e-6 {
            continue;
        }
        let mut c = [0.0f64; 12];
        for (k, m) in frame.iter().enumerate().skip(1) {
            let f = k as f64 * bin_hz;
            if !(60.0..=2100.0).contains(&f) {
                continue;
            }
            let midi = 69.0 + 12.0 * (f / 440.0).log2();
            let nearest = midi.round();
            // bins far from a semitone centre say little about the pitch
            let w = (1.0 - (midi - nearest).abs() * 2.0).max(0.0);
            c[(nearest as i64).rem_euclid(12) as usize] += w * (*m as f64).sqrt();
        }
        let norm = c.iter().cloned().fold(0.0, f64::max);
        if norm > 0.0 {
            for i in 0..12 {
                out[i] += c[i] / norm;
            }
        }
    }
    out
}

/// Tonic (0 = C) and mode of the best matching key profile.
pub fn estimate_key(x: &[f32]) -> Option<(usize, bool)> {
    let c = chroma(x);
    if c.iter().sum::<f64>() <= 0.0 {
        return None;
    }
    let mut best = (f64::MIN, 0usize, false);
    for tonic in 0..12 {
        let rotated: Vec<f64> = (0..12).map(|i| c[(i + tonic) % 12]).collect();
        for (profile, minor) in [(&MAJOR, false), (&MINOR, true)] {
            let r = pearson(profile, &rotated);
            if r > best.0 {
                best = (r, tonic, minor);
            }
        }
    }
    (best.0 > 0.1).then_some((best.1, best.2))
}

/// 0..1 from loudness: −30 dBFS RMS and below → 0, −6 dBFS → 1.
pub fn estimate_energy(x: &[f32]) -> Option<f64> {
    if x.is_empty() {
        return None;
    }
    let rms = (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt();
    if rms <= 0.0 {
        return Some(0.0);
    }
    let db = 20.0 * rms.log10();
    Some((((db + 30.0) / 24.0).clamp(0.0, 1.0) * 100.0).round() / 100.0)
}

/// Everything at once, for decoded mono audio at `RATE`.
pub fn analyse_samples(x: &[f32]) -> (Option<f64>, Option<(String, String)>, Option<f64>) {
    let bpm = estimate_bpm(x);
    let key = estimate_key(x).map(|(t, m)| key_names(t, m));
    (bpm, key, estimate_energy(x))
}

// ── decoding ───────────────────────────────────────────────────────────────────

/// Mono samples at `RATE` from about the middle of the file (up to 90 s).
pub fn decode_window(path: &str) -> Result<Vec<f32>, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use symphonia::core::units::Time;

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| e.to_string())?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or("no audio track")?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;
    let in_rate = track.codec_params.sample_rate.unwrap_or(44_100) as f64;
    let total = track
        .codec_params
        .n_frames
        .map(|n| n as f64 / in_rate)
        .unwrap_or(0.0);
    let start = if total > WINDOW_SECS + 20.0 { (total - WINDOW_SECS) * 0.4 } else { 0.0 };
    let mut skip = 0.0f64;
    if start > 0.0 {
        let sought = format.seek(
            SeekMode::Coarse,
            SeekTo::Time { time: Time::from(start), track_id: Some(track.id) },
        );
        if sought.is_err() {
            // no seeking in this file: decode from the start and drop what comes before
            skip = start;
        } else {
            // the decoder must forget the stream position it had before the seek
            decoder.reset();
        }
    }
    let ratio = in_rate / RATE as f64;
    let want = (WINDOW_SECS * RATE as f64) as usize;
    let mut out: Vec<f32> = Vec::with_capacity(want);
    // box-filter decimation: average the input samples that fall into each output sample
    let (mut acc, mut cnt, mut pos) = (0.0f64, 0u32, 0.0f64);
    let mut skipped = 0.0f64;
    let mut buf: Option<SampleBuffer<f32>> = None;
    while out.len() < want {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };
        if packet.track_id() != track.id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => break,
        };
        let spec = *decoded.spec();
        let chans = spec.channels.count().max(1);
        let frames = decoded.frames();
        if skipped < skip {
            skipped += frames as f64 / in_rate;
            continue;
        }
        let b = buf.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if b.capacity() < decoded.capacity() * chans {
            *b = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        b.copy_interleaved_ref(decoded);
        for frame in b.samples().chunks(chans) {
            acc += frame.iter().map(|v| *v as f64).sum::<f64>() / chans as f64;
            cnt += 1;
            pos += 1.0;
            if pos >= ratio {
                pos -= ratio;
                out.push((acc / cnt as f64) as f32);
                acc = 0.0;
                cnt = 0;
            }
        }
    }
    if out.len() < RATE as usize * 5 {
        return Err("too short or unreadable".into());
    }
    Ok(out)
}

/// Formats symphonia can't read, through ffmpeg (only if it is already on this computer).
async fn decode_with_ffmpeg(path: &str) -> Result<Vec<f32>, String> {
    let ff = crate::tools::ffmpeg_existing().await.ok_or("no decoder for this format")?;
    let out = crate::tools::command(&ff)
        .args(["-v", "error", "-ss", "30", "-t", "90", "-i", path, "-ac", "1", "-ar", &RATE.to_string(), "-f", "f32le", "-"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let mut samples: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    if samples.len() < RATE as usize * 5 {
        // shorter than 30 s: from the start
        let again = crate::tools::command(&ff)
            .args(["-v", "error", "-t", "90", "-i", path, "-ac", "1", "-ar", &RATE.to_string(), "-f", "f32le", "-"])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        samples = again.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    }
    if samples.len() < RATE as usize * 3 {
        return Err("too short or unreadable".into());
    }
    Ok(samples)
}

/// Tags first (a DJ tool's BPM / key is usually right), the audio for the rest.
pub fn analyse_file(id: &str, path: &str) -> Analysis {
    let mut a = Analysis { id: id.to_string(), ..Default::default() };
    let tags = crate::library::read_meta(path);
    a.genre = tags.genre;
    a.year = tags.year;
    a.bpm = tags.bpm;
    a.key = tags.key;
    a.camelot = tags.camelot;
    let samples = match decode_window(path) {
        Ok(s) => Ok(s),
        Err(_) => tauri::async_runtime::block_on(decode_with_ffmpeg(path)),
    };
    if let Ok(x) = samples {
        let (bpm, key, energy) = analyse_samples(&x);
        if a.bpm.is_none() {
            a.bpm = bpm;
        }
        if a.key.is_none() {
            if let Some((name, camelot)) = key {
                a.key = Some(name);
                a.camelot = Some(camelot);
            }
        }
        a.energy = energy;
    }
    a
}

// ── background worker ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct Item {
    pub id: String,
    pub path: String,
}

#[derive(Default)]
struct Queue {
    items: VecDeque<Item>,
    done: usize,
    total: usize,
}

/// One background thread that works through the tracks waiting for analysis.
#[derive(Default)]
pub struct Worker {
    queue: Arc<(Mutex<Queue>, Condvar)>,
    started: AtomicBool,
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize, Clone)]
struct Progress {
    done: usize,
    total: usize,
}

impl Worker {
    pub fn add(&self, app: &AppHandle, items: Vec<Item>) {
        {
            let (lock, cv) = &*self.queue;
            let mut q = lock.lock().unwrap();
            for it in items {
                if !q.items.iter().any(|x| x.id == it.id) {
                    q.items.push_back(it);
                    q.total += 1;
                }
            }
            self.cancel.store(false, Ordering::SeqCst);
            cv.notify_all();
        }
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let (queue, cancel, app) = (self.queue.clone(), self.cancel.clone(), app.clone());
        let _ = std::thread::Builder::new().name("analysis".into()).spawn(move || loop {
            let next = {
                let (lock, cv) = &*queue;
                let mut q = lock.lock().unwrap();
                while q.items.is_empty() {
                    q = cv.wait(q).unwrap();
                }
                q.items.pop_front()
            };
            let Some(item) = next else { continue };
            if cancel.load(Ordering::SeqCst) {
                continue;
            }
            // a malformed file must not stop the analysis of the others
            let result = std::panic::catch_unwind(|| analyse_file(&item.id, &item.path)).unwrap_or_else(|_| {
                log::warn!("analysis: could not read {}", item.path);
                Analysis { id: item.id.clone(), ..Default::default() }
            });
            let progress = {
                let mut q = queue.0.lock().unwrap();
                q.done += 1;
                let p = Progress { done: q.done, total: q.total };
                if q.items.is_empty() {
                    q.done = 0;
                    q.total = 0;
                }
                p
            };
            let _ = app.emit("analysis:result", &result);
            let _ = app.emit("analysis:progress", progress);
            // keep a core free for everything else
            std::thread::sleep(Duration::from_millis(40));
        });
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        let mut q = self.queue.0.lock().unwrap();
        q.items.clear();
        q.done = 0;
        q.total = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clicks(bpm: f64, secs: f64, offbeat: bool) -> Vec<f32> {
        let n = (secs * RATE as f64) as usize;
        let mut x = vec![0.0f32; n];
        let period = 60.0 / bpm * RATE as f64;
        let mut beat = 0;
        loop {
            let at = (beat as f64 * period) as usize;
            if at >= n {
                break;
            }
            // a kick: decaying low sine
            for i in 0..(RATE as usize / 8).min(n - at) {
                let t = i as f32 / RATE as f32;
                x[at + i] += (2.0 * PI * 60.0 * t).sin() * (-t * 30.0).exp() * 0.8;
            }
            if offbeat {
                let h = at + (period / 2.0) as usize;
                for i in 0..(RATE as usize / 40) {
                    if h + i < n {
                        x[h + i] += ((i * 7919 % 13) as f32 / 13.0 - 0.5) * 0.3 * (-(i as f32) / 60.0).exp();
                    }
                }
            }
            beat += 1;
        }
        x
    }

    #[test]
    fn finds_the_tempo() {
        for bpm in [90.0, 128.0, 140.0, 174.0] {
            let got = estimate_bpm(&clicks(bpm, 40.0, true)).unwrap();
            assert!((got - bpm).abs() <= 1.0, "{bpm} → {got}");
        }
        assert_eq!(estimate_bpm(&vec![0.0; RATE as usize * 20]), None);
    }

    fn chord_track(chords: &[[f32; 3]], bass: &[f32]) -> Vec<f32> {
        let per = RATE as usize * 3;
        let mut x = Vec::with_capacity(per * chords.len() * 2);
        for _ in 0..2 {
            for (c, b) in chords.iter().zip(bass) {
                for i in 0..per {
                    let t = i as f32 / RATE as f32;
                    let mut v = 0.5 * (2.0 * PI * b * t).sin();
                    for f in c {
                        for (h, amp) in [(1.0, 0.3), (2.0, 0.12), (3.0, 0.06)] {
                            v += amp * (2.0 * PI * f * h * t).sin();
                        }
                    }
                    x.push(v * 0.3);
                }
            }
        }
        x
    }

    fn hz(midi: f32) -> f32 {
        440.0 * 2f32.powf((midi - 69.0) / 12.0)
    }

    #[test]
    fn finds_the_key() {
        // i – iv – v – i in A minor, bass on the roots
        let am = chord_track(
            &[[hz(69.0), hz(72.0), hz(76.0)], [hz(74.0), hz(77.0), hz(81.0)], [hz(76.0), hz(79.0), hz(83.0)], [hz(69.0), hz(72.0), hz(76.0)]],
            &[hz(45.0), hz(50.0), hz(52.0), hz(45.0)],
        );
        assert_eq!(estimate_key(&am).map(|(t, m)| key_names(t, m)), Some(("A minor".into(), "8A".into())));
        // I – IV – V – I in C major
        let c = chord_track(
            &[[hz(60.0), hz(64.0), hz(67.0)], [hz(65.0), hz(69.0), hz(72.0)], [hz(67.0), hz(71.0), hz(74.0)], [hz(60.0), hz(64.0), hz(67.0)]],
            &[hz(48.0), hz(53.0), hz(55.0), hz(48.0)],
        );
        assert_eq!(estimate_key(&c).map(|(t, m)| key_names(t, m)), Some(("C major".into(), "8B".into())));
    }

    #[test]
    fn reads_keys_from_tags() {
        assert_eq!(parse_key("Am"), Some(("A minor".into(), "8A".into())));
        assert_eq!(parse_key("F# minor"), Some(("F# minor".into(), "11A".into())));
        assert_eq!(parse_key("Dbm"), Some(("C# minor".into(), "12A".into())));
        assert_eq!(parse_key("Eb"), Some(("Eb major".into(), "5B".into())));
        assert_eq!(parse_key("8B"), Some(("C major".into(), "8B".into())));
        assert_eq!(parse_key("1A"), Some(("Ab minor".into(), "1A".into())));
        assert_eq!(parse_key("Cmaj"), Some(("C major".into(), "8B".into())));
        assert_eq!(parse_key(""), None);
        assert_eq!(parse_key("unknown"), None);
    }

    /// 16-bit stereo WAV at 44.1 kHz from mono samples at `RATE` (nearest-sample upsampling).
    fn write_wav(path: &std::path::Path, x: &[f32]) {
        let rate = 44_100u32;
        let n = (x.len() as f64 * rate as f64 / RATE as f64) as usize;
        let mut data = Vec::with_capacity(n * 4);
        for i in 0..n {
            let v = x[(i as f64 * RATE as f64 / rate as f64) as usize];
            let s = (v.clamp(-1.0, 1.0) * 30000.0) as i16;
            data.extend_from_slice(&s.to_le_bytes());
            data.extend_from_slice(&s.to_le_bytes());
        }
        let mut f = Vec::new();
        f.extend_from_slice(b"RIFF");
        f.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        f.extend_from_slice(b"WAVEfmt ");
        f.extend_from_slice(&16u32.to_le_bytes());
        f.extend_from_slice(&1u16.to_le_bytes());
        f.extend_from_slice(&2u16.to_le_bytes());
        f.extend_from_slice(&rate.to_le_bytes());
        f.extend_from_slice(&(rate * 4).to_le_bytes());
        f.extend_from_slice(&4u16.to_le_bytes());
        f.extend_from_slice(&16u16.to_le_bytes());
        f.extend_from_slice(b"data");
        f.extend_from_slice(&(data.len() as u32).to_le_bytes());
        f.extend_from_slice(&data);
        std::fs::write(path, f).unwrap();
    }

    #[test]
    fn analyses_a_file() {
        let dir = std::env::temp_dir().join(format!("velvet-an-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("beat.wav");
        let mut x = clicks(124.0, 40.0, true);
        // a sustained A minor chord under the beat
        for (i, v) in x.iter_mut().enumerate() {
            let t = i as f32 / RATE as f32;
            *v += 0.15 * ((2.0 * PI * 110.0 * t).sin() + (2.0 * PI * 220.0 * t).sin() * 0.5 + (2.0 * PI * 261.63 * t).sin() * 0.4 + (2.0 * PI * 329.63 * t).sin() * 0.4);
        }
        write_wav(&wav, &x);
        let a = analyse_file("t1", wav.to_str().unwrap());
        assert!((a.bpm.unwrap() - 124.0).abs() <= 1.0, "{a:?}");
        assert_eq!(a.key.as_deref(), Some("A minor"), "{a:?}");
        assert!(a.energy.unwrap() > 0.3);
        // not audio at all: nothing, but no panic
        let junk = dir.join("junk.mp3");
        std::fs::write(&junk, b"not audio").unwrap();
        let b = analyse_file("t2", junk.to_str().unwrap());
        assert_eq!((b.bpm, b.key.clone()), (None, None));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "needs VELVET_ANALYSE=<audio file>"]
    fn analyse_a_real_file() {
        let path = std::env::var("VELVET_ANALYSE").unwrap();
        let t = std::time::Instant::now();
        eprintln!("{:?} in {:?}", analyse_file("x", &path), t.elapsed());
    }

    #[test]
    fn rates_energy() {
        assert_eq!(estimate_energy(&vec![0.0; 100]), Some(0.0));
        let loud: Vec<f32> = (0..10_000).map(|i| ((i as f32) * 0.3).sin() * 0.7).collect();
        let quiet: Vec<f32> = loud.iter().map(|v| v * 0.05).collect();
        assert!(estimate_energy(&loud).unwrap() > 0.8);
        assert!(estimate_energy(&quiet).unwrap() < 0.3);
    }
}
