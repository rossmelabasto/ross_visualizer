// The page's side of the Android app (gen/android: NativeBridge.kt, MediaWatcher.kt). The native
// code is reachable as window.RossAndroid and answers through window.__rossNative(type, data);
// audio arrives as base64 8-bit waveforms through window.__rossAudio.

interface Bridge {
  state(): string;
  requestAudio(): void;
  openMediaAccess(): void;
  startAudio(): void;
  stopAudio(): void;
  startMedia(): void;
  mediaControl(action: string): void;
  setFullscreen(on: boolean): void;
}

declare global {
  interface Window {
    RossAndroid?: Bridge;
    __rossNative?: (type: string, data: unknown) => void;
    __rossAudio?: (b64: string) => void;
  }
}

export interface AndroidState {
  /** The audio permission (Android files the Visualizer under the microphone). */
  audio: boolean;
  /** Notification access, which lets us read the media sessions. */
  media: boolean;
  listening: boolean;
  sdk: number;
}

export interface AndroidAudio {
  ok: boolean;
  rate?: number;
  size?: number;
  reason?: string;
}

export interface AndroidMedia {
  player: string;
  status: string;
  title: string;
  artist: string;
  artKey: string;
  /** Only present when the artwork changed: a data: URL, or '' when there is none. */
  art?: string;
}

interface Handlers {
  state?: (s: AndroidState) => void;
  audio?: (a: AndroidAudio) => void;
  media?: (m: AndroidMedia | null) => void;
}

const handlers: Handlers = {};
const bridge = () => window.RossAndroid;

export function onAndroid<K extends keyof Handlers>(type: K, fn: NonNullable<Handlers[K]>) {
  handlers[type] = fn;
  window.__rossNative = (t, data) => (handlers[t as keyof Handlers] as ((d: unknown) => void) | undefined)?.(data);
}

export function androidState(): AndroidState {
  const raw = bridge()?.state();
  return raw ? (JSON.parse(raw) as AndroidState) : { audio: false, media: false, listening: false, sdk: 0 };
}

/** Each waveform is 8-bit unsigned, centred on 128. */
export function feedAudio(push: (samples: Float32Array) => void) {
  window.__rossAudio = (b64) => {
    const bin = atob(b64);
    const out = new Float32Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) - 128) / 128;
    push(out);
  };
}

export const android = {
  requestAudio: () => bridge()?.requestAudio(),
  openMediaAccess: () => bridge()?.openMediaAccess(),
  startAudio: () => bridge()?.startAudio(),
  startMedia: () => bridge()?.startMedia(),
  mediaControl: (action: string) => bridge()?.mediaControl(action),
  setFullscreen: (on: boolean) => bridge()?.setFullscreen(on),
};
