//! Facts and pixels for the memory timeline (docs/MEMORY_TIMELINE.md). The decisions — whether
//! to capture, what to keep, redaction, storage — live in TypeScript (packages/core recall,
//! packages/ai redaction) where they are unit-tested on every platform; this side only reports
//! what the OS says and grabs the window in front when asked:
//!
//! - `recall_probe`: the window in front (app, title, bundle id), seconds since the last input,
//!   whether the screen is locked, whether a password field has focus, and whether capture is
//!   possible (macOS Screen Recording permission; Wayland can't name the window in front).
//! - `recall_grab`: that window as a small luminance signature (change detection) and a
//!   grayscale image for on-device OCR. Nothing is written to disk here.

use serde::Serialize;

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundWindow {
    pub app: String,
    pub title: String,
    /// `app.inkwright` for Inkwright's own windows (see `own_window_id`); otherwise not reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub window: Option<ForegroundWindow>,
    /// Seconds since the last keyboard or pointer input (None: the OS doesn't say).
    pub idle_sec: Option<f64>,
    pub locked: bool,
    /// A password (secure text) field has focus, where the OS can tell (macOS, Windows).
    pub secure_input: bool,
    /// What can be detected on this OS, for the settings screen to be honest about it.
    pub can_detect_secure_input: bool,
    /// Screen capture is allowed (macOS asks for Screen Recording permission).
    pub permitted: bool,
    /// Wayland sessions don't let apps see which window is in front; capture stays off there.
    pub wayland: bool,
    pub platform: &'static str,
}

// ---- Image helpers (pure, tested) ------------------------------------------------------------------

/// Luminance (BT.601, integer) of an RGBA pixel.
#[inline]
fn luma(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 77 + g as u32 * 150 + b as u32 * 29) >> 8) as u8
}

/// Box-averaged luminance grid of `sw` × `sh` cells over an RGBA image (change detection: compare
/// cells, not pixels, so a blinking cursor doesn't count as a new screen).
pub fn signature(rgba: &[u8], w: u32, h: u32, sw: u32, sh: u32) -> Vec<u8> {
    let (w, h) = (w as usize, h as usize);
    let (sw, sh) = (sw as usize, sh as usize);
    let mut out = vec![0u8; sw * sh];
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        return out;
    }
    for cy in 0..sh {
        let y0 = cy * h / sh;
        let y1 = ((cy + 1) * h / sh).max(y0 + 1).min(h);
        for cx in 0..sw {
            let x0 = cx * w / sw;
            let x1 = ((cx + 1) * w / sw).max(x0 + 1).min(w);
            let mut sum: u64 = 0;
            // Sample every other pixel in each direction: plenty for a 64 × 40 grid, 4× cheaper.
            let mut n: u64 = 0;
            let mut y = y0;
            while y < y1 {
                let mut x = x0;
                while x < x1 {
                    let i = (y * w + x) * 4;
                    sum += luma(rgba[i], rgba[i + 1], rgba[i + 2]) as u64;
                    n += 1;
                    x += 2;
                }
                y += 2;
            }
            out[cy * sw + cx] = if n > 0 { (sum / n) as u8 } else { 0 };
        }
    }
    out
}

/// Grayscale copy for OCR, halved (2 × 2 box) while wider than `max_width` — HiDPI screens give
/// OCR far more pixels than it needs, and fewer pixels is faster recognition.
pub fn grayscale_for_ocr(rgba: &[u8], w: u32, h: u32, max_width: u32) -> (Vec<u8>, u32, u32) {
    let (mut w, mut h) = (w as usize, h as usize);
    let mut gray: Vec<u8> = rgba.chunks_exact(4).map(|p| luma(p[0], p[1], p[2])).collect();
    gray.truncate(w * h);
    while w > max_width as usize && w >= 2 && h >= 2 {
        let (nw, nh) = (w / 2, h / 2);
        let mut next = vec![0u8; nw * nh];
        for y in 0..nh {
            for x in 0..nw {
                let a = gray[(2 * y) * w + 2 * x] as u32;
                let b = gray[(2 * y) * w + 2 * x + 1] as u32;
                let c = gray[(2 * y + 1) * w + 2 * x] as u32;
                let d = gray[(2 * y + 1) * w + 2 * x + 1] as u32;
                next[y * nw + x] = ((a + b + c + d + 2) / 4) as u8;
            }
        }
        gray = next;
        w = nw;
        h = nh;
    }
    (gray, w as u32, h as u32)
}

