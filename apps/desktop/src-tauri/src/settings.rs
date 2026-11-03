//! Desktop-only settings, kept in the OS config folder (never in the vault: they describe this
//! computer): where the vault folder is, whether to keep running in the tray, and the MCP
//! sidecar's port and bearer token.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopSettings {
    /// The vault folder (absolute). Default: `<Documents>/Inkwright`.
    pub vault_dir: Option<PathBuf>,
    /// Closing the window keeps Inkwright running in the tray (routines, capture, the MCP server).
    pub keep_in_tray: bool,
    /// Serve the vault to agents over MCP while Inkwright runs.
    pub mcp_enabled: bool,
    pub mcp_port: u16,
    /// Bearer token agents must send. Generated on first run; regenerated on request.
    pub mcp_token: String,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self { vault_dir: None, keep_in_tray: true, mcp_enabled: true, mcp_port: 7337, mcp_token: String::new() }
    }
}

/// 32 random bytes as hex (the OS's CSPRNG).
pub fn new_token() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("the OS random number generator is unavailable");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn load(file: &Path) -> DesktopSettings {
    let mut s: DesktopSettings = fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if s.mcp_token.len() < 32 {
        s.mcp_token = new_token();
        let _ = save(file, &s);
    }
    if s.mcp_port < 1024 {
        s.mcp_port = DesktopSettings::default().mcp_port;
    }
    s
}

pub fn save(file: &Path, s: &DesktopSettings) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(s).unwrap_or_default())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The token lets agents read and write notes: owner-only.
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(tmp, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_load_makes_a_token_and_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("desktop.json");
        let a = load(&f);
        assert_eq!(a.mcp_token.len(), 64);
        assert!(a.keep_in_tray && a.mcp_enabled);
        assert_eq!(load(&f).mcp_token, a.mcp_token);
        assert_ne!(new_token(), new_token());
    }

    #[test]
    fn bad_files_and_ports_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("desktop.json");
        fs::write(&f, b"{\"mcpPort\": 80, \"keepInTray\": false, \"unknown\": 1}").unwrap();
        let s = load(&f);
        assert_eq!(s.mcp_port, 7337);
        assert!(!s.keep_in_tray);
        fs::write(&f, b"not json").unwrap();
        assert_eq!(load(&f).mcp_port, 7337);
    }
}
