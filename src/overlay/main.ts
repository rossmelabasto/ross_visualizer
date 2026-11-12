import { AudioEngine } from '../audio/engine';
import { emptyFeatures, idleFeatures, type AudioFeatures } from '../audio/features';
import { PcmAnalyser } from '../audio/pcm';
import {
  artworkUrl,
  debugLog,
  isDesktop,
  overlayInput,
  streamSystemAudio,
  watchNowPlaying,
  watchOverlay,
  watchOverlayOptions,
  type NowPlaying,
} from '../desktop/bridge';
import type { Scene } from '../gl/renderer';
import { Stage } from '../stage';
import { android, feedAudio, onAndroid } from '../android/native';
import { isOverlayMode, optionOf, OVERLAY_MODES, OVERLAY_OPTIONS, type OverlayMode, type OverlayOptions } from './modes';
import { createOverlayScenes, OVERLAY_BLOOM, SHOWN_IN_SILENCE } from './scenes';

// The desktop overlay: a transparent, click-through layer above every window (src-tauri sets
// that up). Same audio and palette as the main window, but only the edge styles in ./scenes.

const TRANSITION = 0.8;
/** After this long without sound the overlay fades away, and stops drawing once it's gone. */
const QUIET_AFTER = 5;
/**
 * How long the bubble stays faded out after the mouse touches it. While faded the window
 * can't see the mouse (the clicks go through), so this is short: if the mouse is still there
 * and moves, it fades out again.
 */
const PEEK_SECONDS = 1.4;

class OverlayApp {
  private readonly stage: Stage;
  private readonly engine = new AudioEngine();
  private readonly scenes = createOverlayScenes();
  private mode: OverlayMode;
  private prev: OverlayMode | null = null;
  private switchedAt = 0;
  private readonly idle = emptyFeatures();
  private analysis: AudioFeatures | null = null;
  private beatLatch = false;
  private lastAnalysis = performance.now() / 1000;
  private last = performance.now() / 1000;
  private lastSound = -Infinity;
  private fade = 0;
  private blank = false;
  private title = '';
  private artKey: string | null = null;
  private artBlob: string | null = null;
  private options: OverlayOptions = {};
  private music = 0;
  /** The pointer area last sent to the window, to avoid resending it every frame. */
  private inputKey = '';

  constructor(canvas: HTMLCanvasElement) {
    this.stage = new Stage(canvas, true);
    for (const s of Object.values(this.scenes)) s.init(this.stage.renderer);
    const params = new URLSearchParams(location.search);
    const asked = params.get('mode');
    this.mode = isOverlayMode(asked) ? asked : 'halo';
    // Preview only: any other parameter is a setting of that style (?mode=orbit&position=center).
    // and ?art=<url> paints with that artwork.
    for (const [k, v] of params) if (k !== 'mode' && k !== 'art') (this.options[this.mode] ??= {})[k] = Number.isNaN(Number(v)) ? v : Number(v);
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    // The window only takes the pointer over Orbit's bubble: touching it fades the bubble away
    // and lets the clicks through for a few seconds.
    window.addEventListener('pointermove', () => this.peek());
    if (isDesktop) this.start();
    else if (params.get('android') === '1' && window.RossAndroid) this.startAndroid();
    else this.preview();
    window.setInterval(() => this.analyze(), 1000 / 60);
    requestAnimationFrame((t) => this.loop(t));
  }

  private async start() {
    const analyser = new PcmAnalyser(48000);
    this.engine.useNative(analyser);
    this.stage.setCover(null, 3);
    await streamSystemAudio(analyser);
    await watchNowPlaying((n) => this.onTrack(n));
    await watchOverlayOptions((o) => {
      this.options = o;
      this.updateInput();
      this.report();
    });
    let first = true;
    await watchOverlay((m) => {
      if (!isOverlayMode(m)) return;
      // The style the overlay was opened with: no cross-fade from the default.
      this.setMode(m, !first);
      first = false;
    });
  }

  /** In Android's overlay window (OverlayService): the service sends audio, song and style. */
  private startAndroid() {
    this.stage.setCover(null, 3);
    // Android draws this window at most 80 % opaque so touches go through: make up for it.
    this.stage.renderer.canvas.style.filter = 'brightness(1.3) saturate(1.2)';
    let first = true;
    onAndroid('audio', (a) => {
      if (!a.ok) return;
      const analyser = new PcmAnalyser(a.rate ?? 44100, 1024);
      this.engine.useNative(analyser);
      feedAudio((samples) => analyser.push(samples));
    });
    onAndroid('media', (m) => {
      this.title = m?.title ? `${m.title}${m.artist ? ` - ${m.artist}` : ''}` : '';
      if (!m?.title) {
        if (this.artKey !== null) this.stage.setCover(null, 3);
        this.artKey = null;
        return;
      }
      if (m.art !== undefined && m.artKey !== this.artKey) {
        this.artKey = m.artKey;
        this.stage.setCover(m.art || null, this.title.length);
      }
    });
    onAndroid('overlay', (o) => {
      this.options = o.options as OverlayOptions;
      if (isOverlayMode(o.mode)) this.setMode(o.mode, !first);
      first = false;
    });
    android.ready();
  }

