//! The vault as a real folder on disk (docs/VAULT_FORMAT.md), served to the web app as a
//! `VaultFS` (apps/web/src/desktop/fs.ts). The MCP sidecar, Obsidian, backup tools and the user
//! all see the same files, which is the point of the desktop app.
//!
//! Every path comes from the web view, so it is treated as untrusted: it must be relative, use
//! `/` separators, and contain no `..`, empty, absolute or drive components; symlinks inside the
//! vault are not followed out of it. Writes go to a temporary file in the same folder and are
//! renamed into place, so a crash never leaves half a note.

use serde::Serialize;
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

/// A vault path that has been checked and joined to the vault root.
#[derive(Debug, PartialEq, Eq)]
pub struct SafePath(pub PathBuf);

#[derive(Debug, PartialEq, Eq)]
pub enum PathError {
    Empty,
    Absolute,
    Escapes,
    Invalid(String),
}

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathError::Empty => write!(f, "empty path"),
            PathError::Absolute => write!(f, "absolute paths are not allowed"),
            PathError::Escapes => write!(f, "path escapes the vault"),
            PathError::Invalid(s) => write!(f, "invalid path component {s:?}"),
        }
    }
}

/// Checks a vault-relative path (as `normalizePath` in packages/core/src/fs.ts produces) and joins
/// it to `root`. `allow_root` lets listing the vault folder itself use "".
pub fn resolve(root: &Path, rel: &str, allow_root: bool) -> Result<SafePath, PathError> {
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return if allow_root { Ok(SafePath(root.to_path_buf())) } else { Err(PathError::Empty) };
    }
    if rel.contains('\\') || rel.contains('\0') {
        return Err(PathError::Invalid(rel.to_string()));
    }
    // Windows drive letters ("C:") and UNC prefixes are absolute even without a leading slash.
    if rel.len() >= 2 && rel.as_bytes()[1] == b':' {
        return Err(PathError::Absolute);
    }
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(PathError::Escapes),
            p => {
                let comp = Path::new(p).components().next();
                match comp {
                    Some(Component::Normal(_)) => out.push(p),
                    Some(Component::RootDir) | Some(Component::Prefix(_)) => return Err(PathError::Absolute),
                    _ => return Err(PathError::Invalid(p.to_string())),
                }
            }
        }
    }
    Ok(SafePath(out))
}

/// Refuses paths whose existing parts resolve (through symlinks) outside the vault.
pub fn stays_inside(root: &Path, p: &Path) -> bool {
    let Ok(root) = root.canonicalize() else { return false };
    // Walk up to the nearest existing ancestor (the file itself may not exist yet).
    let mut probe = p.to_path_buf();
    loop {
        if let Ok(real) = probe.canonicalize() {
            return real.starts_with(&root);
        }
        if !probe.pop() {
            return false;
        }
    }
}

pub fn read(root: &Path, rel: &str) -> io::Result<Option<Vec<u8>>> {
    let SafePath(p) = resolve(root, rel, false).map_err(invalid)?;
    if !stays_inside(root, &p) {
        return Err(invalid(PathError::Escapes));
    }
    match fs::read(&p) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::IsADirectory => Ok(None),
        Err(e) => Err(e),
    }
}

/// Atomic write: temp file in the same directory, flushed, then renamed over the target.
pub fn write(root: &Path, rel: &str, bytes: &[u8]) -> io::Result<()> {
    let SafePath(p) = resolve(root, rel, false).map_err(invalid)?;
    let dir = p.parent().ok_or_else(|| invalid(PathError::Empty))?;
    fs::create_dir_all(dir)?;
    if !stays_inside(root, &p) {
        return Err(invalid(PathError::Escapes));
    }
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, &p) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

pub fn delete(root: &Path, rel: &str) -> io::Result<()> {
    let SafePath(p) = resolve(root, rel, false).map_err(invalid)?;
    if !stays_inside(root, &p) {
        return Err(invalid(PathError::Escapes));
    }
    match fs::remove_file(&p) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

pub fn delete_dir(root: &Path, rel: &str) -> io::Result<()> {
    // Never the vault itself.
    let SafePath(p) = resolve(root, rel, false).map_err(invalid)?;
    if !stays_inside(root, &p) {
        return Err(invalid(PathError::Escapes));
    }
    match fs::remove_dir_all(&p) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Entry {
    pub name: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<f64>,
}

/// Immediate children of a directory (empty when it doesn't exist). Temporary files from
/// interrupted writes and dot-files are hidden.
pub fn list(root: &Path, rel: &str) -> io::Result<Vec<Entry>> {
    let SafePath(p) = resolve(root, rel, true).map_err(invalid)?;
    if p.exists() && !stays_inside(root, &p) {
        return Err(invalid(PathError::Escapes));
    }
    let rd = match fs::read_dir(&p) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut out = vec![];
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64);
        if meta.is_dir() {
            out.push(Entry { name, kind: "dir", size: None, mtime });
        } else if meta.is_file() {
            out.push(Entry { name, kind: "file", size: Some(meta.len()), mtime });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn invalid(e: PathError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_only_relative_paths_inside_the_vault() {
        let root = Path::new("/v");
        assert_eq!(resolve(root, "notes/a/note.json", false).unwrap().0, PathBuf::from("/v/notes/a/note.json"));
        assert_eq!(resolve(root, "/notes//./b/", false).unwrap().0, PathBuf::from("/v/notes/b"));
        assert_eq!(resolve(root, "", true).unwrap().0, PathBuf::from("/v"));
        assert_eq!(resolve(root, "", false), Err(PathError::Empty));
        assert_eq!(resolve(root, "notes/../../etc/passwd", false), Err(PathError::Escapes));
        assert_eq!(resolve(root, "..", false), Err(PathError::Escapes));
        assert_eq!(resolve(root, "C:/Windows", false), Err(PathError::Absolute));
        assert!(matches!(resolve(root, "notes\\..\\x", false), Err(PathError::Invalid(_))));
        assert!(matches!(resolve(root, "a\0b", false), Err(PathError::Invalid(_))));
    }

    #[test]
    fn reads_writes_lists_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(read(root, "notes/x/note.json").unwrap(), None);
        write(root, "notes/x/note.json", b"{}").unwrap();
        write(root, "notes/x/pages/p.ink.json", b"[1]").unwrap();
        assert_eq!(read(root, "notes/x/note.json").unwrap(), Some(b"{}".to_vec()));
        // Overwrite is atomic and leaves no temporary files behind.
        write(root, "notes/x/note.json", b"{\"a\":1}").unwrap();
        let names: Vec<_> = list(root, "notes/x").unwrap().into_iter().map(|e| (e.name, e.kind)).collect();
        assert_eq!(names, vec![("note.json".to_string(), "file"), ("pages".to_string(), "dir")]);
        assert_eq!(list(root, "missing").unwrap(), vec![]);
        assert_eq!(list(root, "").unwrap().len(), 1);
        delete(root, "notes/x/note.json").unwrap();
        delete(root, "notes/x/note.json").unwrap(); // missing: no error
        delete_dir(root, "notes").unwrap();
        assert_eq!(list(root, "").unwrap(), vec![]);
        assert!(delete_dir(root, "").is_err());
        assert!(write(root, "../outside.txt", b"x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks_out_of_the_vault() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"s").unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        assert!(read(dir.path(), "link/secret.txt").is_err());
        assert!(write(dir.path(), "link/new.txt", b"x").is_err());
        assert!(!outside.path().join("new.txt").exists());
    }
}
