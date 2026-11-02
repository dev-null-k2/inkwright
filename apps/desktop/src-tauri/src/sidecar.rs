//! The MCP server (apps/mcp-server, built as one executable by scripts/build-sidecar.mjs) as a
//! sidecar: while Inkwright runs — window open or only in the tray — agents such as Claude
//! Desktop, Claude Code or Cursor reach the vault at `http://127.0.0.1:<port>/mcp` with the
//! bearer token shown in Settings › Desktop app. It listens on loopback only.
//!
//! The token goes to the child through the environment (`INKWRIGHT_MCP_TOKEN`), never on the
//! command line, where other users of the computer could read it from the process list. If the
//! server stops on its own it is restarted, at most three times a minute; its last lines of output
//! are kept for the settings screen.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub running: bool,
    pub url: Option<String>,
    pub binary: Option<String>,
    pub error: Option<String>,
    /// The server's last lines of output (no secrets: it never prints the token).
    pub log: Vec<String>,
}

#[derive(Clone)]
pub struct LaunchSpec {
    pub binary: PathBuf,
    pub vault: PathBuf,
    pub port: u16,
    pub token: String,
    pub state_dir: PathBuf,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    spec: Option<LaunchSpec>,
    log: VecDeque<String>,
    error: Option<String>,
    restarts: Vec<Instant>,
    /// Bumped on every start/stop, so a watcher of an old process doesn't restart it.
    generation: u64,
}

#[derive(Clone, Default)]
pub struct Sidecar(Arc<Mutex<Inner>>);

/// The sidecar executable next to the app's own (where Tauri installs `externalBin`).
pub fn binary_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "inkwright-mcp.exe" } else { "inkwright-mcp" };
    let p = dir.join(name);
    p.exists().then_some(p)
}

/// Arguments for the server (the token is passed separately, in the environment).
pub fn args_for(spec: &LaunchSpec) -> Vec<String> {
    vec![
        "--vault".into(),
        spec.vault.to_string_lossy().into_owned(),
        "--http".into(),
        spec.port.to_string(),
        "--state-dir".into(),
        spec.state_dir.to_string_lossy().into_owned(),
    ]
}

/// Restart budget: at most `max` restarts in any `window`.
pub fn may_restart(history: &mut Vec<Instant>, now: Instant, window: Duration, max: usize) -> bool {
    history.retain(|t| now.duration_since(*t) < window);
    if history.len() >= max {
        return false;
    }
    history.push(now);
    true
}

impl Sidecar {
    pub fn start(&self, spec: LaunchSpec) {
        let mut g = self.0.lock().unwrap();
        stop_locked(&mut g);
        g.spec = Some(spec);
        g.error = None;
        g.restarts.clear();
        spawn_locked(&self.0, &mut g);
    }

    pub fn stop(&self) {
        let mut g = self.0.lock().unwrap();
        g.spec = None;
        stop_locked(&mut g);
    }

    pub fn status(&self) -> SidecarStatus {
        let mut g = self.0.lock().unwrap();
        let running = match g.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        };
        SidecarStatus {
            running,
            url: g.spec.as_ref().map(|s| format!("http://127.0.0.1:{}/mcp", s.port)),
            binary: g.spec.as_ref().map(|s| s.binary.to_string_lossy().into_owned()).or_else(|| binary_path().map(|p| p.to_string_lossy().into_owned())),
            error: g.error.clone(),
            log: g.log.iter().cloned().collect(),
        }
    }
}

