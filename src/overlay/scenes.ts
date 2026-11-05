import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';
import { hexToLinearRgb } from '../color/oklab';
import { ATLAS_COLS, ATLAS_ROWS, createGlyphAtlas } from '../scenes/ascii';
import { KaleidoScene } from '../scenes/kaleido';
import { EDGES, optionOf, SPOTS, type OverlayMode, type OverlayOptions } from './modes';

// Overlay styles, drawn over the desktop. Most are "straight": they output the artwork's color
// as it is plus an opacity, so dark covers stay dark. Embers and Orbit are light instead: drawn
// on black, which the compositor turns transparent as much as it doesn't shine.

const COLOR = /* glsl */ `
// Light styles: palette colors pushed up to a visible brightness.
vec3 vivid(vec3 c) {
  float m = max(c.r, max(c.g, c.b));
  return c / max(m, 1e-4) * max(m, 0.75);
}
// Straight styles: the artwork's color as it is, only lifted off pure black so it can be seen.
vec3 trueish(vec3 c) {
  float m = max(c.r, max(c.g, c.b));
  return c / max(m, 1e-4) * max(m, 0.05);
}
// The darker and the brighter of the cover's two main colors. The palette's primary is its
// most colorful one, which on a dark cover can be a light tint; the overlays lean on the
// darker one, which usually reads as "the color of the album".
vec3 deepColor() { return luma(PRIMARY) <= luma(SECONDARY) ? PRIMARY : SECONDARY; }
vec3 brightColor() { return luma(PRIMARY) <= luma(SECONDARY) ? SECONDARY : PRIMARY; }`;

/** `level(u)`: band levels (see BandLevels), u from 0 (bass) to 1 (highs). */
const levelsGlsl = (n: number) => /* glsl */ `
uniform float uLevels[${n}];
float level(float u) {
  float x = clamp(u, 0.0, 1.0) * ${n - 1}.0;
  int i = int(x);
  return mix(uLevels[i], uLevels[min(i + 1, ${n - 1})], smoothstep(0.0, 1.0, fract(x)));
}`;

/** What the overlay page tells every style before drawing it. */
export interface OverlayContext {
  options: OverlayOptions;
  /** 0 in silence, 1 with music, eased in between. */
  music: number;
}

/**
 * The log spectrum folded into `n` bands that move with the music. The spectrum is in dB, so a
 * band rarely leaves 0.5–0.7; each band is stretched over its own recent range instead (the
 * floor follows quiet moments, the ceiling loud ones), then smoothed: fast up, slower down.
 */
class BandLevels {
  readonly values: Float32Array;
  private floor: Float32Array;
  private ceil: Float32Array;
  constructor(
    readonly n: number,
    private lo = 0.02,
    private hi = 0.85,
  ) {
    this.values = new Float32Array(n);
    this.floor = new Float32Array(n).fill(0.4);
    this.ceil = new Float32Array(n).fill(0.6);
  }
  update(frame: FrameState) {
    const s = frame.features.spectrum;
    const k = (tau: number) => 1 - Math.exp(-frame.dt / tau);
    const [attack, release, fast, slow] = [k(0.04), k(0.2), k(0.1), k(2.5)];
    for (let i = 0; i < this.n; i++) {
      const u = this.lo + ((this.hi - this.lo) * i) / (this.n - 1);
      const x = u * (s.length - 1);
      const a = Math.floor(x);
      const raw = Math.max(s[a], s[Math.min(s.length - 1, a + 1)]);
      this.floor[i] += (raw - this.floor[i]) * (raw < this.floor[i] ? fast : slow);
      this.ceil[i] += (raw - this.ceil[i]) * (raw > this.ceil[i] ? fast : slow);
      const stretched = Math.min(1, Math.max(0, (raw - this.floor[i]) / Math.max(this.ceil[i] - this.floor[i], 0.12)));
      const target = raw * 0.2 + stretched * 0.8;
      const v = this.values[i];
      this.values[i] = v + (target - v) * (target > v ? attack : release);
    }
    return this.values;
  }
}

/**
 * Recent beats as (age in seconds, strength) pairs, newest first, for effects that travel
 * after a kick. Several can run at once, so a quick second kick adds a wave instead of
 * restarting the first one.
 */
