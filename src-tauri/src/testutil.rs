//! A tiny HTTP server for tests: canned answers by path, and a log of what was asked.

use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct Seen {
    /// "GET /v1/search?q=…"
    pub line: String,
    pub headers: String,
    pub body: Vec<u8>,
}

pub struct Mock {
    /// `http://127.0.0.1:<port>`
    pub base: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

/// Each route: (path prefix, status, JSON or text body). The first matching prefix answers.
pub async fn serve(routes: Vec<(&'static str, u16, String)>) -> Mock {
    serve_with(routes.into_iter().map(|(p, s, b)| (p, s, b, Vec::new())).collect()).await
}

/// A route with extra response headers: (path prefix, status, body, headers).
pub type Route = (&'static str, u16, String, Vec<(&'static str, &'static str)>);

/// Like `serve`, with extra response headers per route.
pub async fn serve_with(routes: Vec<Route>) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let routes = Arc::new(routes);
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let (routes, log) = (routes.clone(), log.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let head_end = loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let len = head
                    .lines()
                    .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("content-length")))
                    .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                while buf.len() < head_end + len {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let line = head.lines().next().unwrap_or("").rsplit_once(' ').map(|(a, _)| a.to_string()).unwrap_or_default();
                let path = line.split(' ').nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(Seen {
                    line: line.clone(),
                    headers: head.clone(),
                    body: buf[head_end..].to_vec(),
                });
                let (status, body, extra) = routes
                    .iter()
                    .find(|(p, _, _, _)| path.starts_with(p))
                    .map(|(_, s, b, h)| (*s, b.clone(), h.clone()))
                    .unwrap_or((404, String::new(), Vec::new()));
                let kind = if body.starts_with('{') || body.starts_with('[') { "application/json" } else { "text/plain" };
                let mut head = String::new();
                if !extra.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
                    head.push_str(&format!("Content-Type: {kind}\r\n"));
                }
                for (k, v) in &extra {
                    head.push_str(&format!("{k}: {v}\r\n"));
                }
                let res = format!(
                    "HTTP/1.1 {status} X\r\n{head}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(res.as_bytes()).await;
            });
        }
    });
    Mock { base, seen }
}
