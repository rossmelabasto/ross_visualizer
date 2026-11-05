//! What's playing, from MPRIS through `playerctl`: title, artist, artwork and play state.
//! Every player is followed (a paused browser tab shouldn't hide Spotify playing); the one that
//! started playing last is the one we show. Changes go to every window as `now-playing`.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const SEP: char = '\u{1f}';

#[derive(Clone, Serialize, PartialEq)]
pub struct NowPlaying {
    player: String,
    status: String,
    title: String,
    artist: String,
    art: String,
}

#[derive(Default)]
pub struct Player {
    current: Mutex<Option<NowPlaying>>,
    tracker: Mutex<Tracker>,
    child: Mutex<Option<Child>>,
}

/// The last known state of each player, and which one is "the" player.
#[derive(Default)]
struct Tracker {
    players: Vec<NowPlaying>,
    active: Option<String>,
}

impl Tracker {
    fn apply(&mut self, np: NowPlaying) {
        let playing = np.status == "Playing";
        let name = np.player.clone();
        match self.players.iter_mut().find(|p| p.player == name) {
            Some(p) => *p = np,
            None => self.players.push(np),
        }
        if playing || self.active.is_none() {
            self.active = Some(name);
        } else if self.active.as_deref() == Some(&name) {
            // Ours stopped: follow another one that is still playing, if any.
            if let Some(other) = self.players.iter().find(|p| p.status == "Playing") {
                self.active = Some(other.player.clone());
            }
        }
    }

    fn current(&self) -> Option<NowPlaying> {
        let active = self.active.as_deref()?;
        self.players.iter().find(|p| p.player == active).cloned()
    }
}

impl Player {
    pub fn stop(&self) {
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn parse(line: &str) -> Option<NowPlaying> {
    let mut f = line.split(SEP).map(str::to_string);
    let np = NowPlaying {
        player: f.next()?,
        status: f.next().unwrap_or_default(),
        title: f.next().unwrap_or_default(),
        artist: f.next().unwrap_or_default(),
        art: f.next().unwrap_or_default(),
    };
    (!np.player.is_empty()).then_some(np)
}

fn format() -> String {
    ["{{playerName}}", "{{status}}", "{{xesam:title}}", "{{xesam:artist}}", "{{mpris:artUrl}}"].join(&SEP.to_string())
}

fn update(app: &AppHandle, line: &str) {
    let state = app.state::<Player>();
    let mut tracker = state.tracker.lock().unwrap();
    match parse(line.trim_end_matches(['\r', '\n'])) {
        Some(np) => tracker.apply(np),
        // An empty line: no players left.
        None => *tracker = Tracker::default(),
    }
    let now = tracker.current();
    let mut current = state.current.lock().unwrap();
    if *current != now {
        *current = now.clone();
        let _ = app.emit("now-playing", now);
    }
}

/// Follow every player for as long as the app runs.
pub fn watch(app: AppHandle) {
    thread::spawn(move || loop {
        // `--follow` only reports changes, so read where everyone is first.
        if let Ok(out) = crate::child_command("playerctl").args(["--all-players", "metadata", "--format", &format()]).output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                update(&app, line);
            }
        }
        let spawned = crate::child_command("playerctl")
            .args(["--all-players", "metadata", "--follow", "--format", &format()])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                eprintln!("ross-visualizer: can't start playerctl: {e}");
                return;
            }
        };
        let out = child.stdout.take().expect("piped stdout");
        *app.state::<Player>().child.lock().unwrap() = Some(child);
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            update(&app, &line);
        }
        thread::sleep(Duration::from_secs(2));
    });
}

#[tauri::command]
pub fn now_playing(player: tauri::State<'_, Player>) -> Option<NowPlaying> {
    player.current.lock().unwrap().clone()
}

/// Play/pause, next or previous on the player we're showing.
#[tauri::command]
pub fn media_control(action: String, player: tauri::State<'_, Player>) -> Result<(), String> {
    if !["play-pause", "next", "previous"].contains(&action.as_str()) {
        return Err(format!("unknown action {action}"));
    }
    let mut cmd = crate::child_command("playerctl");
    if let Some(name) = player.current.lock().unwrap().as_ref().map(|p| p.player.clone()) {
        cmd.arg("-p").arg(name);
    }
    cmd.arg(&action).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// `%xx` escapes in file:// URLs (players escape spaces and accents).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The artwork's bytes. Fetched here so the page doesn't trip over CORS or file:// URLs.
#[tauri::command]
pub async fn artwork(url: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = if let Some(path) = url.strip_prefix("file://") {
            std::fs::read(percent_decode(path)).map_err(|e| e.to_string())?
        } else if url.starts_with("https://") || url.starts_with("http://") {
            let out = Command::new("curl")
                .args(["-sSfL", "--max-time", "8", "--max-filesize", "10000000", "--", &url])
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).into_owned());
            }
            out.stdout
        } else {
            return Err(format!("unsupported artwork URL {url}"));
        };
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_playerctl_line() {
        let line = ["spotify", "Playing", "Querido Primo", "José Madero", "https://i.scdn.co/image/ab"].join(&SEP.to_string());
        let np = parse(&line).unwrap();
        assert_eq!(np.title, "Querido Primo");
        assert_eq!(np.art, "https://i.scdn.co/image/ab");
        assert!(parse("").is_none());
    }

    fn np(player: &str, status: &str) -> NowPlaying {
        NowPlaying { player: player.into(), status: status.into(), title: format!("{player} song"), artist: String::new(), art: String::new() }
    }

    #[test]
    fn follows_the_player_that_is_playing() {
        let mut t = Tracker::default();
        t.apply(np("firefox", "Paused"));
        assert_eq!(t.current().unwrap().player, "firefox");
        t.apply(np("spotify", "Playing"));
        assert_eq!(t.current().unwrap().player, "spotify");
        // A paused tab changing its metadata doesn't steal the spot.
        t.apply(np("firefox", "Paused"));
        assert_eq!(t.current().unwrap().player, "spotify");
        // Pausing Spotify keeps showing it, unless something else plays.
        t.apply(np("spotify", "Paused"));
        assert_eq!(t.current().unwrap().player, "spotify");
        t.apply(np("firefox", "Playing"));
        assert_eq!(t.current().unwrap().player, "firefox");
    }

    #[test]
    fn decodes_file_urls() {
        assert_eq!(percent_decode("/tmp/M%C3%BAsica/a%20b.png"), "/tmp/Música/a b.png");
        assert_eq!(percent_decode("/tmp/100%"), "/tmp/100%");
    }
}