class Pulses {
  private list: { t: number; s: number }[] = [];
  readonly data: Float32Array;
  constructor(
    private max: number,
    private life: number,
  ) {
    this.data = new Float32Array(max * 2);
  }
  update(frame: FrameState) {
    const f = frame.features;
    if (f.onBeat) this.list.unshift({ t: frame.time, s: 0.45 + f.bass * 0.7 });
    this.list = this.list.filter((p) => frame.time - p.t < this.life).slice(0, this.max);
    for (let i = 0; i < this.max; i++) {
      const p = this.list[i];
      this.data[i * 2] = p ? frame.time - p.t : 99;
      this.data[i * 2 + 1] = p ? p.s : 0;
    }
    return this.data;
  }
}

abstract class OverlayScene implements Scene {
  abstract readonly id: OverlayMode;
  abstract readonly scale: number;
  readonly straightAlpha: boolean = true;
  ctx: OverlayContext = { options: {}, music: 0 };
  protected prog!: Program;
  protected abstract readonly fs: string;

  init(r: Renderer) {
    this.prog = r.sceneProgram(COLOR + this.fs);
  }

  protected opt(key: string) {
    return optionOf(this.ctx.options, this.id, key);
  }

  /** 0 = bottom, 1 = top, 2 = both. */
  protected edge() {
    return Math.max(0, EDGES.indexOf(this.opt('position') as (typeof EDGES)[number]));
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    r.bindTarget(target);
    this.draw(r, frame, target, r.common(this.prog.use(), frame, target.w, target.h));
  }

  protected draw(r: Renderer, _frame: FrameState, _target: Target, _p: Program) {
    r.drawFullscreen();
  }
}

/** Halo: the screen's frame glows, the spectrum laid around it (bass at the bottom, highs at the top). */
class HaloOverlay extends OverlayScene {
  readonly id = 'halo';
  readonly scale = 0.5;
  private bands = new BandLevels(24);
  private pulses = new Pulses(4, 2.5);
  protected readonly fs = /* glsl */ `
${levelsGlsl(24)}
uniform vec2 uPulses[4];  // age (s), strength
uniform float uTint;      // 0 the cover's colors, 1 white, 2 black
uniform float uIntensity; // how far the glow reaches into the screen

// Color in rgb, opacity in a.
vec4 edge(float d, float u) {
  float lv = level(u);
  float thick = (0.006 + lv * 0.02 + uMedBands.x * 0.01) * uIntensity;
  float glow = exp(-d / thick) * (0.3 + lv * 0.8) + exp(-d * 400.0) * (0.25 + lv * 0.5);
  // Each kick sends a flash from the bottom up both sides; they overlap instead of restarting.
  float pulse = 0.0;
  for (int i = 0; i < 4; i++) {
    float age = uPulses[i].x;
    pulse += uPulses[i].y * exp(-pow((u - age * 1.1) * 7.0, 2.0)) * exp(-age * 1.4);
  }
  glow *= 1.0 + min(pulse, 2.0) * 1.5;
  // The cover's deep color, with its brighter one drifting through and a hint of the accent on top.
  vec3 c = mix(deepColor(), brightColor(), 0.2 + 0.2 * sin(u * TAU * 1.5 - uDrift * 0.5));
  c = trueish(mix(c, ACCENT, smoothstep(0.6, 1.0, u) * 0.2));
  if (uTint > 1.5) c = vec3(0.0);
  else if (uTint > 0.5) c = vec3(1.0);
  return vec4(c, clamp(glow * (0.75 + uIntensity * 0.15), 0.0, 0.95));
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float W = uRes.x, H = uRes.y;
  float around = W + H; // half the perimeter: bottom center → top center
  float ax = abs(px.x - 0.5 * W);
  vec4 a = edge(px.y / H, ax / around);
  vec4 b = edge((H - px.y) / H, (W + H - ax) / around);
  vec4 c = edge(min(px.x, W - px.x) / H, (0.5 * W + px.y) / around);
  // Where two edges meet, the stronger one wins.
  vec4 best = a.a >= b.a ? a : b;
  fragColor = best.a >= c.a ? best : c;
}`;
  protected draw(r: Renderer, frame: FrameState, _t: Target, p: Program) {
    r.gl.uniform1fv(p.loc('uLevels[0]'), this.bands.update(frame));
    r.gl.uniform2fv(p.loc('uPulses[0]'), this.pulses.update(frame));
    p.f('uTint', ['cover', 'white', 'black'].indexOf(this.opt('color') as string)).f('uIntensity', this.opt('intensity') as number);
    r.drawFullscreen();
  }
}

