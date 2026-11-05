import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';
import { hexToLinearRgb } from '../color/oklab';
import { ATLAS_COLS, ATLAS_ROWS, createGlyphAtlas } from '../scenes/ascii';
import { KaleidoScene } from '../scenes/kaleido';
import { EDGES, optionOf, SPOTS, type OverlayMode, type OverlayOptions } from './modes';

// Overlay styles: drawn on black, which the compositor turns transparent (light shows through
// as much as it shines). They live at the edges of the screen so the desktop stays usable.

/** Palette colors pushed up to a visible brightness: a dark cover must still glow on the desktop. */
const VIVID = /* glsl */ `
vec3 vivid(vec3 c) {
  float m = max(c.r, max(c.g, c.b));
  return c / max(m, 1e-4) * max(m, 0.75);
}`;

/** `level(u)`: smoothed band levels (see BandLevels), u from 0 (bass) to 1 (highs). */
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
 * The log spectrum folded into `n` bands that rise fast and fall slowly, so bars and rings
 * move with the music without flickering frame to frame.
 */
class BandLevels {
  readonly values: Float32Array;
  constructor(
    readonly n: number,
    private lo = 0.02,
    private hi = 0.85,
  ) {
    this.values = new Float32Array(n);
  }
  update(frame: FrameState) {
    const s = frame.features.spectrum;
    const attack = 1 - Math.exp(-frame.dt / 0.04);
    const release = 1 - Math.exp(-frame.dt / 0.25);
    for (let i = 0; i < this.n; i++) {
      const u = this.lo + ((this.hi - this.lo) * i) / (this.n - 1);
      const x = u * (s.length - 1);
      const a = Math.floor(x);
      const target = Math.max(s[a], s[Math.min(s.length - 1, a + 1)]);
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
    this.data.fill(0);
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
  ctx: OverlayContext = { options: {}, music: 0 };
  protected prog!: Program;
  protected abstract readonly fs: string;

  init(r: Renderer) {
    this.prog = r.sceneProgram(VIVID + this.fs);
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
  readonly straightAlpha = true;
  private bands = new BandLevels(24);
  private pulses = new Pulses(4, 2.5);
  protected readonly fs = /* glsl */ `
${levelsGlsl(24)}
uniform vec2 uPulses[4]; // age (s), strength
uniform float uTint;     // 0 the cover's colors, 1 white, 2 black

// Color in rgb, opacity in a: the cover's own colors, as dark as they really are.
vec4 edge(float d, float u) {
  float lv = level(u);
  float thick = 0.006 + lv * 0.018 + uMedBands.x * 0.008;
  float glow = exp(-d / thick) * (0.2 + lv * 0.8) + exp(-d * 400.0) * (0.2 + lv * 0.6);
  // Each kick sends a flash from the bottom up both sides; they overlap instead of restarting.
  float pulse = 0.0;
  for (int i = 0; i < 4; i++) {
    float age = uPulses[i].x;
    pulse += uPulses[i].y * exp(-pow((u - age * 1.1) * 7.0, 2.0)) * exp(-age * 1.4);
  }
  glow *= 1.0 + min(pulse, 2.0) * 2.0;
  vec3 c = mix(PRIMARY, ACCENT, smoothstep(0.0, 1.0, u));
  c = mix(c, SECONDARY, 0.3 + 0.3 * sin(u * TAU * 1.5 - uDrift * 0.5));
  // A touch of lift so the darkest covers still read, without washing the hue out.
  c = mix(c, vivid(c), 0.2);
  if (uTint > 1.5) c = vec3(0.0);
  else if (uTint > 0.5) c = vec3(1.0);
  return vec4(c * (1.0 + glow * 0.4), clamp(glow * 1.1, 0.0, 0.95));
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
    p.f('uTint', ['cover', 'white', 'black'].indexOf(this.opt('color') as string));
    r.drawFullscreen();
  }
}

/** Horizon: mirrored spectrum bars along the bottom and/or top edge, bass in the middle, with falling peaks. */
class HorizonOverlay extends OverlayScene {
  readonly id = 'horizon';
  readonly scale = 1;
  readonly straightAlpha = true;
  // From ~45 Hz: below that there's little but rumble, and the middle bars would sit still.
  private bands = new BandLevels(36, 0.07);
  private peaks = new Float32Array(36);
  protected readonly fs = /* glsl */ `
uniform float uLevels[36];
uniform float uPeaks[36];
uniform float uEdge;   // 0 bottom, 1 top, 2 both
uniform float uMaxH;   // tallest bar, as a fraction of the screen height

// Color in rgb, opacity in a, in the cover's real colors.
vec4 bars(float y, float xm) {
  float cell = xm * 36.0;
  int i = int(min(floor(cell), 35.0));
  float fx = fract(cell);
  float lv = uLevels[i];
  float h = 0.004 + lv * uMaxH;
  float gap = smoothstep(0.1, 0.2, fx) * smoothstep(0.9, 0.8, fx);
  vec3 low = mix(PRIMARY, vivid(PRIMARY), 0.25), high = mix(ACCENT, vivid(ACCENT), 0.25);
  vec3 c = mix(low, high, smoothstep(0.0, uMaxH, y));
  float a = step(y, h) * gap * 0.92;
  // A soft glow past each bar and a peak marker that falls back slowly.
  a = max(a, gap * step(h, y) * exp(-(y - h) / (uMaxH * 0.2)) * 0.35 * lv);
  float pk = 0.004 + uPeaks[i] * uMaxH + 0.005;
  float cap = gap * smoothstep(2.5, 0.5, abs(y - pk) * uRes.y);
  c = mix(c, mix(HIGHLIGHT, vivid(HIGHLIGHT), 0.25), cap);
  a = max(a, cap * 0.95);
  // A thin line along the edge.
  a = max(a, exp(-y * uRes.y / 2.5) * (0.4 + uMedBands.x * 0.5));
  return vec4(c * (1.0 + lv * 0.3), a);
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
    for (let i = 0; i < lv.length; i++) this.peaks[i] = Math.max(lv[i], this.peaks[i] - frame.dt * 0.18);
    r.gl.uniform1fv(p.loc('uLevels[0]'), lv);
    r.gl.uniform1fv(p.loc('uPeaks[0]'), this.peaks);
    p.f('uEdge', this.edge()).f('uMaxH', this.opt('height') as number);
    r.drawFullscreen();
  }
}

/** Orbit: a bubble with the kaleidoscope inside, ringed by the spectrum. It fades away under the mouse. */
export class OrbitOverlay extends OverlayScene {
  readonly id = 'orbit';
  readonly scale = 1;
  private bands = new BandLevels(40);
  private inner = new KaleidoScene();
  private peekUntil = 0;
  private opacity = 1;
  protected readonly fs = /* glsl */ `
${levelsGlsl(40)}
uniform sampler2D uInner;
uniform vec3 uCircle;   // center and radius, in pixels
uniform float uBeatAge;
uniform float uOpacity;
void main() {
  vec2 p = gl_FragCoord.xy - uCircle.xy;
  float R = uCircle.z;
  float r = length(p);
  vec3 col = vec3(0.0);
  // Inside: the scene, solid (the one overlay that hides what's behind it, unless peeked at).
  float inside = smoothstep(R + 0.75, R - 0.75, r);
  if (inside > 0.0) col = texture(uInner, p / (2.0 * R) + 0.5).rgb * inside;
  float rim = exp(-abs(r - R) / 1.4) * (0.55 + exp(-uBeatAge * 4.0) * 0.8);
  col += vivid(HIGHLIGHT) * rim;
  // Around it: bars of the spectrum, bass at the bottom, mirrored left and right.
  float a = atan(p.y, p.x) + PI * 0.5 + sin(uDrift * 0.1) * 0.3;
  float u = abs(fract(a / TAU) * 2.0 - 1.0);
  float cell = u * 40.0;
  float fx = fract(cell);
  float lv = level((floor(cell) + 0.5) / 40.0);
  float gap = smoothstep(0.12, 0.3, fx) * smoothstep(0.88, 0.7, fx);
  float r0 = R + 0.06 * R;
  float len = 0.04 * R + lv * R * 0.5;
  vec3 bc = mix(vivid(PRIMARY), vivid(ACCENT), smoothstep(0.0, R * 0.5, r - r0));
  col += bc * gap * smoothstep(r0 - 1.0, r0, r) * smoothstep(r0 + len + 1.0, r0 + len, r) * (0.6 + lv);
  col += bc * gap * step(r0 + len, r) * exp(-(r - r0 - len) / (R * 0.05)) * 0.35 * lv;
  fragColor = vec4(col * uOpacity, inside * uOpacity);
}`;
  private lastBeat = -10;

  init(r: Renderer) {
    super.init(r);
    this.inner.init(r);
  }

  /** Center (from the bottom-left, like gl_FragCoord) and radius of the bubble on a w × h surface. */
  bubble(w: number, h: number) {
    const R = Math.round(h * (this.opt('size') as number));
    const margin = h * 0.05 + R * 0.62;
    const spot = Math.max(0, SPOTS.indexOf(this.opt('position') as (typeof SPOTS)[number]));
    const col = spot % 3;
    const row = Math.floor(spot / 3);
    const x = col === 0 ? margin + R : col === 1 ? w / 2 : w - margin - R;
    const y = row === 0 ? h - margin - R : row === 1 ? h / 2 : margin + R;
    return { x, y, R };
  }

  /** The mouse is over the bubble: fade out for a few seconds so what's underneath shows. */
  peek(now: number) {
    this.peekUntil = now + 3;
  }

  get peeking() {
    return performance.now() / 1000 < this.peekUntil;
  }

  protected draw(r: Renderer, frame: FrameState, target: Target, p: Program) {
    const want = frame.time < this.peekUntil ? 0.08 : 1;
    this.opacity += (want - this.opacity) * (1 - Math.exp(-frame.dt / 0.25));
    if (frame.features.onBeat) this.lastBeat = frame.time;
    const { x, y, R } = this.bubble(target.w, target.h);
    const inner = r.target('orbit-inner', R * 2, R * 2);
    // Skip the kaleidoscope while the bubble is faded out of the way.
    if (this.opacity > 0.02) this.inner.render(r, frame, inner);
    // The inner scene bound its own target and program; come back to ours.
    r.bindTarget(target);
    r.common(this.prog.use(), frame, target.w, target.h)
      .tex('uInner', 1, inner.tex)
      .f('uCircle', x, y, R)
      .f('uBeatAge', frame.time - this.lastBeat)
      .f('uOpacity', this.opacity);
    r.gl.uniform1fv(p.loc('uLevels[0]'), this.bands.update(frame));
    r.drawFullscreen();
  }
}

/** Curtain: the aurora hanging from the top of the screen, brightest at its lower hem. */
class CurtainOverlay extends OverlayScene {
  readonly id = 'curtain';
  readonly scale = 0.5;
  protected readonly fs = /* glsl */ `
uniform float uHeight;  // average depth of the hem, as a fraction of the screen height
vec3 paletteCycle(float h) {
  h = fract(h) * 3.0;
  if (h < 1.0) return mix(PRIMARY, ACCENT, smoothstep(0.0, 1.0, h));
  if (h < 2.0) return mix(ACCENT, SECONDARY, smoothstep(1.0, 2.0, h));
  return mix(SECONDARY, PRIMARY, smoothstep(2.0, 3.0, h));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float x = uv.x * uRes.x / uRes.y;
  float t = 1.0 - uv.y; // 0 at the top edge
  float d = uDrift * 0.05;
  vec3 m = uMedBands;
  vec3 col = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    float xx = x + 0.05 * sin(x * (3.0 + fk) + d * (1.5 + fk) + fk * 2.0) * (1.0 + m.y * 1.5);
    // The hem sways, and the bass lets it hang lower.
    float hem = uHeight * (0.5 + fbm(vec2(xx * 0.9 + fk * 7.0, d * 0.6), 3) + m.x * 0.6 + fk * 0.3);
    float above = hem - t;
    float body = smoothstep(-0.006, 0.004, above) * exp(-max(above, 0.0) * (1.2 - m.x * 0.4) / uHeight);
    float rays = 0.45 + 0.55 * tnoise(vec2(xx * 160.0, d * 3.0 + fk * 20.0));
    rays *= 0.7 + 0.3 * tnoise(vec2(xx * 420.0 - uTime * (0.4 + m.z * 2.0), fk * 9.0));
    float gaps = smoothstep(0.25, 0.55, fbm(vec2(xx * 0.6 + d * 0.2 + fk * 11.0, fk * 3.0), 3));
    vec3 c = vivid(paletteCycle(fbm(vec2(xx * 0.4, fk * 5.0), 2) * 1.5 + d * 0.3 + fk * 0.35));
    col += c * body * rays * gaps * (0.8 - fk * 0.25);
  }
  // Leave the very top (where the bar lives) almost clear.
  col *= smoothstep(0.0, 0.035, t) * (1.0 + m.x * 0.8 + uSlowEnergy * 0.5);
  fragColor = vec4(col, 0.0);
}`;
  protected draw(r: Renderer, _f: FrameState, _t: Target, p: Program) {
    p.f('uHeight', this.opt('height') as number);
    r.drawFullscreen();
  }
}

/** Embers: sparks rise from the bottom edge, as many as the song is busy; big kicks burst. */
class EmbersOverlay extends OverlayScene {
  readonly id = 'embers';
  readonly scale = 0.75;
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
  float density = clamp(0.05 + uSlowEnergy * 0.5 + uMedBands.x * 0.3, 0.0, 0.85);
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

vec3 ribbon(float py, vec2 uv) {
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
  vec3 col = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    float amp = (0.01 + lv * 0.12 + ripple * 0.07 + uBeat * 0.02) * H * (1.0 - fk * 0.18) * (0.5 + uBase * 5.0);
    float phase = uv.x * (6.0 + fk * 2.3 + uMedBands.y * 3.0) - uFlow * (1.1 + fk * 0.35) + fk * 1.7;
    float y = uBase * H + sin(phase) * amp * (0.6 + 0.4 * sin(uv.x * 3.0 + uDrift * 0.3 + fk));
    float dy = abs(py - y);
    float w = (1.0 + lv * 1.5 + ripple) * H / 1000.0;
    float line = exp(-dy / w) + 0.2 * exp(-dy / (w * 10.0));
    vec3 c = vivid(mix(PRIMARY, ACCENT, fract(uv.x * 0.5 + fk * 0.3 + uDrift * 0.02)));
    col += c * line * (0.45 + lv + ripple * 0.6) * (1.0 - fk * 0.2);
  }
  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 col = vec3(0.0);
  if (uEdge != 1.0) col += ribbon(gl_FragCoord.y, uv);
  if (uEdge != 0.0) col += ribbon(uRes.y - gl_FragCoord.y, uv);
  fragColor = vec4(col, 0.0);
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

/** Bloom strength per style. */
export const OVERLAY_BLOOM: Record<OverlayMode, number> = { halo: 0.6, horizon: 0.55, orbit: 0.45, curtain: 0.6, embers: 0.9, rain: 0.5, wave: 0.8 };

/** Styles that stay on screen in silence (the others fade away). */
export const SHOWN_IN_SILENCE: ReadonlySet<OverlayMode> = new Set(['rain']);