/// Frame layout sent to the web view (little-endian u32s, then bytes):
/// `[sigW, sigH, imgW, imgH] ++ signature (sigW·sigH) ++ grayscale image (imgW·imgH)`.
pub fn encode_frame(sig: &[u8], sw: u32, sh: u32, gray: &[u8], iw: u32, ih: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + sig.len() + gray.len());
    for v in [sw, sh, iw, ih] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(sig);
    out.extend_from_slice(gray);
    out
}

pub const SIG_W: u32 = 64;
pub const SIG_H: u32 = 40;
pub const OCR_MAX_WIDTH: u32 = 2200;

// ---- The OS --------------------------------------------------------------------------------------

fn is_wayland() -> bool {
    cfg!(target_os = "linux") && (std::env::var("XDG_SESSION_TYPE").map(|v| v.eq_ignore_ascii_case("wayland")).unwrap_or(false) || (std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none()))
}

/// Inkwright's own windows are named by process, not only by the app name the OS shows (which
/// varies: "Inkwright" on macOS, the executable or WM class on Linux), so the never-capture-myself
/// rule (packages/core `shouldCapture`, "own-app") can't be fooled by a renamed binary.
fn own_window_id(pid: Option<u32>) -> Option<String> {
    (pid == Some(std::process::id())).then(|| "app.inkwright".to_string())
}

fn focused_window() -> Option<xcap::Window> {
    let windows = xcap::Window::all().ok()?;
    windows.into_iter().find(|w| w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
}

pub fn probe() -> Probe {
    let wayland = is_wayland();
    let window = if wayland {
        None
    } else {
        focused_window().map(|w| ForegroundWindow {
            app: w.app_name().unwrap_or_default(),
            title: w.title().unwrap_or_default(),
            bundle_id: own_window_id(w.pid().ok()),
        })
    };
    Probe {
        window,
        idle_sec: platform::idle_seconds(),
        locked: platform::screen_locked(),
        secure_input: platform::secure_input(),
        can_detect_secure_input: cfg!(any(target_os = "macos", windows)),
        permitted: platform::capture_permitted(),
        wayland,
        platform: std::env::consts::OS,
    }
}

/// Captures the focused window. Errors when there is none, or capture isn't permitted.
pub fn grab() -> Result<Vec<u8>, String> {
    if is_wayland() {
        return Err("Wayland does not let apps capture other windows".into());
    }
    if !platform::capture_permitted() {
        return Err("Screen recording is not allowed for Inkwright".into());
    }
    let w = focused_window().ok_or("No window in front")?;
    let img = w.capture_image().map_err(|e| e.to_string())?;
    let (iw, ih) = (img.width(), img.height());
    let raw = img.as_raw();
    let sig = signature(raw, iw, ih, SIG_W, SIG_H);
    let (gray, gw, gh) = grayscale_for_ocr(raw, iw, ih, OCR_MAX_WIDTH);
    Ok(encode_frame(&sig, SIG_W, SIG_H, &gray, gw, gh))
}

/// Asks for screen capture permission where the OS has one (macOS shows its prompt once).
pub fn request_permission() -> bool {
    platform::request_capture_permission()
}

#[cfg(target_os = "macos")]
mod platform {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        /// True while any app has secure text entry on (a focused password field, sudo in Terminal
        /// with "Secure Keyboard Entry", the login window…).
        fn IsSecureEventInputEnabled() -> u8;
    }
    /// kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType.
    const COMBINED: i32 = 0;
    const ANY_INPUT: u32 = !0;

    pub fn idle_seconds() -> Option<f64> {
        Some(unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED, ANY_INPUT) })
    }
    pub fn screen_locked() -> bool {
        // A locked Mac is also idle; the idle rule covers it without private session APIs.
        false
    }
    pub fn secure_input() -> bool {
        unsafe { IsSecureEventInputEnabled() != 0 }
    }
    pub fn capture_permitted() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }
    pub fn request_capture_permission() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }
}

