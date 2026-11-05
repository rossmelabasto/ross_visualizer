//! ross_visualizer for the desktop: the same visualizer page, fed with everything the computer
//! plays (PipeWire) and the track that's on (MPRIS), plus a click-through overlay.
//!
//! Command line (a running instance picks these up, so they work as niri key bindings):
//!   ross-visualizer                      open the main window
//!   ross-visualizer overlay toggle|off|next|prev|<style>
//!   ross-visualizer quit

mod audio;
mod media;
mod overlay;
mod tray;

use std::process::Command;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

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
#[cfg(target_os = "linux")]
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

pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Act on command-line arguments (without the program name).
fn handle_args(app: &AppHandle, args: &[String]) {
    match args.first().map(String::as_str) {
        None | Some("show") => show_main(app),
        Some("overlay") => overlay::command(app, args.get(1).map_or("toggle", String::as_str)),
        Some("quit") => app.exit(0),
        Some(other) => eprintln!("ross-visualizer: unknown command {other:?}"),
    }
}

fn main() {
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
            media::now_playing,
            media::artwork,
            media::media_control,
            overlay::set_overlay,
            overlay::overlay_mode,
        ])
        .setup(|app| {
            #[cfg(target_os = "linux")]
            if std::env::var_os("RV_DEBUG").is_some() {
                watch_main_loop();
            }
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
