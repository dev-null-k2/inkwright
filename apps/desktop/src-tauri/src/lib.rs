//! Inkwright's desktop shell (docs/DESKTOP.md). The app itself is the web build
//! (apps/web, `vite build --mode desktop`); this crate adds what only a desktop app can do:
//!
//! - the vault as a real folder (vault.rs), shared with the MCP sidecar, Obsidian and backups;
//! - a tray icon, and closing the window keeps Inkwright running there, so routines, the
//!   journal and the memory timeline keep working;
//! - launch at login (opt-in, starts hidden in the tray), `inkwright://` links, "Open with" for
//!   PDFs, one running instance (a second launch hands its links and files to the first);
//! - auto-update (Tauri updater, signed with the project's key);
//! - the MCP server as a sidecar (sidecar.rs) so agents reach the notebook with the window closed;
//! - the memory timeline's window facts and pixels (recall.rs), and calendar fetching (calendar.rs).

mod calendar;
mod integrations;
mod recall;
mod settings;
mod sidecar;
mod vault;
mod watch;

use serde::Serialize;
use settings::DesktopSettings;
use sidecar::{LaunchSpec, Sidecar};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

const TRAY_ID: &str = "main";
const UPDATER_KEY_PLACEHOLDER: &str = "REPLACE_WITH_YOUR_UPDATER_PUBLIC_KEY";

struct AppState {
    settings: Mutex<DesktopSettings>,
    settings_file: PathBuf,
    data_dir: PathBuf,
    sidecar: Sidecar,
    /// Files the OS asked us to open (argv, "Open with", a second launch): waiting for the web
    /// app, and the only paths `opened_file_read` will read.
    opened: Mutex<OpenedFiles>,
    /// "on" | "paused" | "off": the memory timeline's state as the tray shows it.
    recall_state: Mutex<String>,
    own_writes: watch::OwnWrites,
    watcher: Mutex<Option<watch::VaultWatcher>>,
}

#[derive(Default)]
struct OpenedFiles {
    pending: Vec<PathBuf>,
    allowed: Vec<PathBuf>,
}