/** Horizon: mirrored spectrum bars along the bottom and/or top edge, bass in the middle, with falling peaks. */
class HorizonOverlay extends OverlayScene {
  readonly id = 'horizon';
  readonly scale = 1;
  // From ~45 Hz: below that there's little but rumble, and the middle bars would sit still.
  private bands = new BandLevels(36, 0.07);
  private peaks = new Float32Array(36);
  protected readonly fs = /* glsl */ `
uniform float uLevels[36];
uniform float uPeaks[36];
uniform float uEdge;   // 0 bottom, 1 top, 2 both
uniform float uMaxH;   // tallest bar, as a fraction of the screen height

// Color in rgb, opacity in a. Bars thin out as they rise, so tall ones don't hide much.
vec4 bars(float y, float xm) {
  float cell = xm * 36.0;
  int i = int(min(floor(cell), 35.0));
  float fx = fract(cell);
  float lv = uLevels[i];
  float h = 0.004 + lv * uMaxH;
  float gap = smoothstep(0.1, 0.2, fx) * smoothstep(0.9, 0.8, fx);
  float rise = smoothstep(0.0, uMaxH, y);
  vec3 c = trueish(mix(deepColor(), brightColor(), rise * 0.6));
  float a = step(y, h) * gap * mix(0.9, 0.3, rise);
  float pk = 0.004 + uPeaks[i] * uMaxH + 0.005;
  float cap = gap * smoothstep(2.5, 0.5, abs(y - pk) * uRes.y);
  c = mix(c, trueish(brightColor()), cap);
  a = max(a, cap * mix(0.9, 0.45, rise));
  // A thin line along the edge.
  a = max(a, exp(-y * uRes.y / 2.5) * (0.4 + uMedBands.x * 0.5));
  return vec4(c, a);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float xm = abs(uv.x - 0.5) * 2.0;
  vec4 col = vec4(0.0);
  if (uEdge != 1.0) col = bars(uv.y, xm);
  if (uEdge != 0.0) {
    vec4 top = bars(1.0 - uv.y, xm);
    if (top.a > col.a) col = top;
  }
  fragColor = col;
}`;
  protected draw(r: Renderer, frame: FrameState, _t: Target, p: Program) {
    const lv = this.bands.update(frame);
    for (let i = 0; i < lv.length; i++) this.peaks[i] = Math.max(lv[i], this.peaks[i] - frame.dt * 0.35);
    r.gl.uniform1fv(p.loc('uLevels[0]'), lv);
    r.gl.uniform1fv(p.loc('uPeaks[0]'), this.peaks);
    p.f('uEdge', this.edge()).f('uMaxH', this.opt('height') as number);
    r.drawFullscreen();
  }
}

/**
 * Orbit: a bubble (the kaleidoscope, or the artwork turning like a record) ringed by the
 * spectrum and by waves that ride on it. It fades away while the mouse is on it.
 */
