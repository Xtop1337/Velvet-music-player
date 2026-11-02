//! library.json / settings.json / history.json: atomic writes with a .bak of the previous version.

use crate::paths;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const NAMES: [&str; 3] = ["library", "settings", "history"];

fn file_for(name: &str) -> Result<PathBuf, String> {
    if !NAMES.contains(&name) {
        return Err(format!("Unknown store: {name}"));
    }
    Ok(paths::data().join(format!("{name}.json")))
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

pub fn load(name: &str) -> Result<Option<Value>, String> {
    let file = file_for(name)?;
    for candidate in [file.clone(), with_suffix(&file, ".bak")] {
        let Ok(text) = fs::read_to_string(&candidate) else { continue };
        // a corrupted file falls through to the backup
        if let Ok(v) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
            return Ok(Some(v));
        }
    }
    Ok(None)
}

pub fn save(name: &str, data: &Value) -> Result<(), String> {
    let file = file_for(name)?;
    let tmp = with_suffix(&file, ".tmp");
    let text = serde_json::to_string(data).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    if file.exists() {
        let _ = fs::rename(&file, with_suffix(&file, ".bak"));
    }
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_atomically_and_falls_back_to_backup() {
        let _env = crate::paths::TEST_ENV.blocking_lock();
        let dir = std::env::temp_dir().join(format!("velvet-store-{}", uuid::Uuid::new_v4()));
        std::env::set_var("VELVET_DATA_DIR", &dir);
        assert!(load("library").unwrap().is_none());
        save("library", &serde_json::json!({ "v": 1 })).unwrap();
        save("library", &serde_json::json!({ "v": 2 })).unwrap();
        assert_eq!(load("library").unwrap().unwrap()["v"], 2);
        // a broken main file falls back to the previous version
        fs::write(dir.join("library.json"), "{oops").unwrap();
        assert_eq!(load("library").unwrap().unwrap()["v"], 1);
        assert!(save("passwords", &serde_json::json!({})).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