fn vault_dir(app: &AppHandle, s: &DesktopSettings) -> PathBuf {
    s.vault_dir.clone().unwrap_or_else(|| app.path().document_dir().unwrap_or_else(|_| app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."))).join("Inkwright"))
}

fn root(app: &AppHandle, state: &AppState) -> Result<PathBuf, String> {
    let dir = vault_dir(app, &state.settings.lock().unwrap());
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't open the vault folder {}: {e}", dir.display()))?;
    Ok(dir)
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---- Vault ---------------------------------------------------------------------------------------

#[tauri::command]
async fn vault_read(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Response, String> {
    let root = root(&app, &state)?;
    match tauri::async_runtime::spawn_blocking(move || vault::read(&root, &path)).await.map_err(err)?.map_err(err)? {
        Some(bytes) => Ok(Response::new(bytes)),
        // The web side maps this to `null` (VaultFS: missing file).
        None => Err("ENOENT".into()),
    }
}

/// Raw body (the file's bytes) with the vault path in the `x-vault-path` header (percent-encoded).
#[tauri::command]
async fn vault_write(app: AppHandle, state: State<'_, AppState>, request: Request<'_>) -> Result<(), String> {
    let root = root(&app, &state)?;
    let path = request.headers().get("x-vault-path").and_then(|v| v.to_str().ok()).ok_or("missing x-vault-path")?;
    let path = percent_encoding::percent_decode_str(path).decode_utf8().map_err(err)?.into_owned();
    state.own_writes.note(&path);
    let bytes = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(v) => v.as_str().map(|s| s.as_bytes().to_vec()).ok_or("expected raw bytes")?,
    };
    tauri::async_runtime::spawn_blocking(move || vault::write(&root, &path, &bytes)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn vault_delete(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let root = root(&app, &state)?;
    state.own_writes.note(&path);
    tauri::async_runtime::spawn_blocking(move || vault::delete(&root, &path)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn vault_delete_dir(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let root = root(&app, &state)?;
    state.own_writes.note(&path);
    tauri::async_runtime::spawn_blocking(move || vault::delete_dir(&root, &path)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn vault_list(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Vec<vault::Entry>, String> {
    let root = root(&app, &state)?;
    tauri::async_runtime::spawn_blocking(move || vault::list(&root, &path)).await.map_err(err)?.map_err(err)
}

/// Moves the app to another vault folder (absolute path). The web app reloads afterwards.
#[tauri::command]
fn vault_dir_set(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err("Choose a folder by its full path".into());
    }
    std::fs::create_dir_all(&p).map_err(err)?;
    {
        let mut s = state.settings.lock().unwrap();
        s.vault_dir = Some(p.clone());
        settings::save(&state.settings_file, &s).map_err(err)?;
    }
    restart_sidecar(&app, &state);
    start_watch(&app, &state);
    Ok(p.to_string_lossy().into_owned())
}

/// Watches the vault folder for changes made by others and tells the web app.
fn start_watch(app: &AppHandle, state: &AppState) {
    let Ok(dir) = root(app, state) else { return };
    let dir = dir.canonicalize().unwrap_or(dir);
    let handle = app.clone();
    let w = watch::watch(dir, state.own_writes.clone(), move |paths| {
        let _ = handle.emit("desktop://vault-changed", paths);
    });
    *state.watcher.lock().unwrap() = w.ok();
}

// ---- Info and settings ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    version: String,
    os: &'static str,
    arch: &'static str,
    vault_dir: String,
    keep_in_tray: bool,
    mcp_enabled: bool,
    mcp_port: u16,
    /// The updater has a real public key (see docs/DESKTOP.md § Updates).
    updates_configured: bool,
    sidecar_bundled: bool,
}

fn updates_configured(app: &AppHandle) -> bool {
    app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).map(|k| !k.trim().is_empty() && k != UPDATER_KEY_PLACEHOLDER).unwrap_or(false)
}

#[tauri::command]
fn desktop_info(app: AppHandle, state: State<'_, AppState>) -> DesktopInfo {
    let s = state.settings.lock().unwrap();
    DesktopInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        vault_dir: vault_dir(&app, &s).to_string_lossy().into_owned(),
        keep_in_tray: s.keep_in_tray,
        mcp_enabled: s.mcp_enabled,
        mcp_port: s.mcp_port,
        updates_configured: updates_configured(&app),
        sidecar_bundled: sidecar::binary_path().is_some(),
    }
}

#[tauri::command]
fn set_keep_in_tray(state: State<'_, AppState>, keep: bool) -> Result<(), String> {
    let mut s = state.settings.lock().unwrap();
    s.keep_in_tray = keep;
    settings::save(&state.settings_file, &s).map_err(err)
}

// ---- MCP sidecar ---------------------------------------------------------------------------------

fn restart_sidecar(app: &AppHandle, state: &AppState) {
    let s = state.settings.lock().unwrap().clone();
    if !s.mcp_enabled {
        state.sidecar.stop();
        return;
    }
    let Some(binary) = sidecar::binary_path() else {
        state.sidecar.stop();
        return;
    };
    let vault = vault_dir(app, &s);
    let _ = std::fs::create_dir_all(&vault);
    state.sidecar.start(LaunchSpec { binary, vault, port: s.mcp_port, token: s.mcp_token.clone(), state_dir: sidecar::state_dir(&state.data_dir) });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpInfo {
    #[serde(flatten)]
    status: sidecar::SidecarStatus,
    enabled: bool,
    port: u16,
    token: String,
}

#[tauri::command]
fn mcp_status(state: State<'_, AppState>) -> McpInfo {
    let s = state.settings.lock().unwrap().clone();
    McpInfo { status: state.sidecar.status(), enabled: s.mcp_enabled, port: s.mcp_port, token: s.mcp_token }
}

#[tauri::command]
fn mcp_configure(app: AppHandle, state: State<'_, AppState>, enabled: bool, port: Option<u16>, new_token: Option<bool>) -> Result<McpInfo, String> {
    {
        let mut s = state.settings.lock().unwrap();
        s.mcp_enabled = enabled;
        if let Some(p) = port {
            if p < 1024 {
                return Err("Choose a port from 1024 to 65535".into());
            }
            s.mcp_port = p;
        }
        if new_token == Some(true) {
            s.mcp_token = settings::new_token();
        }
        settings::save(&state.settings_file, &s).map_err(err)?;
    }
    restart_sidecar(&app, &state);
    Ok(mcp_status(state))
}

// ---- Memory timeline -----------------------------------------------------------------------------

#[tauri::command]
async fn recall_probe() -> Result<recall::Probe, String> {
    tauri::async_runtime::spawn_blocking(recall::probe).await.map_err(err)
}

#[tauri::command]
async fn recall_grab() -> Result<Response, String> {
    let frame = tauri::async_runtime::spawn_blocking(recall::grab).await.map_err(err)??;
    Ok(Response::new(frame))
}

#[tauri::command]
async fn recall_request_permission() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(recall::request_permission).await.map_err(err)
}

/// The web app tells the tray whether the memory timeline is capturing ("on"), paused or off.
#[tauri::command]
fn recall_tray_state(app: AppHandle, state: State<'_, AppState>, value: String) -> Result<(), String> {
    let v = match value.as_str() {
        "on" | "paused" | "off" => value,
        _ => return Err("state must be on, paused or off".into()),
    };
    *state.recall_state.lock().unwrap() = v;
    update_tray(&app, &state).map_err(err)
}

// ---- Calendar ------------------------------------------------------------------------------------

#[tauri::command]
async fn calendar_fetch(url: String) -> Result<String, String> {
    calendar::fetch(&url).await
}

// ---- Integrations (meeting notes to other tools) ---------------------------------------------------

#[tauri::command]
async fn integration_request(req: integrations::Request) -> Result<integrations::Response, String> {
    integrations::send(req).await
}

// ---- Opened files --------------------------------------------------------------------------------

#[derive(Serialize)]
struct OpenedFile {
    path: String,
    name: String,
}

fn queue_files(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    let state = app.state::<AppState>();
    let mut added = false;
    {
        let mut o = state.opened.lock().unwrap();
        for p in paths {
            if p.is_file() && !o.pending.contains(&p) {
                o.allowed.push(p.clone());
                o.pending.push(p);
                added = true;
            }
        }
    }
    if added {
        let _ = app.emit("desktop://open-files", ());
        show_window(app);
    }
}

/// File paths among command-line arguments (Windows and Linux pass "Open with" files this way).
fn file_args(argv: &[String], cwd: &Path) -> Vec<PathBuf> {
    argv.iter().skip(1).filter(|a| !a.starts_with('-') && !a.contains("://")).map(|a| { let p = PathBuf::from(a); if p.is_absolute() { p } else { cwd.join(p) } }).filter(|p| p.is_file()).collect()
}

#[tauri::command]
fn opened_files_take(state: State<'_, AppState>) -> Vec<OpenedFile> {
    let mut o = state.opened.lock().unwrap();
    o.pending.drain(..).map(|p| OpenedFile { name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path: p.to_string_lossy().into_owned() }).collect()
}

/// Reads a file the OS asked us to open — and nothing else.
#[tauri::command]
async fn opened_file_read(state: State<'_, AppState>, path: String) -> Result<Response, String> {
    let p = PathBuf::from(&path);
    if !state.opened.lock().unwrap().allowed.contains(&p) {
        return Err("That file was not opened with Inkwright".into());
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(p)).await.map_err(err)?.map_err(err)?;
    Ok(Response::new(bytes))
}

// ---- Window and tray -----------------------------------------------------------------------------

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn tray_menu(app: &AppHandle, recall: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open", "Open Inkwright", true, None::<&str>)?;
    let timeline = MenuItem::with_id(app, "timeline", "Memory timeline", recall != "off", None::<&str>)?;
    let pause_label = if recall == "paused" { "Resume capturing" } else { "Pause capturing for an hour" };
    let pause = MenuItem::with_id(app, "recall-pause", pause_label, recall != "off", None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Inkwright", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &timeline, &pause, &sep, &quit])
}

fn tray_icon(recall: &str) -> tauri::Result<Image<'static>> {
    if recall == "paused" {
        Image::from_bytes(include_bytes!("../icons/tray-paused.png"))
    } else {
        Image::from_bytes(include_bytes!("../icons/tray.png"))
    }
}

fn update_tray(app: &AppHandle, state: &AppState) -> tauri::Result<()> {
    let recall = state.recall_state.lock().unwrap().clone();
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(tray_menu(app, &recall)?))?;
        tray.set_icon(Some(tray_icon(&recall)?))?;
        tray.set_icon_as_template(true)?;
        let tip = match recall.as_str() {
            "on" => "Inkwright — memory timeline is capturing",
            "paused" => "Inkwright — memory timeline paused",
            _ => "Inkwright",
        };
        tray.set_tooltip(Some(tip))?;
    }
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon("off")?)
        .icon_as_template(true)
        .tooltip("Inkwright")
        .menu(&tray_menu(app, "off")?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "quit" => app.exit(0),
            "timeline" => {
                show_window(app);
                let _ = app.emit("desktop://tray", "timeline");
            }
            "recall-pause" => {
                let _ = app.emit("desktop://tray", "recall-pause");
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ---- App -----------------------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // One TLS provider for the updater and calendar fetching (reqwest with rustls, no default).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let app = tauri::Builder::default()
        // First: a second launch (a link, a file, the dock) goes to the running app instead.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            queue_files(app, file_args(&argv, Path::new(&cwd)));
            show_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let settings_file = config_dir.join("desktop.json");
            let s = settings::load(&settings_file);
            app.manage(AppState {
                settings: Mutex::new(s),
                settings_file,
                data_dir,
                sidecar: Sidecar::default(),
                opened: Mutex::new(OpenedFiles::default()),
                recall_state: Mutex::new("off".into()),
                own_writes: watch::OwnWrites::default(),
                watcher: Mutex::new(None),
            });
            // Links registered at install time; on Linux and in development, register now too.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            build_tray(&handle)?;
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            queue_files(&handle, file_args(&args, &cwd));
            // Launched at login: stay in the tray until asked.
            if !args.iter().any(|a| a == "--hidden") {
                show_window(&handle);
            }
            let state = handle.state::<AppState>();
            restart_sidecar(&handle, &state);
            start_watch(&handle, &state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<AppState>().settings.lock().unwrap().keep_in_tray {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            vault_read,
            vault_write,
            vault_delete,
            vault_delete_dir,
            vault_list,
            vault_dir_set,
            desktop_info,
            set_keep_in_tray,
            mcp_status,
            mcp_configure,
            recall_probe,
            recall_grab,
            recall_request_permission,
            recall_tray_state,
            calendar_fetch,
            integration_request,
            opened_files_take,
            opened_file_read,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Inkwright");

    app.run(|app, event| match event {
        RunEvent::Exit => app.state::<AppState>().sidecar.stop(),
        // macOS delivers "Open with" files and dropped-on-dock files as file:// URLs.
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let files: Vec<PathBuf> = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
            queue_files(app, files);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_window(app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_arguments_skip_flags_links_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("paper.pdf"), b"%PDF").unwrap();
        let argv: Vec<String> = ["inkwright", "--hidden", "inkwright://open?note=1", "paper.pdf", "missing.pdf"].iter().map(|s| s.to_string()).collect();
        assert_eq!(file_args(&argv, dir.path()), vec![dir.path().join("paper.pdf")]);
    }
}