fn stop_locked(g: &mut Inner) {
    g.generation += 1;
    if let Some(mut c) = g.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn push_log(g: &mut Inner, line: String) {
    if g.log.len() >= 40 {
        g.log.pop_front();
    }
    g.log.push_back(line);
}

fn spawn_locked(shared: &Arc<Mutex<Inner>>, g: &mut Inner) {
    let Some(spec) = g.spec.clone() else { return };
    let _ = std::fs::create_dir_all(&spec.state_dir);
    let mut cmd = Command::new(&spec.binary);
    cmd.args(args_for(&spec)).env("INKWRIGHT_MCP_TOKEN", &spec.token).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(mut child) => {
            g.generation += 1;
            let generation = g.generation;
            let stderr = child.stderr.take();
            g.child = Some(child);
            let shared = Arc::clone(shared);
            std::thread::spawn(move || watch(shared, generation, stderr));
        }
        Err(e) => g.error = Some(format!("Couldn't start the MCP server ({}): {e}", spec.binary.display())),
    }
}

/// Collects the server's output; when it ends (the process exited), records why and restarts it
/// within the budget.
fn watch(shared: Arc<Mutex<Inner>>, generation: u64, stderr: Option<std::process::ChildStderr>) {
    if let Some(err) = stderr {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            let mut g = shared.lock().unwrap();
            if g.generation != generation {
                return;
            }
            push_log(&mut g, line);
        }
    }
    let mut g = shared.lock().unwrap();
    if g.generation != generation {
        return;
    }
    let code = g.child.as_mut().and_then(|c| c.wait().ok()).and_then(|s| s.code());
    g.child = None;
    let last = g.log.back().cloned().unwrap_or_default();
    g.error = Some(format!("The MCP server stopped{}{}", code.map(|c| format!(" (exit code {c})")).unwrap_or_default(), if last.is_empty() { String::new() } else { format!(": {last}") }));
    let now = Instant::now();
    if g.spec.is_some() && may_restart(&mut g.restarts, now, Duration::from_secs(60), 3) {
        drop(g);
        std::thread::sleep(Duration::from_secs(2));
        let mut g = shared.lock().unwrap();
        if g.generation == generation && g.child.is_none() {
            spawn_locked(&shared, &mut g);
        }
    }
}

/// Where the server keeps its own state (webhooks, delivery log): the app's data folder.
pub fn state_dir(app_data: &Path) -> PathBuf {
    app_data.join("mcp")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_puts_the_token_on_the_command_line() {
        let spec = LaunchSpec { binary: "/x/inkwright-mcp".into(), vault: "/v".into(), port: 7337, token: "s3cret".into(), state_dir: "/s".into() };
        let a = args_for(&spec);
        assert_eq!(a, vec!["--vault", "/v", "--http", "7337", "--state-dir", "/s"]);
        assert!(!a.iter().any(|x| x.contains("s3cret")));
    }

    #[test]
    fn restarts_at_most_three_times_a_minute() {
        let mut h = vec![];
        let t0 = Instant::now();
        assert!(may_restart(&mut h, t0, Duration::from_secs(60), 3));
        assert!(may_restart(&mut h, t0 + Duration::from_secs(1), Duration::from_secs(60), 3));
        assert!(may_restart(&mut h, t0 + Duration::from_secs(2), Duration::from_secs(60), 3));
        assert!(!may_restart(&mut h, t0 + Duration::from_secs(3), Duration::from_secs(60), 3));
        assert!(may_restart(&mut h, t0 + Duration::from_secs(61), Duration::from_secs(60), 3));
    }

    #[cfg(unix)]
    #[test]
    fn reports_a_server_that_stops_and_gives_up_after_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("fake-mcp");
        std::fs::write(&bin, "#!/bin/sh\necho starting >&2\nexit 3\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let s = Sidecar::default();
        s.start(LaunchSpec { binary: bin, vault: dir.path().into(), port: 7999, token: "t".into(), state_dir: dir.path().join("state") });
        // Three restarts two seconds apart, then it stays down.
        std::thread::sleep(Duration::from_millis(9000));
        let st = s.status();
        assert!(!st.running);
        assert!(st.error.unwrap().contains("exit code 3"));
        assert!(st.log.len() >= 2);
        assert_eq!(st.url.as_deref(), Some("http://127.0.0.1:7999/mcp"));
        s.stop();
    }
}