export class OrbitOverlay extends OverlayScene {
  readonly id = 'orbit';
  readonly scale = 1;
  private bands = new BandLevels(40);
  private pulses = new Pulses(3, 1.5);
  private inner = new KaleidoScene();
  private peekUntil = 0;
  private opacity = 1;
  private spin = 0;
  protected readonly fs = /* glsl */ `
${levelsGlsl(40)}
uniform sampler2D uInner;
uniform sampler2D uCover;
uniform sampler2D uCoverPrev;
uniform float uCoverMix;
uniform float uShowCover;
uniform float uSpin;
uniform vec3 uCircle;     // center and radius, in pixels
uniform vec2 uPulses[3];  // age (s), strength
uniform float uOpacity;

// Layer a color with opacity a over what's there (straight alpha).
vec4 over(vec4 d, vec3 c, float a) {
  a = clamp(a, 0.0, 1.0);
  float oa = a + d.a * (1.0 - a);
  return vec4(oa > 0.0 ? (c * a + d.rgb * d.a * (1.0 - a)) / oa : vec3(0.0), oa);
}

void main() {
  vec2 p = gl_FragCoord.xy - uCircle.xy;
  float R = uCircle.z;
  float r = length(p);
  float a = atan(p.y, p.x);
  vec4 col = vec4(0.0);
  // Bars of the spectrum, bass at the bottom, mirrored left and right.
  float u = abs(fract((a + PI * 0.5 + sin(uDrift * 0.1) * 0.3) / TAU) * 2.0 - 1.0);
  float cell = u * 40.0;
  float fx = fract(cell);
  float lv = level((floor(cell) + 0.5) / 40.0);
  float gap = smoothstep(0.12, 0.3, fx) * smoothstep(0.88, 0.7, fx);
  float r0 = R * 1.06;
  float len = 0.04 * R + lv * R * 0.75;
  float bar = gap * smoothstep(r0 - 1.0, r0, r) * smoothstep(r0 + len + 1.0, r0 + len, r);
  float rise = smoothstep(0.0, R * 0.8, r - r0);
  col = over(col, trueish(mix(deepColor(), brightColor(), rise * 0.7)), bar * mix(0.9, 0.45, rise));
  // Two waves circling over the bar tips, swelling with the bands under them.
  float lvs = level(u);
  float kick = 0.0;
  for (int i = 0; i < 3; i++) {
    float age = uPulses[i].x;
    kick += uPulses[i].y * exp(-abs(r - R * (1.0 + age * 1.1)) / (R * 0.025)) * exp(-age * 2.5);
  }
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    float rw = r0 + R * (0.3 + fk * 0.12) + sin(a * (5.0 + fk * 2.0) + uFlow * (1.5 - fk * 2.6) + fk) * R * (0.03 + lvs * 0.12 + kick * 0.05);
    float line = exp(-abs(r - rw) / (1.2 + lvs * 1.5));
    col = over(col, trueish(mix(brightColor(), ACCENT, fk * 0.4)), line * (0.6 + lvs * 0.4));
  }
  // Kicks: a rim flash and rings that spread out from the bubble.
  col = over(col, trueish(HIGHLIGHT), exp(-abs(r - R) / 1.4) * 0.7 + kick * 0.5);
  // Inside, solid: the kaleidoscope, or the artwork turning like a record (a kick nudges it).
  float inside = smoothstep(R + 0.75, R - 0.75, r);
  if (inside > 0.0) {
    vec3 c;
    if (uShowCover > 0.5) {
      vec2 q = rot(uSpin) * (p / R) * (0.5 - uBeat * 0.015) + 0.5;
      c = mix(texture(uCoverPrev, q).rgb, texture(uCover, q).rgb, uCoverMix);
    } else {
      // The kaleidoscope is HDR; roll its highlights off the way the full-screen view does.
      c = 1.0 - exp(-texture(uInner, p / (2.0 * R) + 0.5).rgb * 1.3);
    }
    col = over(col, c, inside);
  }
  fragColor = vec4(col.rgb, col.a * uOpacity);
}`;

  init(r: Renderer) {
    super.init(r);
    this.inner.init(r);
  }

  /** Center (from the bottom-left, like gl_FragCoord) and radius of the bubble on a w × h surface. */
  bubble(w: number, h: number) {
    const R = Math.round(h * (this.opt('size') as number));
    const margin = h * 0.04 + R * 0.85;
    const spot = Math.max(0, SPOTS.indexOf(this.opt('position') as (typeof SPOTS)[number]));
    const col = spot % 3;
    const row = Math.floor(spot / 3);
    const x = col === 0 ? margin + R : col === 1 ? w / 2 : w - margin - R;
    const y = row === 0 ? h - margin - R : row === 1 ? h / 2 : margin + R;
    return { x, y, R };
  }

  /** The mouse is on the bubble: fade out for a moment so what's underneath shows. */
  peek(now: number, seconds: number) {
    this.peekUntil = now + seconds;
  }

  get peeking() {
    return performance.now() / 1000 < this.peekUntil;
  }

