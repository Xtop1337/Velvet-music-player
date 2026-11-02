//! Cover images: cached on disk under their content hash (same scheme as the Electron version).

use crate::{media, paths};
use sha1::{Digest, Sha1};
use std::path::Path;

pub fn ext_for_mime(mime: &str) -> &'static str {
    match mime.to_lowercase().as_str() {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "jpg",
    }
}

/// Stores image bytes in the covers cache and returns the file path.
pub fn save_buffer(data: &[u8], mime: &str) -> Result<String, String> {
    let hash = hex::encode(Sha1::digest(data));
    let file = paths::covers().join(format!("{hash}.{}", ext_for_mime(mime)));
    if !file.exists() {
        std::fs::write(&file, data).map_err(|e| e.to_string())?;
    }
    Ok(file.to_string_lossy().into_owned())
}

pub fn from_file(file: &str) -> Result<String, String> {
    let ext = media::ext(Path::new(file));
    let mime = if ext == "jpg" {
        "image/jpeg".to_string()
    } else {
        format!("image/{ext}")
    };
    save_buffer(&std::fs::read(file).map_err(|e| e.to_string())?, &mime)
}

pub async fn from_url(url: &str) -> Result<String, String> {
    let res = crate::net::client().get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !mime.starts_with("image/") {
        return Err("URL is not an image".into());
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    save_buffer(&bytes, &mime)
}

pub fn from_clipboard() -> Result<Option<String>, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let Ok(img) = cb.get_image() else { return Ok(None) };
    let Some(rgba) = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned()) else {
        return Ok(None);
    };
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    save_buffer(&png, "image/png").map(Some)
}

/// A JPEG of at most `size` px wide, used when embedding covers into audio files.
pub fn as_jpeg(file: &str, size: u32) -> Vec<u8> {
    let raw = std::fs::read(file).unwrap_or_default();
    let Ok(img) = image::load_from_memory(&raw) else { return raw };
    let img = if img.width() > size {
        img.resize(size, u32::MAX, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92);
    match img.to_rgb8().write_with_encoder(enc) {
        Ok(()) => out,
        Err(_) => raw,
    }
}
