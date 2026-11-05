// The page's side of the desktop app (src-tauri). Everything here is loaded on demand, so the
// web build doesn't carry the Tauri API.

import type { PcmAnalyser } from '../audio/pcm';

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

export async function mediaControl(action: 'play-pause' | 'next' | 'previous') {
  const { invoke } = await core();
  await invoke('media_control', { action });
}

/** Turn the overlay on with a style, or off with null. */
export async function setOverlay(mode: string | null) {
  const { invoke } = await core();
  await invoke('set_overlay', { mode });
}

export async function watchOverlay(cb: (mode: string | null) => void) {
  const { invoke } = await core();
  const { listen } = await events();
  await listen<string | null>('overlay-mode', (e) => cb(e.payload));
  cb(await invoke<string | null>('overlay_mode'));
}