  protected draw(r: Renderer, frame: FrameState, target: Target, p: Program) {
    const want = performance.now() / 1000 < this.peekUntil ? 0.06 : 1;
    this.opacity += (want - this.opacity) * (1 - Math.exp(-frame.dt / 0.18));
    this.spin += frame.dt * (0.12 + frame.slowEnergy * 0.35);
    const { x, y, R } = this.bubble(target.w, target.h);
    const cover = this.opt('inside') === 'cover';
    const inner = r.target('orbit-inner', R * 2, R * 2);
    // Skip the kaleidoscope while it isn't shown.
    if (!cover && this.opacity > 0.02) this.inner.render(r, frame, inner);
    // The inner scene bound its own target and program; come back to ours.
    r.bindTarget(target);
    r.common(this.prog.use(), frame, target.w, target.h)
      .tex('uInner', 1, inner.tex)
      .tex('uCover', 2, frame.cover.tex)
      .tex('uCoverPrev', 3, frame.cover.prev)
      .f('uCoverMix', frame.cover.mix)
      .f('uShowCover', cover ? 1 : 0)
      .f('uSpin', this.spin)
      .f('uCircle', x, y, R)
      .f('uOpacity', this.opacity);
    r.gl.uniform1fv(p.loc('uLevels[0]'), this.bands.update(frame));
    r.gl.uniform2fv(p.loc('uPulses[0]'), this.pulses.update(frame));
    r.drawFullscreen();
  }
}

/** Curtain: the aurora hanging from the top of the screen, brightest at its lower hem. */
class CurtainOverlay extends OverlayScene {
  readonly id = 'curtain';
  readonly scale = 0.5;
  private waves: { t: number; x: number; dir: number; s: number }[] = [];
  private data = new Float32Array(3 * 4);
  private sway = 0;
  protected readonly fs = /* glsl */ `
uniform float uHeight;  // average depth of the hem, as a fraction of the screen height
uniform float uSway;    // a clock that runs faster with the energy of the song
uniform vec4 uWaves[3]; // light running along the curtain: start x, age (s), direction, strength
// Wanders deep → bright → deep, with a touch of the accent at the bright end.
vec3 paletteCycle(float h) {
  float w = 0.5 - 0.5 * cos(fract(h) * TAU);
  return mix(deepColor(), mix(brightColor(), ACCENT, 0.25), w * 0.8);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  float x = uv.x * aspect;
  float t = 1.0 - uv.y; // 0 at the top edge
  float d = uSway;
  vec3 m = uMedBands;
  // Bands of light that run along the curtain after kicks.
  float run = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 w = uWaves[i];
    if (w.y < 0.0) continue;
    float front = w.x + w.z * w.y * 0.45 * aspect;
    run += w.w * exp(-pow((x - front) * 2.5, 2.0)) * exp(-w.y * 0.9);
  }
  vec4 col = vec4(0.0);
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    // Folds that keep travelling sideways, faster when the song pushes.
    float xx = x + 0.06 * sin(x * (3.0 + fk) + d * (1.6 + fk * 0.7) + fk * 2.0) * (1.0 + m.y * 2.0)
                 + 0.025 * sin(x * 9.0 - d * 2.3 + fk * 4.0) * (0.5 + m.z);
    // The hem sways, and the bass lets it hang lower.
    float hem = uHeight * (0.5 + fbm(vec2(xx * 0.9 + fk * 7.0, d * 0.35), 3) + m.x * 0.6 + fk * 0.3 + run * 0.25);
    float above = hem - t;
    float body = smoothstep(-0.006, 0.004, above) * exp(-max(above, 0.0) * (1.2 - m.x * 0.4) / uHeight);
    float rays = 0.45 + 0.55 * tnoise(vec2(xx * 160.0 + d * 1.5, d * 2.0 + fk * 20.0));
    rays *= 0.7 + 0.3 * tnoise(vec2(xx * 420.0 - uTime * (0.4 + m.z * 2.0), fk * 9.0));
    float gaps = smoothstep(0.2, 0.5, fbm(vec2(xx * 0.6 + d * 0.15 + fk * 11.0, fk * 3.0), 3));
    float k2 = body * rays * gaps * (0.85 - fk * 0.25) * (0.75 + m.x * 0.5 + uSlowEnergy * 0.4 + run * 0.9);
    vec3 c = trueish(paletteCycle(fbm(vec2(xx * 0.4, fk * 5.0), 2) * 1.5 + d * 0.12 + fk * 0.35));
    if (k2 > col.a) col = vec4(c, k2);
  }
  // Leave the very top (where the bar lives) almost clear.
  col.a = clamp(col.a * smoothstep(0.0, 0.035, t) * 1.2, 0.0, 0.92);
  fragColor = col;
}`;
  protected draw(r: Renderer, frame: FrameState, target: Target, p: Program) {
    const f = frame.features;
    this.sway += frame.dt * (0.06 + frame.slowEnergy * 0.16);
    if (f.onBeat) this.waves.unshift({ t: frame.time, x: Math.random() * (target.w / target.h), dir: Math.random() < 0.5 ? -1 : 1, s: 0.4 + f.bass * 0.8 });
    this.waves = this.waves.filter((w) => frame.time - w.t < 3).slice(0, 3);
    this.data.fill(-1);
    this.waves.forEach((w, i) => this.data.set([w.x, frame.time - w.t, w.dir, w.s], i * 4));
    r.gl.uniform4fv(p.loc('uWaves[0]'), this.data);
    p.f('uHeight', this.opt('height') as number).f('uSway', this.sway);
    r.drawFullscreen();
  }
}

