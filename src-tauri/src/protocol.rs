//! The `velvet` URI scheme (`http://velvet.localhost` on Windows).
//!
//! In release builds the app itself is served from it too (see `serve`), so local audio, covers
//! and videos have the *same origin* as the page: Web Audio never has to deal with CORS, which
//! can otherwise make an audio element play as silence.
//!
//! - Range requests (206) so seeking works; open-ended ranges are answered in chunks.
//! - Only media file types are served from the disk.

use crate::media;
use percent_encoding::percent_decode_str;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Runtime};

/// Largest body sent for one range request.
pub const MAX_CHUNK: u64 = 1024 * 1024;

/// `/C%3A%5CMusic%5Ca.mp3` → `C:\Music\a.mp3`
pub fn path_from_uri(path: &str) -> String {
    percent_decode_str(path.trim_start_matches('/')).decode_utf8_lossy().into_owned()
}

/// Parses `bytes=a-b`, `bytes=a-` and `bytes=-n` into an inclusive range clamped to the file.
/// `Err(())` means unsatisfiable (416).
pub fn parse_range(value: &str, size: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = value.trim().strip_prefix("bytes=")?;
    let spec = spec.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", "") => return None,
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (size.saturating_sub(n), size.saturating_sub(1))
        }
        (s, "") => (s.parse().ok()?, size.saturating_sub(1)),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(size.saturating_sub(1))),
    };
    if size == 0 || start > end || start >= size {
        return Some(Err(()));
    }
    Some(Ok((start, end)))
}

fn base(status: StatusCode) -> tauri::http::response::Builder {
    // CORS headers still matter in development, where the page comes from the Vite server
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Range, Content-Length, Accept-Ranges",
        )
}

/// True for `C:\…`, `C:/…`, `\\server\…` and `/…`: a file on the disk rather than an app asset.
pub fn is_disk_path(p: &str) -> bool {
    let b = p.as_bytes();
    p.starts_with('/')
        || p.starts_with("\\\\")
        || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
}

/// The whole protocol: files from the disk (media only), otherwise the app's own assets
/// (index.html, scripts, styles, fonts) with the CSP Tauri computed for them.
pub fn serve<R: Runtime>(app: &AppHandle<R>, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() == Method::OPTIONS || is_disk_path(&path_from_uri(req.uri().path())) {
        return handle(req);
    }
    match app.asset_resolver().get(req.uri().path().to_string()) {
        Some(asset) => {
            let mut b = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, asset.mime_type);
            if let Some(csp) = asset.csp_header {
                b = b.header("Content-Security-Policy", csp);
            }
            b.body(asset.bytes).unwrap()
        }
        None => simple(StatusCode::NOT_FOUND, "Not found"),
    }
}

fn simple(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    base(status).body(text.as_bytes().to_vec()).unwrap()
}

