import { AudioEngine } from '../audio/engine';
import { emptyFeatures, idleFeatures, type AudioFeatures } from '../audio/features';
import { PcmAnalyser } from '../audio/pcm';
import { artworkUrl, isDesktop, streamSystemAudio, watchNowPlaying, watchOverlay, type NowPlaying } from '../desktop/bridge';
import type { Scene } from '../gl/renderer';
import { Stage } from '../stage';
import { isOverlayMode, OVERLAY_MODES, type OverlayMode } from './modes';
import { createOverlayScenes, OVERLAY_BLOOM } from './scenes';

// The desktop overlay: a transparent, click-through layer above every window (src-tauri sets
// that up). Same audio and palette as the main window, but only the edge styles in ./scenes.

const TRANSITION = 0.8;
/** After this long without sound the overlay fades away, and stops drawing once it's gone. */
const QUIET_AFTER = 5;

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

  constructor(canvas: HTMLCanvasElement) {
    this.stage = new Stage(canvas, true);
    for (const s of Object.values(this.scenes)) s.init(this.stage.renderer);
    const asked = new URLSearchParams(location.search).get('mode');
    this.mode = isOverlayMode(asked) ? asked : 'halo';
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    if (isDesktop) this.start();
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
    let first = true;
    await watchOverlay((m) => {
      if (!isOverlayMode(m)) return;
      if (first) {
        // The style the overlay was opened with: no cross-fade from the default.
        first = false;
        this.mode = m;
      } else if (m !== this.mode) {
        this.prev = this.mode;
        this.mode = m;
        this.switchedAt = performance.now() / 1000;
      }
    });
  }

  /**
   * Opened in a plain browser (development): play the demo synth over a stand-in desktop,
   * and let 1–7 switch styles.
   */
  private preview() {
    document.body.style.background = 'linear-gradient(135deg, #1d2129, #2a2f3a)';
    const start = () => this.engine.useDemo().catch(() => {});
    start();
    window.addEventListener('pointerdown', start, { once: true });
    window.addEventListener('keydown', (e) => {
      const m = OVERLAY_MODES[Number(e.key) - 1];
      if (m && m !== this.mode) {
        this.prev = this.mode;
        this.mode = m;
        this.switchedAt = performance.now() / 1000;
      }
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

    const want = now - this.lastSound < QUIET_AFTER ? 1 : 0;
    this.fade += (want - this.fade) * (1 - Math.exp(-dt / (want ? 0.4 : 1.2)));
    if (this.fade < 0.003 && !want) {
      // Nothing to show: clear once and let the GPU rest until the music comes back.
      if (!this.blank) {
        const gl = this.stage.renderer.gl;
        this.stage.renderer.bindTarget(null);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.blank = true;
      }
      return;
    }
    this.blank = false;

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
