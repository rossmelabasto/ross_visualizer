//! The system's audio: `pw-record` captures, unlinked, and `route.rs` decides what to link
//! into it (everything that plays, or one app). We pass the raw PCM (mono f32 at 48 kHz) to
//! every window that asked for it, as binary IPC messages.

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

use crate::route::{App, Graph, Source};

/// About 21 ms of audio per message.
const CHUNK_SAMPLES: usize = 1024;

#[derive(Default)]
pub struct Capture {
    inner: Arc<Mutex<Inner>>,
    /// Set when the graph or the chosen source changed: the router relinks.
    dirty: Arc<AtomicBool>,
}

struct Inner {
    /// One channel per window label; a reloaded page replaces its old one.
    listeners: Vec<(String, Channel<InvokeResponseBody>)>,
    child: Option<Child>,
    /// pw-link watching the graph for new and gone streams.
    watcher: Option<Child>,
    pid: Option<u32>,
    running: bool,
    source: Source,
    apps: Vec<App>,
    last_data: Instant,
    app: Option<AppHandle>,
}

impl Default for Inner {
    fn default() -> Self {
        Inner {
            listeners: vec![],
            child: None,
            watcher: None,
            pid: None,
            running: false,
            source: Source::All,
            apps: vec![],
            last_data: Instant::now(),
            app: None,
        }
    }
}

/// What Settings shows: the chosen source and the apps there are to choose from.
#[derive(Clone, Serialize)]
pub struct Sources {
    source: String,
    apps: Vec<App>,
}

impl Capture {
    fn subscribe(&self, app: AppHandle, label: String, channel: Channel<InvokeResponseBody>) {
        let mut inner = self.inner.lock().unwrap();
        inner.app = Some(app);
        inner.listeners.retain(|(l, _)| *l != label);
        inner.listeners.push((label, channel));
        if !inner.running {
            inner.running = true;
            let shared = self.inner.clone();
            thread::spawn(move || run(shared));
            let (shared, dirty) = (self.inner.clone(), self.dirty.clone());
            thread::spawn(move || route(shared, dirty));
            let shared = self.inner.clone();
            thread::spawn(move || fill_silence(shared));
        }
    }

    fn sources(&self) -> Sources {
        let inner = self.inner.lock().unwrap();
        Sources { source: inner.source.id(), apps: inner.apps.clone() }
    }