/** Embers: sparks rise from the bottom edge, as many as the song is busy; big kicks burst. */
class EmbersOverlay extends OverlayScene {
  readonly id = 'embers';
  readonly scale = 0.75;
  readonly straightAlpha = false;
  private bursts: { x: number; t: number; s: number; seed: number }[] = [];
  private data = new Float32Array(5 * 4);
  protected readonly fs = /* glsl */ `
uniform vec4 uBursts[5]; // x (screen heights), age (s, < 0 = none), strength, seed
const float BURST_LIFE = 1.8;

vec3 ember(vec2 uv, float column, float cell, float fl, float density) {
  float h = hash21(vec2(column, fl * 13.1));
  float clock = uFlow * (0.05 + h * 0.06 + fl * 0.02) + h * 7.3;
  float life = fract(clock);
  float alive = step(hash21(vec2(column, floor(clock) + fl * 31.0)), density);
  float y = life * (0.3 + h * 0.3);
  float x = (column + 0.5 + 0.35 * sin(life * 6.0 + h * 20.0)) * cell;
  float r = (0.005 + h * 0.004) * (1.0 - life * 0.5);
  float d2 = dot(uv - vec2(x, y), uv - vec2(x, y));
  float b = exp(-d2 / (r * r)) * alive * (1.0 - life) * (0.6 + 0.9 * uBeat);
  float flicker = 0.7 + 0.3 * sin(uTime * (8.0 + h * 10.0) + h * 40.0);
  vec3 c = mix(vivid(ACCENT), vivid(PRIMARY), h);
  return mix(c, vivid(HIGHLIGHT), exp(-d2 / (r * r * 0.15)) * 0.6) * b * flicker * 2.6;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes.y;
  // Busy, loud songs fill the screen with sparks; quiet ones leave a few.
  float density = clamp(0.03 + uSlowEnergy * 0.6 + uMedBands.x * 0.35, 0.0, 0.9);
  vec3 col = vec3(0.0);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float cell = 0.045 - fl * 0.01;
    float home = floor(uv.x / cell);
    // Neighbours too: a spark that sways past its column's edge must not be cut off.
    for (int dc = -1; dc <= 1; dc++) col += ember(uv, home + float(dc), cell, fl, density);
  }
  // Big kicks: a fan of sparks thrown up from the bottom, falling back.
  for (int b = 0; b < 5; b++) {
    vec4 B = uBursts[b];
    float age = B.y;
    if (age < 0.0 || age > BURST_LIFE || abs(uv.x - B.x) > 0.9 * age + 0.05) continue;
    float fade = 1.0 - age / BURST_LIFE;
    for (int k = 0; k < 18; k++) {
      float fk = float(k);
      float h1 = hash21(vec2(B.w, fk));
      float h2 = hash21(vec2(fk + 0.5, B.w + 3.1));
      float ang = mix(0.35, 2.79, h1);
      vec2 v = vec2(cos(ang), sin(ang)) * (0.25 + h2 * 0.5) * (0.6 + B.z);
      vec2 p = vec2(B.x, 0.0) + v * age - vec2(0.0, 0.3) * age * age;
      float r = 0.0045 * (1.0 - age / BURST_LIFE * 0.6);
      float d2 = dot(uv - p, uv - p);
      col += mix(vivid(ACCENT), vivid(HIGHLIGHT), h1) * exp(-d2 / (r * r)) * fade * fade * 2.2 * (0.6 + B.z);
    }
  }
  // The glowing bed they rise from.
  col += vivid(mix(PRIMARY, ACCENT, 0.5)) * exp(-uv.y * 30.0) * (0.06 + uMedBands.x * 0.45 + uBeat * 0.2);
  fragColor = vec4(col, 0.0);
}`;
  protected draw(r: Renderer, frame: FrameState, target: Target, p: Program) {
    const f = frame.features;
    const aspect = target.w / target.h;
    // A burst on strong kicks; two at once when the song is really going.
    if (f.onBeat && f.bass > 0.5) {
      const n = frame.slowEnergy > 0.6 ? 2 : 1;
      for (let i = 0; i < n; i++) this.bursts.unshift({ x: (0.08 + Math.random() * 0.84) * aspect, t: frame.time, s: f.bass, seed: Math.random() * 100 });
    }
    this.bursts = this.bursts.filter((b) => frame.time - b.t < 1.8).slice(0, 5);
    this.data.fill(-1);
    this.bursts.forEach((b, i) => this.data.set([b.x, frame.time - b.t, b.s, b.seed], i * 4));
    r.gl.uniform4fv(p.loc('uBursts[0]'), this.data);
    r.drawFullscreen();
  }
}