  private setMode(m: OverlayMode, fade = true) {
    if (m === this.mode) return;
    this.prev = fade ? this.mode : null;
    this.mode = m;
    this.switchedAt = performance.now() / 1000;
    this.updateInput();
    this.report();
  }

  /** What the current style is really drawing with (RV_DEBUG only). */
  private report() {
    const keys = OVERLAY_OPTIONS[this.mode]?.map((o) => `${o.key}=${optionOf(this.options, this.mode, o.key)}`) ?? [];
    debugLog(`drawing ${this.mode} ${keys.join(' ')}`);
  }

  private peek() {
    if (this.mode !== 'orbit' || this.scenes.orbit.peeking) return;
    this.scenes.orbit.peek(performance.now() / 1000, PEEK_SECONDS);
    this.updateInput();
    window.setTimeout(() => this.updateInput(), PEEK_SECONDS * 1000 + 50);
  }

  /** Take the pointer over Orbit's bubble (while it's on screen), nowhere otherwise. */
  private updateInput() {
    if (!isDesktop) return;
    let rects: [number, number, number, number][] = [];
    if (this.mode === 'orbit' && !this.scenes.orbit.peeking && !this.blank) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.scenes.orbit.ctx.options = this.options;
      const { x, y, R } = this.scenes.orbit.bubble(w, h);
      // The circle as horizontal strips (the page's y runs down, the shader's up).
      const strips = 10;
      for (let i = 0; i < strips; i++) {
        const dy = ((i + 0.5) / strips) * 2 - 1;
        const half = R * Math.sqrt(1 - dy * dy);
        rects.push([x - half, h - y + (i / strips) * 2 * R - R, half * 2, (2 * R) / strips + 1]);
      }
    }
    const key = JSON.stringify(rects);
    if (key === this.inputKey) return;
    this.inputKey = key;
    overlayInput(rects).catch(() => {});
  }

  /**
   * Opened in a plain browser (development): play the demo synth over a stand-in desktop,
   * and let 1–7 switch styles.
   */
  private preview() {
    document.body.style.background = 'linear-gradient(135deg, #1d2129, #2a2f3a)';
    const art = new URLSearchParams(location.search).get('art');
    if (art) this.stage.setCover(art);
    const start = () => this.engine.useDemo().catch(() => {});
    start();
    window.addEventListener('pointerdown', start, { once: true });
    window.addEventListener('keydown', (e) => {
      const m = OVERLAY_MODES[Number(e.key) - 1];
      if (m) this.setMode(m);
    });
  }

  private async onTrack(n: NowPlaying | null) {
    this.title = n?.title ? `${n.title}${n.artist ? ` - ${n.artist}` : ''}` : '';
    const key = n?.title ? n.art || this.title : null;
    if (key === this.artKey) return;
    this.artKey = key;
    const art = n?.art ? await artworkUrl(n.art) : null;
    if (key !== this.artKey) return;
    if (this.artBlob) URL.revokeObjectURL(this.artBlob);
    this.artBlob = art;
    this.stage.setCover(art, this.title.length);
  }

  private onResize() {
    // A glow along the edges doesn't need the full HiDPI resolution; the GPU is for the apps below.
    this.stage.renderer.resize(window.innerWidth, window.innerHeight, 1);
    this.updateInput();
  }

  private analyze() {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0.001, now - this.lastAnalysis));
    this.lastAnalysis = now;
    this.analysis = this.engine.frame(dt, now);
    if (this.analysis?.onBeat) this.beatLatch = true;
  }

  private loop(ts: number) {
    requestAnimationFrame((t) => this.loop(t));
    const now = ts / 1000;
    const dt = Math.min(0.1, Math.max(0.001, now - this.last));
    this.last = now;

    let f = this.analysis;
    if (f && !f.silent) {
      this.lastSound = now;
      f.onBeat = this.beatLatch;
      this.beatLatch = false;
    } else f = idleFeatures(this.idle, now);

    const playing = now - this.lastSound < 1.5 ? 1 : 0;
    this.music += (playing - this.music) * (1 - Math.exp(-dt / 1.0));
    const want = SHOWN_IN_SILENCE.has(this.mode) || now - this.lastSound < QUIET_AFTER ? 1 : 0;
    this.fade += (want - this.fade) * (1 - Math.exp(-dt / (want ? 0.4 : 1.2)));
    if (this.fade < 0.003 && !want) {
      // Nothing to show: clear once and let the GPU rest until the music comes back.
      if (!this.blank) {
        const gl = this.stage.renderer.gl;
        this.stage.renderer.bindTarget(null);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.blank = true;
        this.updateInput();
      }
      return;
    }
    if (this.blank) {
      this.blank = false;
      this.updateInput();
    }
    for (const s of Object.values(this.scenes)) s.ctx = { options: this.options, music: this.music };

    const frame = this.stage.step(f, now, dt, this.title, 1);
    const scene: Scene = this.scenes[this.mode];
    let prev = null;
    if (this.prev) {
      const p = (now - this.switchedAt) / TRANSITION;
      if (p >= 1) this.prev = null;
      else prev = { scene: this.scenes[this.prev], mix: 1 - p * p * (3 - 2 * p), bloom: OVERLAY_BLOOM[this.prev] };
    }
    this.stage.draw(frame, scene, OVERLAY_BLOOM[this.mode], prev, this.fade);
  }
}

new OverlayApp(document.getElementById('gl') as HTMLCanvasElement);