pub fn handle(req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() == Method::OPTIONS {
        return simple(StatusCode::NO_CONTENT, "");
    }
    let file = path_from_uri(req.uri().path());
    let ext = media::ext(std::path::Path::new(&file));
    if !media::servable(&ext) {
        return simple(StatusCode::FORBIDDEN, "Forbidden");
    }
    let Ok(mut f) = File::open(&file) else {
        return simple(StatusCode::NOT_FOUND, "Not found");
    };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_range(v, size));

    let builder = |status| {
        base(status)
            .header(header::CONTENT_TYPE, media::mime(&ext))
            .header(header::ACCEPT_RANGES, "bytes")
    };
    let (status, start, end) = match range {
        Some(Err(())) => {
            return builder(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Vec::new())
                .unwrap()
        }
        Some(Ok((start, end))) => (StatusCode::PARTIAL_CONTENT, start, end.min(start + MAX_CHUNK - 1)),
        None => (StatusCode::OK, 0, size.saturating_sub(1)),
    };
    let len = if size == 0 { 0 } else { end - start + 1 };
    let mut b = builder(status).header(header::CONTENT_LENGTH, len.to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    if req.method() == Method::HEAD || len == 0 {
        return b.body(Vec::new()).unwrap();
    }
    let mut body = vec![0u8; len as usize];
    if f.seek(SeekFrom::Start(start)).and_then(|_| f.read_exact(&mut body)).is_err() {
        return simple(StatusCode::INTERNAL_SERVER_ERROR, "Read error");
    }
    b.body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_paths_from_both_url_shapes() {
        assert_eq!(
            path_from_uri("/C%3A%5CMusic%5C%D0%BF%D0%B5%D1%81%D0%BD%D1%8F%20%231.mp3"),
            "C:\\Music\\песня #1.mp3"
        );
        assert_eq!(path_from_uri("/%2Fhome%2Fu%2Fa.flac"), "/home/u/a.flac");
    }

    #[test]
    fn tells_disk_files_from_app_assets() {
        assert!(is_disk_path("C:\\Music\\a.mp3"));
        assert!(is_disk_path("d:/Music/a.mp3"));
        assert!(is_disk_path("\\\\nas\\music\\a.mp3"));
        assert!(is_disk_path("/home/u/a.mp3"));
        assert!(!is_disk_path("assets/index-abc.js"));
        assert!(!is_disk_path("index.html"));
        assert!(!is_disk_path(""));
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some(Ok((0, 99))));
        assert_eq!(parse_range("bytes=10-19", 100), Some(Ok((10, 19))));
        assert_eq!(parse_range("bytes=90-500", 100), Some(Ok((90, 99))));
        assert_eq!(parse_range("bytes=-10", 100), Some(Ok((90, 99))));
        assert_eq!(parse_range("bytes=100-", 100), Some(Err(())));
        assert_eq!(parse_range("items=1-2", 100), None);
    }

    #[test]
    fn serves_ranges_with_cors_and_refuses_other_files() {
        let dir = std::env::temp_dir().join(format!("velvet-proto-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("a b.mp3");
        let data: Vec<u8> = (0..=255u8).cycle().take(3 * MAX_CHUNK as usize).collect();
        std::fs::write(&audio, &data).unwrap();
        let url = format!(
            "http://velvet.localhost/{}",
            percent_encoding::utf8_percent_encode(audio.to_str().unwrap(), percent_encoding::NON_ALPHANUMERIC)
        );

        let req = Request::builder().uri(&url).header("Range", "bytes=5-9").body(Vec::new()).unwrap();
        let res = handle(&req);
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(res.body(), &data[5..10]);
        assert_eq!(res.headers()["content-range"], format!("bytes 5-9/{}", data.len()));
        assert_eq!(res.headers()["access-control-allow-origin"], "*");
        assert_eq!(res.headers()["content-type"], "audio/mpeg");
        assert!(res.headers()["access-control-expose-headers"]
            .to_str()
            .unwrap()
            .contains("Content-Range"));

        // open-ended ranges come back in chunks
        let req = Request::builder().uri(&url).header("Range", "bytes=0-").body(Vec::new()).unwrap();
        let res = handle(&req);
        assert_eq!(res.body().len() as u64, MAX_CHUNK);

        let secret = dir.join("secret.txt");
        std::fs::write(&secret, "x").unwrap();
        let url = format!(
            "http://velvet.localhost/{}",
            percent_encoding::utf8_percent_encode(secret.to_str().unwrap(), percent_encoding::NON_ALPHANUMERIC)
        );
        assert_eq!(
            handle(&Request::builder().uri(&url).body(Vec::new()).unwrap()).status(),
            StatusCode::FORBIDDEN
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Browser tests only (`cargo test serve_protocol_for_browser -- --ignored`): serves `handle`
/// over plain HTTP on PROTO_PORT, so a Chromium test can feed it the requests WebView2 would.
#[cfg(test)]
mod browser_harness {
    use super::*;
    use std::io::{BufRead, BufReader, Write};

    #[test]
    #[ignore]
    fn serve_protocol_for_browser() {
        let port = std::env::var("PROTO_PORT").unwrap_or_else(|_| "47811".into());
        let listener = std::net::TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                if reader.read_line(&mut first).is_err() {
                    return;
                }
                let mut parts = first.split_whitespace();
                let (method, target) = (parts.next().unwrap_or("GET").to_string(), parts.next().unwrap_or("/").to_string());
                let mut b = Request::builder()
                    .method(method.as_str())
                    .uri(format!("http://velvet.localhost{target}"));
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                        break;
                    }
                    if let Some((k, v)) = line.trim_end().split_once(':') {
                        b = b.header(k.trim(), v.trim());
                    }
                }
                let res = handle(&b.body(Vec::new()).unwrap());
                let mut out = stream;
                let mut head = format!(
                    "HTTP/1.1 {} {}\r\nConnection: close\r\n",
                    res.status().as_u16(),
                    res.status().canonical_reason().unwrap_or("")
                );
                for (k, v) in res.headers() {
                    head.push_str(&format!("{}: {}\r\n", k, v.to_str().unwrap_or("")));
                }
                head.push_str("\r\n");
                let _ = out.write_all(head.as_bytes());
                let _ = out.write_all(res.body());
            });
        }
    }
}