    fn set_source(&self, source: Source) {
        self.inner.lock().unwrap().source = source;
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.listeners.clear();
        for mut child in [inner.child.take(), inner.watcher.take()].into_iter().flatten() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn spawn() -> std::io::Result<Child> {
    let props = format!("{{ node.name=ross-visualizer media.name=ross_visualizer {}={} }}", crate::route::OWNER_PROP, std::process::id());
    crate::child_command("pw-record")
        .args([
            // Without --raw, pw-record writes an AU file: a header and big-endian samples.
            "--raw",
            // Don't let the session manager link us: route() does.
            "--target",
            "0",
            "-P",
            &props,
            "--format",
            "f32",
            "--channels",
            "1",
            "--rate",
            "48000",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

/// Nothing linked (nothing plays, or the chosen app is quiet) means no data at all: send
/// silence then, or the page would keep analysing the last sound it got.
fn fill_silence(shared: Arc<Mutex<Inner>>) {
    let zeros = vec![0u8; CHUNK_SAMPLES * 4];
    loop {
        thread::sleep(Duration::from_millis(21));
        let mut inner = shared.lock().unwrap();
        if !inner.running {
            return;
        }
        if inner.last_data.elapsed() > Duration::from_millis(80) {
            inner.listeners.retain(|(_, ch)| ch.send(InvokeResponseBody::Raw(zeros.clone())).is_ok());
        }
    }
}

/// Keep our stream linked to the chosen source as streams come and go and the default output
/// changes. `pw-link -m` tells us when ports appear or vanish; a slow poll catches the rest.
fn route(shared: Arc<Mutex<Inner>>, dirty: Arc<AtomicBool>) {
    dirty.store(true, Ordering::Relaxed);
    let mut last_scan = Instant::now();
    let mut watcher_died = Instant::now() - Duration::from_secs(10);
    loop {
        thread::sleep(Duration::from_millis(100));
        {
            let mut inner = shared.lock().unwrap();
            if !inner.running {
                if let Some(mut w) = inner.watcher.take() {
                    let _ = w.kill();
                    let _ = w.wait();
                }
                return;
            }
            let alive = inner.watcher.as_mut().is_some_and(|w| matches!(w.try_wait(), Ok(None)));
            if !alive && watcher_died.elapsed() > Duration::from_secs(2) {
                watcher_died = Instant::now();
                inner.watcher = watch(dirty.clone());
            }
        }
        if !dirty.swap(false, Ordering::Relaxed) && last_scan.elapsed() < Duration::from_secs(2) {
            continue;
        }
        last_scan = Instant::now();
        relink(&shared);
    }
}

fn watch(dirty: Arc<AtomicBool>) -> Option<Child> {
    let mut child = crate::child_command("pw-link").args(["-m", "-o"]).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let out = child.stdout.take()?;
    thread::spawn(move || {
        for _ in BufReader::new(out).lines().map_while(Result::ok) {
            dirty.store(true, Ordering::Relaxed);
        }
    });
    Some(child)
}

fn relink(shared: &Arc<Mutex<Inner>>) {
    let (pid, source) = {
        let inner = shared.lock().unwrap();
        match inner.pid {
            Some(pid) => (pid, inner.source.clone()),
            None => return,
        }
    };
    let Ok(out) = crate::child_command("pw-dump").stderr(Stdio::null()).output() else { return };
    let Some(graph) = Graph::parse(&String::from_utf8_lossy(&out.stdout)) else { return };
    let wanted = graph.wanted(pid, &source);
    let current = graph.current(pid);
    let pw_link = |args: &[String]| {
        let _ = crate::child_command("pw-link").args(args).stdout(Stdio::null()).stderr(Stdio::null()).status();
    };
    let mut changed = false;
    for (link, o, i) in &current {
        if !wanted.contains(&(*o, *i)) {
            pw_link(&["-d".into(), link.to_string()]);
            changed = true;
        }
    }
    for (o, i) in &wanted {
        if !current.iter().any(|(_, co, ci)| co == o && ci == i) {
            pw_link(&[o.to_string(), i.to_string()]);
            changed = true;
        }
    }
    if changed && std::env::var_os("RV_DEBUG").is_some() {
        eprintln!("ross-visualizer: audio {} -> links {wanted:?}", source.id());
    }
    let apps = graph.apps();
    let mut inner = shared.lock().unwrap();
    if apps != inner.apps {
        inner.apps = apps;
        if let Some(app) = &inner.app {
            let _ = app.emit("audio-sources", Sources { source: inner.source.id(), apps: inner.apps.clone() });
        }
    }
}

/// Read from pw-record until nobody listens any more; restart it if PipeWire goes away.
fn run(shared: Arc<Mutex<Inner>>) {
    let mut buf = vec![0u8; CHUNK_SAMPLES * 4];
    loop {
        let mut child = match spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("ross-visualizer: can't start pw-record: {e}");
                shared.lock().unwrap().running = false;
                return;
            }
        };
        let mut out = child.stdout.take().expect("piped stdout");
        {
            let mut inner = shared.lock().unwrap();
            inner.pid = Some(std::process::id());
            inner.child = Some(child);
        }

        let debug = std::env::var_os("RV_DEBUG").is_some();
        let (mut sum, mut count) = (0f64, 0usize);
        while out.read_exact(&mut buf).is_ok() {
            if debug {
                for s in buf.chunks_exact(4) {
                    let v = f32::from_ne_bytes([s[0], s[1], s[2], s[3]]) as f64;
                    sum += v * v;
                }
                count += CHUNK_SAMPLES;
                if count >= 48_000 {
                    eprintln!("ross-visualizer: audio rms {:.3}", (sum / count as f64).sqrt());
                    (sum, count) = (0.0, 0);
                }
            }
            let mut inner = shared.lock().unwrap();
            inner.last_data = Instant::now();
            inner.listeners.retain(|(_, ch)| ch.send(InvokeResponseBody::Raw(buf.clone())).is_ok());
            if inner.listeners.is_empty() {
                if let Some(mut c) = inner.child.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                inner.running = false;
                return;
            }
        }

        let mut inner = shared.lock().unwrap();
        if let Some(mut c) = inner.child.take() {
            let _ = c.wait();
        }
        if inner.listeners.is_empty() {
            inner.running = false;
            return;
        }
        drop(inner);
        thread::sleep(Duration::from_secs(1));
    }
}

#[tauri::command]
pub fn audio_subscribe(window: tauri::WebviewWindow, capture: tauri::State<'_, Capture>, on_chunk: Channel<InvokeResponseBody>) {
    // RV_NO_AUDIO=1: run without capture (debugging).
    if std::env::var_os("RV_NO_AUDIO").is_some() {
        return;
    }
    capture.subscribe(window.app_handle().clone(), window.label().to_string(), on_chunk);
}

#[tauri::command]
pub fn audio_sources(capture: tauri::State<'_, Capture>) -> Sources {
    capture.sources()
}

/// "all" or "app:<key>".
#[tauri::command]
pub fn set_audio_source(app: AppHandle, capture: tauri::State<'_, Capture>, source: String) {
    capture.set_source(Source::parse(&source));
    let _ = app.emit("audio-sources", capture.sources());
}