/** rOS rain: falling glyphs down both sides. Glitchy lime in silence; the cover's colors, and the song's pace, with music. */
class RainOverlay extends OverlayScene {
  readonly id = 'rain';
  readonly scale = 1;
  // Kept exactly as Rossmel liked it: a light style, with bloom.
  readonly straightAlpha = false;
  private atlas!: WebGLTexture;
  private brand = hexToLinearRgb('#afff00');
  protected readonly fs = /* glsl */ `
uniform sampler2D uGlyphs;
uniform vec2 uCell;
uniform vec3 uBrand;
uniform float uMusic;
float glyph(float code, vec2 cuv) {
  float idx = clamp(code, 32.0, 126.0) - 32.0;
  vec2 g = vec2(mod(idx, ${ATLAS_COLS}.0), floor(idx / ${ATLAS_COLS}.0));
  return texture(uGlyphs, (g + vec2(cuv.x, 1.0 - cuv.y)) / vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0)).r;
}
void main() {
  vec2 cell = floor(gl_FragCoord.xy / uCell);
  vec2 cuv = fract(gl_FragCoord.xy / uCell);
  vec2 grid = floor(uRes / uCell);
  float side = min((cell.x + 0.5) / grid.x, 1.0 - (cell.x + 0.5) / grid.x);
  float mask = smoothstep(0.16, 0.02, side);
  if (mask <= 0.0) { fragColor = vec4(0.0); return; }
  float music = uMusic;
  float h = hash21(vec2(cell.x, 3.7));
  float clock = uFlow * (0.08 + h * 0.12) + h * 9.1;
  float head = 1.0 - fract(clock);           // falls from the top
  // With music, how many columns rain follows how busy the song is.
  float density = mix(0.75, 0.2 + uSlowEnergy * 0.7 + uMedBands.x * 0.15, music);
  float on = step(hash21(vec2(cell.x, floor(clock))), density);
  float dist = fract((cell.y + 0.5) / grid.y - head);  // how far above the head
  float trail = 0.12 + h * 0.2 + uMedBands.x * 0.25 * music;
  float k = dist < trail ? pow(1.0 - dist / trail, 1.6) : 0.0;
  float rate = 2.0 + h * 5.0 + uMedBands.z * 8.0;
  float code = 33.0 + floor(hash21(cell + floor(uTime * rate) * 0.37) * 93.0);
  bool isHead = dist * grid.y < 1.0;
  vec3 lime = isHead ? mix(uBrand, vec3(1.0), 0.6) : mix(uBrand, vivid(PRIMARY), 0.35 * music);
  vec3 cover = isHead ? vivid(HIGHLIGHT) : vivid(mix(PRIMARY, ACCENT, h));
  vec3 ink = mix(lime, cover, music);
  float gain = (1.1 + uMedBands.y * music) * (1.0 + uBeat * 0.8 * music);
  fragColor = vec4(ink * glyph(code, cuv) * k * on * mask * gain, 0.0);
}`;
  init(r: Renderer) {
    super.init(r);
    this.atlas = createGlyphAtlas(r);
  }
  protected draw(r: Renderer, _f: FrameState, _t: Target, p: Program) {
    const cellH = Math.round(18 * r.pixelRatio);
    p.tex('uGlyphs', 1, this.atlas)
      .f('uCell', Math.round(cellH * 0.6), cellH)
      .f('uBrand', this.brand[0], this.brand[1], this.brand[2])
      .f('uMusic', this.ctx.music);
    r.drawFullscreen();
  }
}