#[cfg(windows)]
mod platform {
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    pub fn idle_seconds() -> Option<f64> {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        unsafe {
            if GetLastInputInfo(&mut info).as_bool() {
                Some(GetTickCount().wrapping_sub(info.dwTime) as f64 / 1000.0)
            } else {
                None
            }
        }
    }
    pub fn screen_locked() -> bool {
        // The secure desktop can't be captured anyway; the idle rule covers a locked PC.
        false
    }
    /// UI Automation: is the focused element a password box?
    pub fn secure_input() -> bool {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let Ok(ua) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) else { return false };
            let Ok(el) = ua.GetFocusedElement() else { return false };
            el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false)
        }
    }
    pub fn capture_permitted() -> bool {
        true
    }
    pub fn request_capture_permission() -> bool {
        true
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use zbus::blocking::Connection;

    fn session() -> Option<Connection> {
        Connection::session().ok()
    }

    /// GNOME (Mutter's idle monitor, ms) or KDE/freedesktop (ScreenSaver, seconds).
    pub fn idle_seconds() -> Option<f64> {
        let c = session()?;
        if let Ok(m) = c.call_method(Some("org.gnome.Mutter.IdleMonitor"), "/org/gnome/Mutter/IdleMonitor/Core", Some("org.gnome.Mutter.IdleMonitor"), "GetIdletime", &()) {
            if let Ok(ms) = m.body().deserialize::<u64>() {
                return Some(ms as f64 / 1000.0);
            }
        }
        if let Ok(m) = c.call_method(Some("org.freedesktop.ScreenSaver"), "/ScreenSaver", Some("org.freedesktop.ScreenSaver"), "GetSessionIdleTime", &()) {
            if let Ok(s) = m.body().deserialize::<u32>() {
                return Some(s as f64);
            }
        }
        None
    }
    pub fn screen_locked() -> bool {
        let Some(c) = session() else { return false };
        for (dest, path, iface) in [("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver"), ("org.freedesktop.ScreenSaver", "/ScreenSaver", "org.freedesktop.ScreenSaver")] {
            if let Ok(m) = c.call_method(Some(dest), path, Some(iface), "GetActive", &()) {
                if let Ok(active) = m.body().deserialize::<bool>() {
                    return active;
                }
            }
        }
        false
    }
    /// Not detectable on Linux without an accessibility bus walk; title and app rules apply.
    pub fn secure_input() -> bool {
        false
    }
    pub fn capture_permitted() -> bool {
        true
    }
    pub fn request_capture_permission() -> bool {
        true
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod platform {
    pub fn idle_seconds() -> Option<f64> {
        None
    }
    pub fn screen_locked() -> bool {
        false
    }
    pub fn secure_input() -> bool {
        false
    }
    pub fn capture_permitted() -> bool {
        false
    }
    pub fn request_capture_permission() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba(w: u32, h: u32, f: impl Fn(u32, u32) -> u8) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let l = f(x, y);
                v.extend_from_slice(&[l, l, l, 255]);
            }
        }
        v
    }

    #[test]
    fn signature_averages_cells() {
        // Left half black, right half white.
        let img = rgba(128, 80, |x, _| if x < 64 { 0 } else { 255 });
        let sig = signature(&img, 128, 80, 4, 2);
        assert_eq!(sig.len(), 8);
        assert_eq!(&sig[0..4], &[0, 0, 255, 255]);
        assert_eq!(signature(&[], 0, 0, 4, 2), vec![0; 8]);
        // A truncated buffer never panics.
        assert_eq!(signature(&img[..10], 128, 80, 4, 2), vec![0; 8]);
    }

    #[test]
    fn grayscale_halves_until_it_fits() {
        let img = rgba(1000, 10, |x, _| (x % 256) as u8);
        let (g, w, h) = grayscale_for_ocr(&img, 1000, 10, 300);
        assert_eq!((w, h), (250, 2));
        assert_eq!(g.len(), 500);
        let (g2, w2, h2) = grayscale_for_ocr(&img, 1000, 10, 2000);
        assert_eq!((w2, h2, g2.len()), (1000, 10, 10_000));
        assert_eq!(g2[3], 3);
    }

    #[test]
    fn own_windows_are_named_by_process() {
        assert_eq!(own_window_id(Some(std::process::id())).as_deref(), Some("app.inkwright"));
        assert_eq!(own_window_id(Some(std::process::id().wrapping_add(1))), None);
        assert_eq!(own_window_id(None), None);
    }

    #[test]
    fn frame_layout() {
        let f = encode_frame(&[1, 2], 2, 1, &[9, 9, 9], 3, 1);
        assert_eq!(&f[0..4], &2u32.to_le_bytes());
        assert_eq!(&f[12..16], &1u32.to_le_bytes());
        assert_eq!(&f[16..], &[1, 2, 9, 9, 9]);
    }
}
