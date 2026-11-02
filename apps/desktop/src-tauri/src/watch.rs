//! Tells the web app when files in the vault folder change underneath it — written by the MCP
//! sidecar (an agent created a note), Obsidian, a folder-sync client or the user — so the library
//! and search catch up without a restart. The app's own writes (through `vault_write`) are
//! remembered for a moment and not reported back. Events are batched for half a second.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Paths the app wrote itself, with when (relative, `/`-separated).
#[derive(Clone, Default)]
pub struct OwnWrites(Arc<Mutex<HashMap<String, Instant>>>);

impl OwnWrites {
    pub fn note(&self, rel: &str) {
        let mut m = self.0.lock().unwrap();
        let now = Instant::now();
        m.retain(|_, t| now.duration_since(*t) < Duration::from_secs(10));
        m.insert(rel.trim_matches('/').to_string(), now);
    }
    /// The app wrote (or deleted) this path, or a folder containing it, within `within`.
    fn recent(&self, rel: &str, within: Duration) -> bool {
        self.0.lock().unwrap().iter().any(|(p, t)| t.elapsed() < within && (rel == p || rel.starts_with(&format!("{p}/"))))
    }
}

/// The vault-relative path of an event, or None for files outside it, temp files and dot-files.
pub fn relative(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    let s = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>();
    if s.is_empty() || s.iter().any(|c| c.starts_with('.')) || s.last().map(|l| l.ends_with(".tmp")).unwrap_or(false) {
        return None;
    }
    Some(s.join("/"))
}

pub struct VaultWatcher {
    _watcher: RecommendedWatcher,
}

/// Watches `root` and calls `on_change` with batches of changed vault paths made by others.
pub fn watch(root: PathBuf, own: OwnWrites, on_change: impl Fn(Vec<String>) + Send + 'static) -> notify::Result<VaultWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    std::thread::spawn(move || {
        let mut batch: BTreeSet<String> = BTreeSet::new();
        loop {
            // Wait for the first event; then collect more until half a second passes quietly.
            let ev = if batch.is_empty() {
                match rx.recv() {
                    Ok(e) => Some(e),
                    Err(_) => return, // the watcher was dropped
                }
            } else {
                match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(e) => Some(e),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            };
            match ev {
                Some(Ok(e)) => {
                    if matches!(e.kind, notify::EventKind::Access(_)) {
                        continue;
                    }
                    for p in e.paths {
                        if let Some(rel) = relative(&root, &p) {
                            if !own.recent(&rel, Duration::from_secs(3)) {
                                batch.insert(rel);
                            }
                        }
                    }
                }
                Some(Err(_)) => {}
                None => on_change(std::mem::take(&mut batch).into_iter().collect()),
            }
        }
    });
    Ok(VaultWatcher { _watcher: watcher })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_skip_temp_and_hidden_files() {
        let root = Path::new("/v");
        assert_eq!(relative(root, Path::new("/v/notes/a/note.json")).as_deref(), Some("notes/a/note.json"));
        assert_eq!(relative(root, Path::new("/v/notes/a/.note.json.123.tmp")), None);
        assert_eq!(relative(root, Path::new("/v/.obsidian/workspace.json")), None);
        assert_eq!(relative(root, Path::new("/elsewhere/x")), None);
        assert_eq!(relative(root, Path::new("/v")), None);
    }

    #[test]
    fn reports_changes_by_others_but_not_its_own_writes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        // inotify can miss files written into a folder created a moment earlier (the folder itself
        // is reported then; the app rescans on a folder path), so the folder exists beforehand.
        std::fs::create_dir_all(root.join("notes/n1")).unwrap();
        let own = OwnWrites::default();
        let (tx, rx) = mpsc::channel::<Vec<String>>();
        let _w = watch(root.clone(), own.clone(), move |paths| { let _ = tx.send(paths); }).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        own.note("mine.json");
        std::fs::write(root.join("mine.json"), b"{}").unwrap();
        std::fs::write(root.join("notes/n1/note.json"), b"{}").unwrap();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !seen.contains("notes/n1/note.json") {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(500)) {
                seen.extend(b);
            }
        }
        assert!(seen.contains("notes/n1/note.json"), "{seen:?}");
        assert!(!seen.contains("mine.json"), "{seen:?}");
    }
}
