//! The overlay: a transparent window on the layer-shell "overlay" layer (above every window and
//! panel), anchored to all four edges, that takes no keyboard focus and lets clicks through.
//! The page itself (overlay.html) draws the chosen style. The last style and each style's
//! settings are saved in the app's config dir (overlay.json).

use std::sync::Mutex;

use serde_json::{json, Value};
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
    /// Per-style settings, as the page defines them (src/overlay/modes.ts).
    options: Mutex<Value>,
    /// Whether the overlay was on when the app last ran (see `restore`).
    was_on: Mutex<bool>,
    /// Where the overlay takes the pointer (x, y, width, height in window pixels); usually
    /// nowhere. Orbit asks for its bubble, to notice the mouse and fade out of the way.
    input: Mutex<Vec<[i32; 4]>>,
    /// False on sessions without layer-shell (GNOME, X11): there the overlay stays off.
    supported: Mutex<bool>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            mode: Mutex::new(None),
            last: Mutex::new(MODES[0].0),
            was_on: Mutex::new(false),
            options: Mutex::new(json!({})),
            input: Mutex::new(Vec::new()),
            supported: Mutex::new(true),
        }
    }
}

fn settings_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("overlay.json"))
}

/// Read the saved style and settings (at startup).
pub fn load(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    {
        *app.state::<State>().supported.lock().unwrap() = gtk_layer_shell::is_supported();
    }
    let Some(saved) = settings_file(app).and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else {
        return;
    };
    let state = app.state::<State>();
    if let Some(last) = saved.get("last").and_then(Value::as_str).and_then(find) {
        *state.last.lock().unwrap() = last;
    }
    if let Some(options) = saved.get("options").filter(|o| o.is_object()) {
        *state.options.lock().unwrap() = options.clone();
    }
    *state.was_on.lock().unwrap() = saved.get("on").and_then(Value::as_bool).unwrap_or(false);
}

/// Bring the overlay back if it was on when the app last ran (after an update or a login).
pub fn restore(app: &AppHandle) {
    let state = app.state::<State>();
    let (on, last) = (*state.was_on.lock().unwrap(), *state.last.lock().unwrap());
    if on && current(app).is_none() {
        set(app, Some(last));
    }
}

pub fn supported(app: &AppHandle) -> bool {
    *app.state::<State>().supported.lock().unwrap()
}

fn save(app: &AppHandle) {
    let state = app.state::<State>();
    let data = json!({
        "last": *state.last.lock().unwrap(),
        "on": state.mode.lock().unwrap().is_some(),
        "options": state.options.lock().unwrap().clone(),
    });
    if let Some(file) = settings_file(app) {
        let _ = std::fs::create_dir_all(file.parent().unwrap());
        if let Err(e) = std::fs::write(&file, serde_json::to_vec_pretty(&data).unwrap()) {
            eprintln!("ross-visualizer: can't save {}: {e}", file.display());
        }
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
    if mode.is_some() && !supported(app) {
        eprintln!("ross-visualizer: this session has no layer-shell, so the overlay is unavailable");
        return;
    }
    let state = app.state::<State>();
    *state.mode.lock().unwrap() = mode;
    if let Some(m) = mode {
        *state.last.lock().unwrap() = m;
    }
    save(app);
    let _ = app.emit("overlay-mode", mode);
    crate::tray::sync(app, mode);

    if mode.is_none() {
        state.input.lock().unwrap().clear();
    }
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
    // A fresh overlay lets every click through until its page asks otherwise.
    app.state::<State>().input.lock().unwrap().clear();
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
        // The input region (usually empty) sends clicks to the windows underneath. Tauri's
        // show() is asynchronous and resets the region to "everything" when the window maps,
        // so tell Tauri to ignore the cursor too, and (re)apply ours whenever GTK lays the
        // window out, which happens after mapping and on every resize.
        let (a, b, c) = (app.clone(), app.clone(), app.clone());
        gtk_win.connect_size_allocate(move |w, _| apply_input(&a, w));
        gtk_win.connect_map(move |w| apply_input(&b, w));
        win.show()?;
        win.set_ignore_cursor_events(true)?;
        let later = gtk_win.clone();
        gtk::glib::idle_add_local_once(move || apply_input(&c, &later));
    }
    #[cfg(not(target_os = "linux"))]
    {
        win.set_always_on_top(true)?;
        win.set_ignore_cursor_events(true)?;
        win.show()?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn apply_input(app: &AppHandle, win: &gtk::ApplicationWindow) {
    use gtk::prelude::*;
    let region = gtk::cairo::Region::create();
    for [x, y, w, h] in app.state::<State>().input.lock().unwrap().iter() {
        let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(*x, *y, *w, *h));
    }
    win.input_shape_combine_region(Some(&region));
}

/// Take the pointer only inside these rectangles (none: let every click through).
#[tauri::command]
pub fn overlay_input(app: AppHandle, rects: Vec<[i32; 4]>) {
    *app.state::<State>().input.lock().unwrap() = rects;
    #[cfg(target_os = "linux")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(Ok(gtk_win)) = handle.get_webview_window(LABEL).map(|w| w.gtk_window()) {
                apply_input(&handle, &gtk_win);
            }
        });
    }
}

#[tauri::command]
pub fn overlay_options(app: AppHandle) -> Value {
    app.state::<State>().options.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_overlay_options(app: AppHandle, options: Value) {
    if !options.is_object() {
        return;
    }
    *app.state::<State>().options.lock().unwrap() = options.clone();
    save(&app);
    let _ = app.emit("overlay-options", options);
}

#[tauri::command]
pub fn set_overlay(app: AppHandle, mode: Option<String>) {
    set(&app, mode.as_deref());
}

#[tauri::command]
pub fn overlay_supported(app: AppHandle) -> bool {
    supported(&app)
}

#[tauri::command]
pub fn overlay_mode(app: AppHandle) -> Option<&'static str> {
    current(&app)
}
