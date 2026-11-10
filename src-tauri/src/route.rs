//! Which audio reaches the visualizer. Our pw-record stream starts unlinked and we link it
//! ourselves, reading PipeWire's graph with `pw-dump`:
//!
//! - **all**: the default output's monitor, plus every app whose audio doesn't end up in that
//!   output (Discord on a headset while Spotify plays on the speakers…). Apps that do reach it,
//!   directly or through filters like an echo canceller or EasyEffects, are already in the
//!   monitor and aren't linked again, so nothing counts twice.
//! - **app:<key>**: only that app's streams (e.g. Spotify, without Discord's voices).

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    All,
    App(String),
}

impl Source {
    pub fn parse(s: &str) -> Source {
        match s.strip_prefix("app:") {
            Some(key) if !key.is_empty() => Source::App(key.to_owned()),
            _ => Source::All,
        }
    }

    pub fn id(&self) -> String {
        match self {
            Source::All => "all".into(),
            Source::App(k) => format!("app:{k}"),
        }
    }
}

/// An app that's playing (or has a stream open), for the picker in Settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct App {
    pub key: String,
    pub label: String,
    pub playing: bool,
}

#[derive(Debug, Default)]
struct Node {
    class: String,
    name: String,
    link_group: Option<String>,
    /// On our capture node: the app's pid (`OWNER_PROP`).
    owner: Option<u32>,
    app_key: Option<String>,
    app_label: String,
    running: bool,
    ignored: bool,
}

#[derive(Debug)]
struct Port {
    id: u32,
    node: u32,
    output: bool,
    monitor: bool,
}

#[derive(Debug)]
struct Link {
    id: u32,
    out_node: u32,
    out_port: u32,
    in_node: u32,
    in_port: u32,
}

#[derive(Debug, Default)]
pub struct Graph {
    nodes: HashMap<u32, Node>,
    ports: Vec<Port>,
    links: Vec<Link>,
    default_sink: Option<String>,
}

/// Our capture stream carries the app's pid in this property, so we find it among
/// other copies (a test build next to the installed one).
pub const OWNER_PROP: &str = "ross-visualizer.owner";

/// Names apps give their streams that say nothing about which app it is.
const GENERIC: &[&str] = &["", "webrtc voiceengine", "chromium", "chromium input", "electron", "playback", "audio stream"];

