//! The overlay: a transparent window on the layer-shell "overlay" layer (above every window and
//! panel), anchored to all four edges, that takes no keyboard focus and lets every click
//! through. The page itself (overlay.html) draws the chosen style.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Ids and menu labels, in menu order. src/overlay/modes.ts keeps the same ids.
pub const MODES: [(&str, &str); 7] = [
    ("halo", "Halo"),
    ("horizon", "Horizonte"),
    ("orbit", "Órbita"),
    ("curtain", "Cortina"),
    ("embers", "Brasas"),
    ("rain", "Lluvia rOS"),
    ("wave", "Onda"),
];

const LABEL: &str = "overlay";

pub struct State {
    mode: Mutex<Option<&'static str>>,
    /// What `toggle` turns back on.
    last: Mutex<&'static str>,
}

impl Default for State {
    fn default() -> Self {
        Self { mode: Mutex::new(None), last: Mutex::new(MODES[0].0) }
    }
}

fn find(id: &str) -> Option<&'static str> {
    MODES.iter().map(|(m, _)| *m).find(|m| *m == id)
}

pub fn current(app: &AppHandle) -> Option<&'static str> {
    *app.state::<State>().mode.lock().unwrap()
}

/// Show the overlay with a style, or close it with `None`.
pub fn set(app: &AppHandle, mode: Option<&str>) {
    let mode = mode.and_then(find);
    let state = app.state::<State>();
    *state.mode.lock().unwrap() = mode;
    if let Some(m) = mode {
        *state.last.lock().unwrap() = m;
    }
    let _ = app.emit("overlay-mode", mode);
    crate::tray::sync(app, mode);

    let handle = app.clone();
    let _ = app.run_on_main_thread(move || match (mode, handle.get_webview_window(LABEL)) {
        (None, Some(win)) => {
            let _ = win.destroy();
        }
        (Some(_), None) => {
            if let Err(e) = create(&handle) {
                eprintln!("ross-visualizer: can't open the overlay: {e}");
            }
        }
        // An open overlay switches style by itself on the event.
        _ => {}
    });
}

/// `toggle`, `off`, `next`, `prev` or a style id.
pub fn command(app: &AppHandle, what: &str) {
    let now = current(app);
    let index = now.and_then(|m| MODES.iter().position(|(id, _)| *id == m));
    let n = MODES.len();
    match what {
        "toggle" => {
            let last = *app.state::<State>().last.lock().unwrap();
            set(app, if now.is_some() { None } else { Some(last) });
        }
        "off" => set(app, None),
        "next" => set(app, Some(MODES[index.map_or(0, |i| (i + 1) % n)].0)),
        "prev" => set(app, Some(MODES[index.map_or(n - 1, |i| (i + n - 1) % n)].0)),
        id if find(id).is_some() => set(app, Some(id)),
        other => eprintln!("ross-visualizer: unknown overlay style {other:?}"),
    }
}

fn create(app: &AppHandle) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title("ross_visualizer overlay")
        .transparent(true)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()?;

    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};

        let gtk_win = win.gtk_window()?;
        // Layer shell must be set up before the surface exists.
        if gtk_win.is_realized() {
            gtk_win.unrealize();
        }
        gtk_win.init_layer_shell();
        gtk_win.set_layer(Layer::Overlay);
        gtk_win.set_namespace("ross-visualizer");
        for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
            gtk_win.set_anchor(edge, true);
        }
        gtk_win.set_exclusive_zone(-1);
        gtk_win.set_keyboard_mode(KeyboardMode::None);
        // An empty input region sends every click to the windows underneath. Tauri's show()
        // is asynchronous and resets the region to "everything" when the window maps, so tell
        // Tauri to ignore the cursor too, and (re)apply the empty region whenever GTK lays the
        // window out, which happens after mapping and on every resize.
        let click_through = |w: &gtk::ApplicationWindow| w.input_shape_combine_region(Some(&gtk::cairo::Region::create()));
        gtk_win.connect_size_allocate(move |w, _| click_through(w));
        gtk_win.connect_map(move |w| click_through(w));
        win.show()?;
        win.set_ignore_cursor_events(true)?;
        let later = gtk_win.clone();
        gtk::glib::idle_add_local_once(move || click_through(&later));
    }
    #[cfg(not(target_os = "linux"))]
    {
        win.set_always_on_top(true)?;
        win.set_ignore_cursor_events(true)?;
        win.show()?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_overlay(app: AppHandle, mode: Option<String>) {
    set(&app, mode.as_deref());
}

#[tauri::command]
pub fn overlay_mode(app: AppHandle) -> Option<&'static str> {
    current(&app)
}
