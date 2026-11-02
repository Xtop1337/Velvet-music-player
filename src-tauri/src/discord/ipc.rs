//! Discord's local RPC: a named pipe (`\\.\pipe\discord-ipc-N`) on Windows, a Unix socket elsewhere.
//! Frames are `[op: u32 LE][length: u32 LE][JSON]`.

use super::Transport;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;
const OP_PONG: u32 = 4;
const TIMEOUT: Duration = Duration::from_secs(5);

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

#[derive(Default)]
pub struct Ipc {
    stream: Option<Box<dyn Stream>>,
}

#[cfg(windows)]
async fn open() -> Result<Box<dyn Stream>, String> {
    use tokio::net::windows::named_pipe::ClientOptions;
    for i in 0..10 {
        if let Ok(pipe) = ClientOptions::new().open(format!(r"\\.\pipe\discord-ipc-{i}")) {
            return Ok(Box::new(pipe));
        }
    }
    Err("Discord is not running".into())
}

#[cfg(unix)]
async fn open() -> Result<Box<dyn Stream>, String> {
    let base = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .unwrap_or_else(|| "/tmp".into());
    for sub in [
        "",
        "app/com.discordapp.Discord/",
        "snap.discord/",
        ".flatpak/dev.vencord.Vesktop/xdg-run/",
    ] {
        for i in 0..10 {
            if let Ok(s) = tokio::net::UnixStream::connect(format!("{base}/{sub}discord-ipc-{i}")).await {
                return Ok(Box::new(s));
            }
        }
    }
    Err("Discord is not running".into())
}

impl Ipc {
    async fn send(&mut self, op: u32, payload: &Value) -> Result<(), String> {
        let s = self.stream.as_mut().ok_or("not connected")?;
        let body = payload.to_string().into_bytes();
        let mut frame = Vec::with_capacity(8 + body.len());
        frame.extend_from_slice(&op.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        s.write_all(&frame).await.map_err(|e| e.to_string())?;
        s.flush().await.map_err(|e| e.to_string())
    }

    async fn recv(&mut self) -> Result<(u32, Value), String> {
        loop {
            let s = self.stream.as_mut().ok_or("not connected")?;
            let mut head = [0u8; 8];
            tokio::time::timeout(TIMEOUT, s.read_exact(&mut head))
                .await
                .map_err(|_| "Discord did not answer")?
                .map_err(|e| e.to_string())?;
            let op = u32::from_le_bytes(head[..4].try_into().unwrap());
            let len = u32::from_le_bytes(head[4..].try_into().unwrap()) as usize;
            let mut body = vec![0u8; len];
            tokio::time::timeout(TIMEOUT, s.read_exact(&mut body))
                .await
                .map_err(|_| "Discord did not answer")?
                .map_err(|e| e.to_string())?;
            let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            match op {
                OP_PING => self.send(OP_PONG, &v).await?,
                OP_CLOSE => return Err(v.get("message").and_then(Value::as_str).unwrap_or("closed by Discord").to_string()),
                _ => return Ok((op, v)),
            }
        }
    }
}

impl Transport for Ipc {
    async fn connect(&mut self, client_id: &str) -> Result<String, String> {
        self.stream = Some(open().await?);
        self.send(OP_HANDSHAKE, &json!({ "v": 1, "client_id": client_id })).await?;
        loop {
            let (op, v) = self.recv().await?;
            if op == OP_FRAME && v.get("evt").and_then(Value::as_str) == Some("READY") {
                let user = v.pointer("/data/user");
                let name = user.and_then(|u| {
                    u.get("global_name")
                        .and_then(Value::as_str)
                        .or_else(|| u.get("username").and_then(Value::as_str))
                });
                return Ok(name.unwrap_or("").to_string());
            }
        }
    }

    async fn set_activity(&mut self, activity: Option<Value>) -> Result<(), String> {
        let nonce = uuid::Uuid::new_v4().to_string();
        let payload = json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": activity }, "nonce": nonce });
        self.send(OP_FRAME, &payload).await?;
        loop {
            let (_, v) = self.recv().await?;
            if v.get("nonce").and_then(Value::as_str) == Some(nonce.as_str()) {
                if v.get("evt").and_then(Value::as_str) == Some("ERROR") {
                    return Err(v
                        .pointer("/data/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Discord error")
                        .to_string());
                }
                return Ok(());
            }
        }
    }

    async fn close(&mut self) {
        if self.stream.is_some() {
            let _ = self.send(OP_CLOSE, &json!({})).await;
        }
        self.stream = None;
    }
}
