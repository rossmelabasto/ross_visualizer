//! ross_visualizer for the desktop: the same visualizer page, fed with everything the computer
//! plays (PipeWire) and the track that's on (MPRIS), plus a click-through overlay.
//!
//! Command line (a running instance picks these up, so they work as niri key bindings):
//!   ross-visualizer                      open the main window
//!   ross-visualizer overlay toggle|off|next|prev|<style>
//!   ross-visualizer restore              stay in the tray; bring the overlay back if it was on
//!   ross-visualizer quit
//!
//! Debugging: RV_DEBUG=1 logs the main loop's lag, the captured level and what the pages
//! report (`debug_log`); RV_TEST_SCRIPT=file.js runs that script in the main window once
//! it has loaded (scripts/e2e/).

// The desktop app is everything below; on Android the same page runs with the native parts
// of android/ (gen/android), so only what both share is built there.
#[cfg(desktop)]
mod audio;
#[cfg(desktop)]
mod media;
#[cfg(desktop)]
mod overlay;
#[cfg(desktop)]
mod route;
#[cfg(desktop)]
mod tray;

#[cfg(desktop)]
use std::process::Command;

#[cfg(desktop)]
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

#[cfg(desktop)]
/// A helper process that dies with us, even if we're killed (pw-record, playerctl).
pub fn child_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    cmd
}

/// RV_DEBUG=1: report when the GTK main loop (which also handles input and IPC) falls behind.
#[cfg(all(desktop, target_os = "linux"))]
fn watch_main_loop() {
    use gtk::glib;
    use std::time::{Duration, Instant};
    let tick = Duration::from_millis(50);
    let mut last = Instant::now();
    glib::timeout_add_local(tick, move || {
        let now = Instant::now();
        let late = now.duration_since(last).saturating_sub(tick);
        if late > Duration::from_millis(30) {
            eprintln!("ross-visualizer: main loop {} ms late", late.as_millis());
        }
        last = now;
        glib::ControlFlow::Continue
    });
}

#[cfg(desktop)]
pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg(desktop)]
/// Act on command-line arguments (without the program name).
fn handle_args(app: &AppHandle, args: &[String]) {
    match args.first().map(String::as_str) {
        None | Some("show") => show_main(app),
        Some("overlay") => overlay::command(app, args.get(1).map_or("toggle", String::as_str)),
        Some("restore") => overlay::restore(app),
        Some("quit") => app.exit(0),
        Some(other) => eprintln!("ross-visualizer: unknown command {other:?}"),
    }
}

/// "user@host" for the ASCII scene's prompt, like a shell would show it.
#[tauri::command]
fn user_host() -> String {
    format!("{}@{}", user_name(), host_name())
}

#[cfg(unix)]
fn user_name() -> String {
    // The account name (getpwuid), so `sudo -E` or a stale $USER don't lie.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if !pw.is_null() && !(*pw).pw_name.is_null() {
            if let Ok(name) = std::ffi::CStr::from_ptr((*pw).pw_name).to_str() {
                if !name.is_empty() {
                    return name.to_owned();
                }
            }
        }
    }
    std::env::var("USER").unwrap_or_else(|_| "user".into())
}

#[cfg(not(unix))]
fn user_name() -> String {
    std::env::var("USERNAME").unwrap_or_else(|_| "user".into())
}

#[cfg(unix)]
fn host_name() -> String {
    let mut buf = [0u8; 256];
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    let name = if ok { String::from_utf8_lossy(&buf[..end]).into_owned() } else { String::new() };
    // Short form, like bash's \h.
    match name.split('.').next() {
        Some(short) if !short.is_empty() => short.to_owned(),
        _ => "localhost".into(),
    }
}

#[cfg(not(unix))]
fn host_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "localhost".into())
}

#[cfg(desktop)]
/// What the welcome tour needs to write the user's keyboard shortcuts for them.
#[derive(serde::Serialize)]
struct DesktopInfo {
    /// niri, hyprland, sway, kde, gnome or other.
    desktop: &'static str,
    /// How to run us from a shortcut: the AppImage's own path, or the command on $PATH.
    command: String,
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_info() -> DesktopInfo {
    let has = |var: &str| std::env::var_os(var).is_some_and(|v| !v.is_empty());
    let current = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_lowercase();
    let desktop = if has("NIRI_SOCKET") || current.contains("niri") {
        "niri"
    } else if has("HYPRLAND_INSTANCE_SIGNATURE") || current.contains("hyprland") {
        "hyprland"
    } else if has("SWAYSOCK") || current.contains("sway") {
        "sway"
    } else if current.contains("kde") {
        "kde"
    } else if current.contains("gnome") {
        "gnome"
    } else {
        "other"
    };
    let command = std::env::var("APPIMAGE").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| "ross-visualizer".into());
    DesktopInfo { desktop, command }
}

/// Pages report through this when RV_DEBUG is set (see src/desktop/bridge.ts `debugLog`).
#[tauri::command]
fn debug_log(window: tauri::WebviewWindow, msg: String) {
    eprintln!("ross-visualizer: [{}] {msg}", window.label());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    run_desktop();
    #[cfg(mobile)]
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![debug_log, user_host])
        .run(tauri::generate_context!())
        .expect("error while running ross_visualizer");
}

#[cfg(desktop)]
fn run_desktop() {
    let debug = std::env::var_os("RV_DEBUG").is_some();
    let test_script = std::env::var("RV_TEST_SCRIPT").ok().and_then(|f| std::fs::read_to_string(f).ok());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            handle_args(app, argv.get(1..).unwrap_or_default());
        }))
        .manage(audio::Capture::default())
        .manage(media::Player::default())
        .manage(overlay::State::default())
        .manage(tray::Items::default())
        .invoke_handler(tauri::generate_handler![
            audio::audio_subscribe,
            audio::audio_sources,
            audio::set_audio_source,
            media::now_playing,
            media::artwork,
            media::media_control,
            overlay::set_overlay,
            overlay::overlay_mode,
            overlay::overlay_supported,
            overlay::overlay_options,
            overlay::set_overlay_options,
            overlay::overlay_input,
            debug_log,
            user_host,
            desktop_info,
        ])
        .on_page_load(move |webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            if debug {
                let _ = webview.eval("window.__RV_DEBUG__ = true;");
            }
            if let (Some(script), "main") = (&test_script, webview.label()) {
                let _ = webview.eval(script);
            }
        })
        .setup(|app| {
            #[cfg(target_os = "linux")]
            if std::env::var_os("RV_DEBUG").is_some() {
                watch_main_loop();
            }
            overlay::load(app.handle());
            media::watch(app.handle().clone());
            tray::build(app)?;
            let args: Vec<String> = std::env::args().skip(1).collect();
            handle_args(app.handle(), &args);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window quits, unless the overlay is on: then the app stays in
            // the tray to keep drawing it.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && overlay::current(window.app_handle()).is_some() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building ross_visualizer")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<audio::Capture>().stop();
                app.state::<media::Player>().stop();
            }
        });
}
