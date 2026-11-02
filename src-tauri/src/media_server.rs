//! Linux only: WebKitGTK's media player cannot read custom URI schemes, so audio and video
//! are streamed from a loopback HTTP server instead (Windows' WebView2 uses `velvet://`).
//!
//! Only 127.0.0.1, only media file types, and every URL carries a random 128-bit token, so
//! other local programs and web pages can't use it to read files.

use crate::{media, protocol};
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

static BASE: OnceLock<String> = OnceLock::new();

/// `http://127.0.0.1:<port>/<token>/` once the server runs.
pub fn base() -> Option<String> {
    BASE.get().cloned()
}

pub async fn start() -> Result<String, String> {
    if let Some(b) = base() {
        return Ok(b);
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let base = format!("http://127.0.0.1:{port}/{token}/");
    let _ = BASE.set(base.clone());
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let token = token.clone();
            tokio::spawn(async move {
                let _ = serve(sock, &token).await;
            });
        }
    });
    Ok(base)
}

async fn respond(sock: &mut TcpStream, status: &str, headers: &[(String, String)]) -> std::io::Result<()> {
    let mut head =
        format!("HTTP/1.1 {status}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nConnection: close\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    sock.write_all(head.as_bytes()).await
}

async fn serve(mut sock: TcpStream, token: &str) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = sock.read(&mut chunk).await?;
        if n == 0 || buf.len() > 16 * 1024 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let range = lines.find_map(|l| {
        l.split_once(':')
            .filter(|(k, _)| k.eq_ignore_ascii_case("range"))
            .map(|(_, v)| v.trim().to_string())
    });

    if method == "OPTIONS" {
        return respond(&mut sock, "204 No Content", &[("Content-Length".into(), "0".into())]).await;
    }
    let path = target.split('?').next().unwrap_or("");
    let Some(rest) = path.strip_prefix(&format!("/{token}/")) else {
        return respond(&mut sock, "403 Forbidden", &[("Content-Length".into(), "0".into())]).await;
    };
    let file = protocol::path_from_uri(rest);
    let ext = media::ext(std::path::Path::new(&file));
    if !media::servable(&ext) {
        return respond(&mut sock, "403 Forbidden", &[("Content-Length".into(), "0".into())]).await;
    }
    let Ok(mut f) = tokio::fs::File::open(&file).await else {
        return respond(&mut sock, "404 Not Found", &[("Content-Length".into(), "0".into())]).await;
    };
    let size = f.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut headers = vec![
        ("Content-Type".to_string(), media::mime(&ext).to_string()),
        ("Accept-Ranges".into(), "bytes".into()),
    ];
    let (status, start, end) = match range.as_deref().and_then(|r| protocol::parse_range(r, size)) {
        Some(Err(())) => {
            headers.push(("Content-Range".into(), format!("bytes */{size}")));
            headers.push(("Content-Length".into(), "0".into()));
            return respond(&mut sock, "416 Range Not Satisfiable", &headers).await;
        }
        Some(Ok((s, e))) => {
            headers.push(("Content-Range".into(), format!("bytes {s}-{e}/{size}")));
            ("206 Partial Content", s, e)
        }
        None => ("200 OK", 0, size.saturating_sub(1)),
    };
    let len = if size == 0 { 0 } else { end - start + 1 };
    headers.push(("Content-Length".into(), len.to_string()));
    respond(&mut sock, status, &headers).await?;
    if method == "HEAD" || len == 0 {
        return Ok(());
    }
    f.seek(std::io::SeekFrom::Start(start)).await?;
    // the player cancels a request by closing the connection: that just ends the copy
    tokio::io::copy(&mut f.take(len), &mut sock).await?;
    sock.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(url: &str, range: Option<&str>) -> (u16, Vec<u8>, Option<String>) {
        let mut req = reqwest::Client::new().get(url);
        if let Some(r) = range {
            req = req.header("Range", r);
        }
        let res = req.send().await.unwrap();
        let cr = res.headers().get("content-range").map(|v| v.to_str().unwrap().to_string());
        (res.status().as_u16(), res.bytes().await.unwrap().to_vec(), cr)
    }

    #[tokio::test]
    async fn streams_ranges_and_needs_the_token() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = std::env::temp_dir().join(format!("velvet-ms-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("песня.mp3");
        let data: Vec<u8> = (0..=255u8).cycle().take(100_000).collect();
        std::fs::write(&file, &data).unwrap();
        let base = start().await.unwrap();
        let enc = percent_encoding::utf8_percent_encode(file.to_str().unwrap(), percent_encoding::NON_ALPHANUMERIC).to_string();
        let url = format!("{base}{enc}");
        let (status, body, cr) = get(&url, Some("bytes=10-19")).await;
        assert_eq!((status, &body[..], cr.as_deref()), (206, &data[10..20], Some("bytes 10-19/100000")));
        let (status, body, _) = get(&url, None).await;
        assert_eq!((status, body.len()), (200, data.len()));
        // without the token, or for other file types, nothing is served
        let port = base.split(':').nth(2).unwrap().split('/').next().unwrap();
        assert_eq!(get(&format!("http://127.0.0.1:{port}/wrong/{enc}"), None).await.0, 403);
        let txt = dir.join("a.txt");
        std::fs::write(&txt, "x").unwrap();
        let enc_txt = percent_encoding::utf8_percent_encode(txt.to_str().unwrap(), percent_encoding::NON_ALPHANUMERIC).to_string();
        assert_eq!(get(&format!("{base}{enc_txt}"), None).await.0, 403);
        let _ = std::fs::remove_dir_all(dir);
    }
}
