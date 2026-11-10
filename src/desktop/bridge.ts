// The page's side of the desktop app (src-tauri). Everything here is loaded on demand, so the
// web build doesn't carry the Tauri API.

import type { PcmAnalyser } from '../audio/pcm';
import type { OverlayOptions } from '../overlay/modes';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** What the system says is playing (MPRIS), as the Rust side reports it. */
export interface NowPlaying {
  player: string;
  status: 'Playing' | 'Paused' | 'Stopped' | string;
  title: string;
  artist: string;
  /** https:// or file:// URL of the artwork, as the player publishes it. */
  art: string;
}

const core = () => import('@tauri-apps/api/core');
const events = () => import('@tauri-apps/api/event');

/** Stream the system's audio (mono f32 PCM at `analyser.sampleRate`) into `analyser`. */
export async function streamSystemAudio(analyser: PcmAnalyser) {
  const { invoke, Channel } = await core();
  const channel = new Channel<ArrayBuffer | number[]>();
  channel.onmessage = (data) => {
    const bytes = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
    analyser.push(new Float32Array(bytes));
  };
  await invoke('audio_subscribe', { onChunk: channel });
}

export async function watchNowPlaying(cb: (n: NowPlaying | null) => void) {
  const { invoke } = await core();
  const { listen } = await events();
  await listen<NowPlaying | null>('now-playing', (e) => cb(e.payload));
  cb(await invoke<NowPlaying | null>('now_playing'));
}

/** Artwork as a blob: URL. The Rust side fetches it, so CORS and file:// paths don't matter. */
export async function artworkUrl(url: string): Promise<string | null> {
  const { invoke } = await core();
  try {
    const bytes = await invoke<ArrayBuffer>('artwork', { url });
    if (!bytes.byteLength) return null;
    return URL.createObjectURL(new Blob([bytes]));
  } catch {
    return null;
  }
}

/** "user@host" of this computer, for the ASCII scene's prompt. */
export async function userHost(): Promise<string | null> {
  const { invoke } = await core();
  return invoke<string>('user_host').catch(() => null);
}

/** Where the system audio comes from: everything that plays, or one app. */
export interface AudioSources {
  /** "all" or "app:<key>". */
  source: string;
  apps: { key: string; label: string; playing: boolean }[];
}

export async function watchAudioSources(cb: (s: AudioSources) => void) {
  const { invoke } = await core();
  const { listen } = await events();
  await listen<AudioSources>('audio-sources', (e) => cb(e.payload));
  cb(await invoke<AudioSources>('audio_sources'));
}

export async function setAudioSource(source: string) {
  const { invoke } = await core();
  await invoke('set_audio_source', { source });
}

export interface DesktopInfo {
  desktop: 'niri' | 'hyprland' | 'sway' | 'kde' | 'gnome' | 'other';
  /** How a shortcut runs the app: the AppImage's path or `ross-visualizer`. */
  command: string;
}

export async function desktopInfo(): Promise<DesktopInfo> {
  const { invoke } = await core();
  return invoke<DesktopInfo>('desktop_info').catch(() => ({ desktop: 'other' as const, command: 'ross-visualizer' }));
}

export async function mediaControl(action: 'play-pause' | 'next' | 'previous') {
  const { invoke } = await core();
  await invoke('media_control', { action });
}

/** Turn the overlay on with a style, or off with null. */
export async function setOverlay(mode: string | null) {
  const { invoke } = await core();
  await invoke('set_overlay', { mode });
}

/** In the app the page's Fullscreen API isn't wired to the window: ask the window itself. */
export async function toggleWindowFullscreen(): Promise<boolean> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  const next = !(await win.isFullscreen());
  await win.setFullscreen(next);
  return next;
}

/** False on sessions without layer-shell (GNOME, X11), where there's no overlay to offer. */
export async function overlaySupported() {
  const { invoke } = await core();
  return invoke<boolean>('overlay_supported');
}

export async function watchOverlay(cb: (mode: string | null) => void) {
  const { invoke } = await core();
  const { listen } = await events();
  await listen<string | null>('overlay-mode', (e) => cb(e.payload));
  cb(await invoke<string | null>('overlay_mode'));
}

/** Each overlay style's settings, now and whenever they change (from either window). */
export async function watchOverlayOptions(cb: (options: OverlayOptions) => void) {
  const { invoke } = await core();
  const { listen } = await events();
  await listen<OverlayOptions>('overlay-options', (e) => cb(e.payload));
  cb(await invoke<OverlayOptions>('overlay_options'));
}

export async function setOverlayOptions(options: OverlayOptions) {
  const { invoke } = await core();
  await invoke('set_overlay_options', { options });
}

/** Where the overlay window takes the pointer, as [x, y, w, h] rectangles in CSS pixels. */
export async function overlayInput(rects: [number, number, number, number][]) {
  const { invoke } = await core();
  await invoke('overlay_input', { rects: rects.map((r) => r.map(Math.round)) });
}

/** With RV_DEBUG set, pages report to the app's stderr (end-to-end tests read it). */
export function debugLog(msg: string) {
  if (!(window as { __RV_DEBUG__?: boolean }).__RV_DEBUG__) return;
  core().then(({ invoke }) => invoke('debug_log', { msg }).catch(() => {}));
}