/** Wave: ribbons of light along the bottom and/or top, swelling with the spectrum; each kick sends ripples out from the middle. */
class WaveOverlay extends OverlayScene {
  readonly id = 'wave';
  readonly scale = 0.75;
  private bands = new BandLevels(32, 0.07);
  private pulses = new Pulses(3, 2);
  protected readonly fs = /* glsl */ `
${levelsGlsl(32)}
uniform vec2 uPulses[3]; // age (s), strength
uniform float uEdge;     // 0 bottom, 1 top, 2 both
uniform float uBase;     // distance of the ribbon from the edge, as a fraction of the height

// Color in rgb, opacity in a.
vec4 ribbon(float py, vec2 uv) {
  float xm = abs(uv.x - 0.5) * 2.0;
  // Blurred across neighbouring bands, so the ribbon bends instead of kinking.
  float lv = 0.0;
  for (int i = -3; i <= 3; i++) lv += level(xm + float(i) * 0.025);
  lv /= 7.0;
  float ripple = 0.0;
  for (int i = 0; i < 3; i++) {
    float age = uPulses[i].x;
    ripple += uPulses[i].y * exp(-pow((xm - age * 1.1) * 6.0, 2.0)) * exp(-age * 2.0);
  }
  float H = uRes.y;
  vec4 col = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    float amp = (0.01 + lv * 0.12 + ripple * 0.07 + uBeat * 0.02) * H * (1.0 - fk * 0.18) * (0.5 + uBase * 5.0);
    float phase = uv.x * (6.0 + fk * 2.3 + uMedBands.y * 3.0) - uFlow * (1.1 + fk * 0.35) + fk * 1.7;
    float y = uBase * H + sin(phase) * amp * (0.6 + 0.4 * sin(uv.x * 3.0 + uDrift * 0.3 + fk));
    float dy = abs(py - y);
    float w = (1.2 + lv * 1.5 + ripple) * H / 1000.0;
    float a = (exp(-dy / w) + 0.15 * exp(-dy / (w * 10.0))) * (0.6 + lv * 0.5 + ripple * 0.4) * (1.0 - fk * 0.18);
    vec3 c = trueish(mix(deepColor(), brightColor(), fract(uv.x * 0.5 + fk * 0.3 + uDrift * 0.02) * 0.6));
    if (a > col.a) col = vec4(c, min(a, 0.95));
  }
  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 col = vec4(0.0);
  if (uEdge != 1.0) col = ribbon(gl_FragCoord.y, uv);
  if (uEdge != 0.0) {
    vec4 top = ribbon(uRes.y - gl_FragCoord.y, uv);
    if (top.a > col.a) col = top;
  }
  fragColor = col;
}`;
  protected draw(r: Renderer, frame: FrameState, _t: Target, p: Program) {
    r.gl.uniform1fv(p.loc('uLevels[0]'), this.bands.update(frame));
    r.gl.uniform2fv(p.loc('uPulses[0]'), this.pulses.update(frame));
    p.f('uEdge', this.edge()).f('uBase', this.opt('height') as number);
    r.drawFullscreen();
  }
}

export function createOverlayScenes() {
  return {
    halo: new HaloOverlay(),
    horizon: new HorizonOverlay(),
    orbit: new OrbitOverlay(),
    curtain: new CurtainOverlay(),
    embers: new EmbersOverlay(),
    rain: new RainOverlay(),
    wave: new WaveOverlay(),
  } satisfies Record<OverlayMode, OverlayScene>;
}

/** Bloom strength per style (straight styles skip it). */
export const OVERLAY_BLOOM: Record<OverlayMode, number> = { halo: 0, horizon: 0, orbit: 0, curtain: 0, embers: 0.9, rain: 0.5, wave: 0 };

/** Styles that stay on screen in silence (the others fade away). */
export const SHOWN_IN_SILENCE: ReadonlySet<OverlayMode> = new Set(['rain']);
