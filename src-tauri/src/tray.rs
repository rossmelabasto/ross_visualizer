//! The tray icon: open the main window, pick an overlay style, quit.

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Manager, Wry};

use crate::overlay::MODES;

/// The overlay's check items, so they follow changes made elsewhere (keys, the settings panel).
#[derive(Default)]
pub struct Items(Mutex<Vec<(Option<&'static str>, CheckMenuItem<Wry>)>>);

pub fn build(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Abrir visualizer", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;

    let mut checks = vec![(None, CheckMenuItem::with_id(app, "overlay:off", "Apagado", true, true, None::<&str>)?)];
    for (id, label) in MODES {
        checks.push((Some(id), CheckMenuItem::with_id(app, format!("overlay:{id}"), label, true, false, None::<&str>)?));
    }
    let overlay = Submenu::with_id(app, "overlay", "Overlay", crate::overlay::supported(app.handle()))?;
    for (i, (_, item)) in checks.iter().enumerate() {
        overlay.append(item)?;
        if i == 0 {
            overlay.append(&PredefinedMenuItem::separator(app)?)?;
        }
    }
    app.state::<Items>().0.lock().unwrap().extend(checks);

    let menu = Menu::with_items(app, &[&show, &overlay, &PredefinedMenuItem::separator(app)?, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .tooltip("ross_visualizer")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => crate::show_main(app),
            "quit" => app.exit(0),
            id => {
                if let Some(mode) = id.strip_prefix("overlay:") {
                    crate::overlay::command(app, if mode == "off" { "off" } else { mode });
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Tick the current overlay style.
pub fn sync(app: &AppHandle, mode: Option<&str>) {
    if let Some(items) = app.try_state::<Items>() {
        for (id, item) in items.0.lock().unwrap().iter() {
            let _ = item.set_checked(*id == mode);
        }
    }
}
