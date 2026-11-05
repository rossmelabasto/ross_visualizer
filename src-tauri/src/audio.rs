//! The system's audio: `pw-record` taps the default output's monitor and we pass the raw PCM
//! (mono f32 at 48 kHz) to every window that asked for it, as binary IPC messages.

use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};

/// About 21 ms of audio per message.
const CHUNK_SAMPLES: usize = 1024;

#[derive(Default)]
pub struct Capture {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    /// One channel per window label; a reloaded page replaces its old one.
    listeners: Vec<(String, Channel<InvokeResponseBody>)>,
    child: Option<Child>,
    running: bool,
}

impl Capture {
    fn subscribe(&self, label: String, channel: Channel<InvokeResponseBody>) {
        let mut inner = self.inner.lock().unwrap();
        inner.listeners.retain(|(l, _)| *l != label);
        inner.listeners.push((label, channel));
        if !inner.running {
            inner.running = true;
            let shared = self.inner.clone();
            thread::spawn(move || run(shared));
        }
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.listeners.clear();
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn spawn() -> std::io::Result<Child> {
    crate::child_command("pw-record")
        .args([
            "-P",
            "{ stream.capture.sink=true node.name=ross-visualizer media.name=ross_visualizer }",
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
        shared.lock().unwrap().child = Some(child);

        while out.read_exact(&mut buf).is_ok() {
            let mut inner = shared.lock().unwrap();
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
    capture.subscribe(window.label().to_string(), on_chunk);
}