fn title(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

fn str_prop(props: &Value, key: &str) -> Option<String> {
    match props.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn num_prop(props: &Value, key: &str) -> Option<u32> {
    match props.get(key)? {
        Value::Number(n) => n.as_u64().map(|v| v as u32),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

impl Graph {
    /// Parse `pw-dump`'s JSON.
    pub fn parse(json: &str) -> Option<Graph> {
        let all: Vec<Value> = serde_json::from_str(json).ok()?;
        let mut g = Graph::default();
        for o in &all {
            let id = o.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let info = o.get("info").unwrap_or(&Value::Null);
            let props = info.get("props").unwrap_or(&Value::Null);
            match o.get("type").and_then(Value::as_str).unwrap_or("") {
                "PipeWire:Interface:Node" => {
                    let app_name = str_prop(props, "application.name").unwrap_or_default();
                    let binary = str_prop(props, "application.process.binary").unwrap_or_default();
                    let app_id = str_prop(props, "application.id").unwrap_or_default().to_lowercase();
                    let generic = GENERIC.contains(&app_name.to_lowercase().as_str());
                    let key = if !binary.is_empty() { binary.to_lowercase() } else { app_name.to_lowercase() };
                    let label = if generic && !binary.is_empty() { title(&binary) } else { title(&app_name) };
                    g.nodes.insert(
                        id,
                        Node {
                            class: str_prop(props, "media.class").unwrap_or_default(),
                            name: str_prop(props, "node.name").unwrap_or_default(),
                            link_group: str_prop(props, "node.link-group"),
                            owner: num_prop(props, OWNER_PROP),
                            app_key: (!key.is_empty()).then_some(key),
                            app_label: label,
                            running: info.get("state").and_then(Value::as_str) == Some("running"),
                            // EasyEffects' own streams carry everyone's audio.
                            ignored: app_id.contains("easyeffects") || app_name.to_lowercase().contains("easyeffects"),
                        },
                    );
                }
                "PipeWire:Interface:Port" => g.ports.push(Port {
                    id,
                    node: num_prop(props, "node.id").unwrap_or(0),
                    output: info.get("direction").and_then(Value::as_str) == Some("output"),
                    monitor: props.get("port.monitor").and_then(Value::as_bool).unwrap_or(false),
                }),
                "PipeWire:Interface:Link" => g.links.push(Link {
                    id,
                    out_node: info.get("output-node-id").and_then(Value::as_u64).unwrap_or(0) as u32,
                    out_port: info.get("output-port-id").and_then(Value::as_u64).unwrap_or(0) as u32,
                    in_node: info.get("input-node-id").and_then(Value::as_u64).unwrap_or(0) as u32,
                    in_port: info.get("input-port-id").and_then(Value::as_u64).unwrap_or(0) as u32,
                }),
                "PipeWire:Interface:Metadata" => {
                    if o.pointer("/props/metadata.name").and_then(Value::as_str) != Some("default") {
                        continue;
                    }
                    for m in o.get("metadata").and_then(Value::as_array).into_iter().flatten() {
                        if m.get("key").and_then(Value::as_str) == Some("default.audio.sink") {
                            let v = m.get("value").unwrap_or(&Value::Null);
                            // The value is JSON, sometimes as a string.
                            let name = v.get("name").and_then(Value::as_str).map(str::to_owned).or_else(|| {
                                v.as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()).and_then(|j| j.get("name")?.as_str().map(str::to_owned))
                            });
                            g.default_sink = name;
                        }
                    }
                }
                _ => {}
            }
        }
        Some(g)
    }

    /// Our capture node: the input stream of the app with this pid.
    fn ours(&self, pid: u32) -> Option<u32> {
        self.nodes.iter().find(|(_, n)| n.owner == Some(pid) && n.class.starts_with("Stream/Input/Audio")).map(|(id, _)| *id)
    }

    /// Apps' playback streams (not filters or loopbacks).
    fn app_streams(&self) -> impl Iterator<Item = (u32, &Node)> {
        self.nodes
            .iter()
            .filter(|(_, n)| n.class == "Stream/Output/Audio" && n.link_group.is_none() && !n.ignored && n.app_key.is_some())
            .map(|(id, n)| (*id, n))
    }

    /// Nodes whose audio ends up in the default output: it, and everything feeding it, also
    /// through filters (a filter's sink and its playback stream share a link group).
    fn feeding_default(&self) -> HashSet<u32> {
        let mut set = HashSet::new();
        let Some(name) = &self.default_sink else { return set };
        set.extend(self.nodes.iter().filter(|(_, n)| &n.name == name).map(|(id, _)| *id));
        loop {
            let before = set.len();
            for l in &self.links {
                if set.contains(&l.in_node) {
                    set.insert(l.out_node);
                }
            }
            let groups: HashSet<&String> = set.iter().filter_map(|id| self.nodes.get(id)?.link_group.as_ref()).collect();
            set.extend(self.nodes.iter().filter(|(_, n)| n.link_group.as_ref().is_some_and(|g| groups.contains(g))).map(|(id, _)| *id));
            if set.len() == before {
                return set;
            }
        }
    }

    pub fn apps(&self) -> Vec<App> {
        let mut by_key: BTreeMap<String, App> = BTreeMap::new();
        for (_, n) in self.app_streams() {
            let key = n.app_key.clone().unwrap();
            let e = by_key.entry(key.clone()).or_insert(App { key, label: n.app_label.clone(), playing: false });
            e.playing |= n.running;
        }
        by_key.into_values().collect()
    }

    /// The links our node should have, as (output port, input port).
    pub fn wanted(&self, pid: u32, source: &Source) -> Vec<(u32, u32)> {
        let Some(ours) = self.ours(pid) else { return vec![] };
        let inputs: Vec<u32> = self.ports.iter().filter(|p| p.node == ours && !p.output).map(|p| p.id).collect();
        let mut from: Vec<u32> = vec![];
        let outputs_of = |node: u32, monitor: bool| self.ports.iter().filter(move |p| p.node == node && p.output && p.monitor == monitor).map(|p| p.id);
        match source {
            Source::All => {
                let covered = self.feeding_default();
                if let Some(sink) = self.default_sink.as_ref().and_then(|name| self.nodes.iter().find(|(_, n)| &n.name == name && n.class == "Audio/Sink")) {
                    from.extend(outputs_of(*sink.0, true));
                }
                for (id, _) in self.app_streams() {
                    if !covered.contains(&id) {
                        from.extend(outputs_of(id, false));
                    }
                }
            }
            Source::App(key) => {
                for (id, n) in self.app_streams() {
                    if n.app_key.as_deref() == Some(key) {
                        from.extend(outputs_of(id, false));
                    }
                }
            }
        }
        // Our stream is mono: every channel goes into it and PipeWire mixes them.
        let mut out: Vec<(u32, u32)> = from.iter().flat_map(|o| inputs.iter().map(move |i| (*o, *i))).collect();
        out.sort_unstable();
        out
    }

    /// Links into our node now: (link id, output port, input port).
    pub fn current(&self, pid: u32) -> Vec<(u32, u32, u32)> {
        let Some(ours) = self.ours(pid) else { return vec![] };
        self.links.iter().filter(|l| l.in_node == ours).map(|l| (l.id, l.out_port, l.in_port)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: u32, class: &str, name: &str, extra: Value) -> Value {
        let mut props = json!({ "media.class": class, "node.name": name });
        props.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        json!({ "id": id, "type": "PipeWire:Interface:Node", "info": { "state": "running", "props": props } })
    }
    fn port(id: u32, node: u32, dir: &str, monitor: bool) -> Value {
        json!({ "id": id, "type": "PipeWire:Interface:Port", "info": { "direction": dir, "props": { "node.id": node, "port.monitor": monitor } } })
    }
    fn link(id: u32, on: u32, op: u32, inn: u32, ip: u32) -> Value {
        json!({ "id": id, "type": "PipeWire:Interface:Link", "info": { "output-node-id": on, "output-port-id": op, "input-node-id": inn, "input-port-id": ip } })
    }

    /// Speakers (default) and a headset. Spotify plays on the speakers through an echo
    /// canceller; Discord plays on the headset; we are pid 99.
    fn graph() -> Graph {
        let all = json!([
            node(1, "Audio/Sink", "speakers", json!({})),
            port(10, 1, "input", false),
            port(11, 1, "output", true),
            node(2, "Audio/Sink", "headset", json!({})),
            port(20, 2, "input", false),
            port(21, 2, "output", true),
            node(3, "Audio/Sink", "aec_sink", json!({ "node.link-group": "aec" })),
            port(30, 3, "input", false),
            node(4, "Stream/Output/Audio", "aec-playback", json!({ "node.link-group": "aec" })),
            port(40, 4, "output", false),
            link(400, 4, 40, 1, 10),
            node(5, "Stream/Output/Audio", "spotify", json!({ "application.name": "spotify", "application.process.binary": "spotify", "application.process.id": 5000 })),
            port(50, 5, "output", false),
            link(500, 5, 50, 3, 30),
            node(6, "Stream/Output/Audio", "WEBRTC VoiceEngine", json!({ "application.name": "WEBRTC VoiceEngine", "application.process.binary": "Discord", "application.process.id": 6000 })),
            port(60, 6, "output", false),
            link(600, 6, 60, 2, 20),
            node(7, "Stream/Input/Audio", "ross-visualizer", json!({ "ross-visualizer.owner": 99 })),
            port(70, 7, "input", false),
            link(700, 1, 11, 7, 70),
            { "id": 0, "type": "PipeWire:Interface:Metadata", "props": { "metadata.name": "default" },
              "metadata": [{ "subject": 0, "key": "default.audio.sink", "type": "Spa:String:JSON", "value": { "name": "speakers" } }] }
        ]);
        Graph::parse(&all.to_string()).unwrap()
    }

    #[test]
    fn all_adds_apps_on_other_outputs_once() {
        // The speakers' monitor (Spotify is in it through the echo canceller) plus Discord.
        assert_eq!(graph().wanted(99, &Source::All), vec![(11, 70), (60, 70)]);
    }

    #[test]
    fn one_app_only() {
        assert_eq!(graph().wanted(99, &Source::App("spotify".into())), vec![(50, 70)]);
        assert_eq!(graph().wanted(99, &Source::App("vlc".into())), vec![]);
    }

    #[test]
    fn lists_apps_with_useful_names() {
        let apps = graph().apps();
        let labels: Vec<_> = apps.iter().map(|a| (a.key.as_str(), a.label.as_str())).collect();
        assert_eq!(labels, vec![("discord", "Discord"), ("spotify", "Spotify")]);
        assert_eq!(graph().current(99), vec![(700, 11, 70)]);
    }

    #[test]
    fn source_ids_round_trip() {
        assert_eq!(Source::parse("all"), Source::All);
        assert_eq!(Source::parse("app:spotify"), Source::App("spotify".into()));
        assert_eq!(Source::parse("app:"), Source::All);
        assert_eq!(Source::App("x".into()).id(), "app:x");
    }
}
