import type { AudioFeatures } from './audio/features';
import { generateCover, loadImage, paletteFromImage } from './color/cover';
import { BRAND_PALETTE, lerpPalette, paletteFromHue, paletteToLinearRgb, type Palette } from './color/palette';
import { Renderer, type FrameState, type Scene } from './gl/renderer';

/**
 * What every window that draws the visualizer shares: the renderer, the palette that follows
 * the artwork, and the smoothed signals scenes use to move calmly. The web app and the
 * desktop overlay each own one and decide themselves which scenes to draw.
 */
export class Stage {
  readonly renderer: Renderer;
  palette: Palette = BRAND_PALETTE;
  targetPalette: Palette = BRAND_PALETTE;
  /** Called with the new palette whenever the artwork changes. */
  onPalette: ((p: Palette) => void) | null = null;

  private paletteMode: 'cover' | 'audio' = 'cover';
  private paletteTau = 0.8;
  private hue = 2.2;
  private brightness = 0.35;
  private coverTex: WebGLTexture;
  private coverPrevTex: WebGLTexture;
  private coverMix = 1;
  private coverToken = 0;

  private flow = 0;
  private drift = 0;
  private slowBass = 0;
  private slowEnergy = 0;
  private medBands: [number, number, number] = [0, 0, 0];

  constructor(
    canvas: HTMLCanvasElement,
    private readonly transparent = false,
  ) {
    this.renderer = new Renderer(canvas);
    this.coverTex = this.renderer.createImageTexture();
    this.coverPrevTex = this.renderer.createImageTexture();
    this.renderer.uploadImage(this.coverTex, generateCover(BRAND_PALETTE));
  }

  /** Paint with an artwork, or with a generated cover (and a hue that drifts with the music) when there is none. */
  async setCover(src: string | null, fallbackSeed = 1) {
    const token = ++this.coverToken;
    let image: CanvasImageSource;
    if (src) {
      try {
        const img = await loadImage(src);
        if (token !== this.coverToken) return;
        const { palette, brightness } = paletteFromImage(img);
        this.paletteMode = 'cover';
        this.targetPalette = palette;
        this.paletteTau = 0.8;
        this.brightness = brightness;
        image = img;
      } catch {
        image = this.generated(fallbackSeed);
      }
    } else {
      image = this.generated(fallbackSeed);
    }
    if (token !== this.coverToken) return;
    // Keep what's on screen as "prev" and fade in the new one.
    [this.coverPrevTex, this.coverTex] = [this.coverTex, this.coverPrevTex];
    this.renderer.uploadImage(this.coverTex, image as TexImageSource);
    this.coverMix = 0;
    this.onPalette?.(this.targetPalette);
  }

  private generated(seed: number) {
    this.paletteMode = 'audio';
    const p = paletteFromHue(this.hue);
    this.targetPalette = p;
    return generateCover(p, seed);
  }

  /** Advance the smoothed state by one frame and describe it for the scenes. */
  step(f: AudioFeatures, now: number, dt: number, title: string, quality: number): FrameState {
    this.flow += dt * (0.35 + f.energy * 1.7 + f.beat * 0.35);
    // Slow averages for scenes that should move calmly and only "breathe" with the music.
    const k = 1 - Math.exp(-dt / 1.5);
    this.slowBass += (f.bass - this.slowBass) * k;
    this.slowEnergy += (f.energy - this.slowEnergy) * k;
    this.drift += dt * (0.4 + this.slowEnergy * 1.3);
    const km = 1 - Math.exp(-dt / 0.4);
    this.medBands[0] += (f.bass - this.medBands[0]) * km;
    this.medBands[1] += ((f.lowMid + f.mid) / 2 - this.medBands[1]) * km;
    this.medBands[2] += (f.high - this.medBands[2]) * km;

    if (this.paletteMode === 'audio') {
      this.hue += dt * (0.02 + f.energy * 0.05) + (f.centroid - 0.5) * dt * 0.08;
      if (f.onBeat && f.beatCount % 16 === 0) this.hue += 0.6;
      this.targetPalette = paletteFromHue(this.hue);
      this.paletteTau = 1.2;
    }
    this.palette = lerpPalette(this.palette, this.targetPalette, 1 - Math.exp(-dt / this.paletteTau));
    this.coverMix = Math.min(1, this.coverMix + dt / 1.2);

    return {
      time: now,
      dt,
      flow: this.flow,
      drift: this.drift,
      slowBass: this.slowBass,
      slowEnergy: this.slowEnergy,
      medBands: this.medBands,
      features: f,
      palette: paletteToLinearRgb(this.palette),
      brightness: this.brightness,
      cover: { tex: this.coverTex, prev: this.coverPrevTex, mix: this.coverMix, has: true },
      title,
      quality,
      transparent: this.transparent,
    };
  }

  /**
   * Draw `scene` and composite it onto the canvas. While `prev` is given, it's drawn too and
   * cross-faded in with weight `mix` (1 = only prev). `fade` dims the whole picture (overlay).
   */
  draw(frame: FrameState, scene: Scene, bloom: number, prev: { scene: Scene; mix: number; bloom: number } | null = null, fade = 1) {
    const r = this.renderer;
    r.uploadAudio(frame.features);
    const a = r.target(`scene:${scene.id}`, r.width * scene.scale, r.height * scene.scale);
    scene.render(r, frame, a);
    let b = null;
    if (prev) {
      b = r.target(`scene:${prev.scene.id}`, r.width * prev.scene.scale, r.height * prev.scene.scale);
      prev.scene.render(r, frame, b);
    }
    const mix = prev ? prev.mix : 0;
    const straight = (scene.straightAlpha ? 1 : 0) * (1 - mix) + (prev?.scene.straightAlpha ? mix : 0);
    r.composite(a, b, mix, frame, { bloom: bloom * (1 - mix) + (prev ? prev.bloom * mix : 0), fade, straight });
  }
}
