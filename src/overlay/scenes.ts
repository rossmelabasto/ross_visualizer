import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';
import { hexToLinearRgb } from '../color/oklab';
import { ATLAS_COLS, ATLAS_ROWS, createGlyphAtlas } from '../scenes/ascii';
import { KaleidoScene } from '../scenes/kaleido';
import type { OverlayMode } from './modes';

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

abstract class OverlayScene implements Scene {
  abstract readonly id: OverlayMode;
  abstract readonly scale: number;
  protected prog!: Program;
  protected abstract readonly fs: string;
  protected lastBeat = -10;

  init(r: Renderer) {
    this.prog = r.sceneProgram(VIVID + this.fs);
  }

  /** Seconds since the last beat, for effects that travel after a kick. */
  protected beatAge(frame: FrameState) {
    if (frame.features.onBeat) this.lastBeat = frame.time;
    return frame.time - this.lastBeat;
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
  protected readonly fs = /* glsl */ `
${levelsGlsl(24)}
uniform float uBeatAge;

vec3 edge(float d, float u) {
  float lv = level(u);
  float thick = 0.006 + lv * 0.018 + uMedBands.x * 0.008;
  float glow = exp(-d / thick) * (0.2 + lv * 0.8) + exp(-d * 400.0) * (0.2 + lv * 0.6);
  // After each kick a flash runs from the bottom up both sides and meets at the top.
  float pulse = exp(-pow((u - uBeatAge * 1.4) * 8.0, 2.0)) * exp(-uBeatAge * 1.8);
  glow *= 1.0 + pulse * 2.5;
  vec3 c = mix(vivid(PRIMARY), vivid(ACCENT), smoothstep(0.0, 1.0, u));
  c = mix(c, vivid(SECONDARY), 0.3 + 0.3 * sin(u * TAU * 1.5 - uDrift * 0.5));
  return c * glow * 0.8;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float W = uRes.x, H = uRes.y;
  float around = W + H; // half the perimeter: bottom center → top center
  float ax = abs(px.x - 0.5 * W);
  vec3 col = edge(px.y / H, ax / around);
  col = max(col, edge((H - px.y) / H, (W + H - ax) / around));
  col = max(col, edge(min(px.x, W - px.x) / H, (0.5 * W + px.y) / around));
  fragColor = vec4(col, 0.0);
}`;
  protected draw(r: Renderer, frame: FrameState, _t: Target, p: Program) {
    r.gl.uniform1fv(p.loc('uLevels[0]'), this.bands.update(frame));
    p.f('uBeatAge', this.beatAge(frame));
    r.drawFullscreen();
  }
}

/** Horizon: mirrored spectrum bars rising from the bottom edge, bass in the middle, with falling peaks. */
class HorizonOverlay extends OverlayScene {
  readonly id = 'horizon';
  readonly scale = 1;
  private bands = new BandLevels(36);
  private peaks = new Float32Array(36);
  protected readonly fs = /* glsl */ `
uniform float uLevels[36];
uniform float uPeaks[36];
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float xm = abs(uv.x - 0.5) * 2.0;
  float cell = xm * 36.0;
  int i = int(min(floor(cell), 35.0));
  float fx = fract(cell);
  float lv = uLevels[i];
  float y = uv.y;
  const float MAX_H = 0.2;
  float h = 0.005 + lv * MAX_H;
  float gap = smoothstep(0.1, 0.2, fx) * smoothstep(0.9, 0.8, fx);
  vec3 low = vivid(PRIMARY), high = vivid(ACCENT);
  vec3 col = mix(low, high, smoothstep(0.0, MAX_H, y)) * step(y, h) * gap * (0.55 + lv * 0.9);
  // A soft glow above each bar and a peak marker that falls back slowly.
  col += mix(low, high, 0.5) * gap * step(h, y) * exp(-(y - h) * 50.0) * 0.3 * lv;
  float pk = 0.005 + uPeaks[i] * MAX_H + 0.006;
  col += vivid(HIGHLIGHT) * gap * smoothstep(2.5, 0.5, abs(y - pk) * uRes.y) * (0.35 + uPeaks[i]);
  // A thin line of light along the bottom edge.
  col += mix(low, vivid(SECONDARY), xm) * exp(-gl_FragCoord.y / 3.0) * (0.25 + uMedBands.x);
  fragColor = vec4(col, 0.0);
}`;
  protected draw(r: Renderer, frame: FrameState, _t: Target, p: Program) {
    const lv = this.bands.update(frame);
    for (let i = 0; i < lv.length; i++) this.peaks[i] = Math.max(lv[i], this.peaks[i] - frame.dt * 0.18);
    r.gl.uniform1fv(p.loc('uLevels[0]'), lv);
    r.gl.uniform1fv(p.loc('uPeaks[0]'), this.peaks);
    r.drawFullscreen();
  }
}

/** Orbit: a bubble in the corner with the kaleidoscope inside, ringed by the spectrum. */
class OrbitOverlay extends OverlayScene {
  readonly id = 'orbit';
  readonly scale = 1;
  private bands = new BandLevels(40);
  private inner = new KaleidoScene();
  protected readonly fs = /* glsl */ `
${levelsGlsl(40)}
uniform sampler2D uInner;
uniform vec3 uCircle;   // center and radius, in pixels
uniform float uBeatAge;
void main() {
  vec2 p = gl_FragCoord.xy - uCircle.xy;
  float R = uCircle.z;
  float r = length(p);
  vec3 col = vec3(0.0);
  // Inside: the scene, solid (this is the one overlay that hides what's behind it).
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
  fragColor = vec4(col, inside);
}`;
  init(r: Renderer) {
    super.init(r);
    this.inner.init(r);
  }
  protected draw(r: Renderer, frame: FrameState, target: Target, p: Program) {
    const R = Math.round(target.h * 0.12);
    const margin = target.h * 0.05 + R * 0.6;
    const cx = target.w - margin - R;
    const cy = margin + R;
    const inner = r.target('orbit-inner', R * 2, R * 2);
    this.inner.render(r, frame, inner);
    // The inner scene bound its own target and program; come back to ours.
    r.bindTarget(target);
    r.common(this.prog.use(), frame, target.w, target.h)
      .tex('uInner', 1, inner.tex)
      .f('uCircle', cx, cy, R)
      .f('uBeatAge', this.beatAge(frame));
    r.gl.uniform1fv(p.loc('uLevels[0]'), this.bands.update(frame));
    r.drawFullscreen();
  }
}

/** Curtain: the aurora hanging from the top of the screen, brightest at its lower hem. */
class CurtainOverlay extends OverlayScene {
  readonly id = 'curtain';
  readonly scale = 0.5;
  protected readonly fs = /* glsl */ `
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
    float hem = 0.06 + 0.09 * fbm(vec2(xx * 0.9 + fk * 7.0, d * 0.6), 3) + m.x * 0.07 + fk * 0.03;
    float above = hem - t;
    float body = smoothstep(-0.006, 0.004, above) * exp(-max(above, 0.0) * (13.0 - m.x * 5.0));
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
}

/** Embers: sparks that rise from the bottom edge; the bass decides how many. */
class EmbersOverlay extends OverlayScene {
  readonly id = 'embers';
  readonly scale = 0.75;
  protected readonly fs = /* glsl */ `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes.y;
  vec3 col = vec3(0.0);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float cell = 0.045 - fl * 0.01;
    float column = floor(uv.x / cell);
    float h = hash21(vec2(column, fl * 13.1));
    float clock = uFlow * (0.05 + h * 0.06 + fl * 0.02) + h * 7.3;
    float life = fract(clock);
    float alive = step(hash21(vec2(column, floor(clock) + fl * 31.0)), 0.2 + uMedBands.x * 0.6);
    float y = life * (0.3 + h * 0.3);
    float x = (column + 0.5 + 0.35 * sin(life * 6.0 + h * 20.0)) * cell;
    float r = (0.005 + h * 0.004) * (1.0 - life * 0.5);
    float d2 = dot(uv - vec2(x, y), uv - vec2(x, y));
    float b = exp(-d2 / (r * r)) * alive * (1.0 - life) * (0.6 + 0.9 * uBeat);
    float flicker = 0.7 + 0.3 * sin(uTime * (8.0 + h * 10.0) + h * 40.0);
    vec3 c = mix(vivid(ACCENT), vivid(PRIMARY), h);
    col += mix(c, vivid(HIGHLIGHT), exp(-d2 / (r * r * 0.15)) * 0.6) * b * flicker * 2.6;
  }
  // The glowing bed they rise from.
  col += vivid(mix(PRIMARY, ACCENT, 0.5)) * exp(-uv.y * 30.0) * (0.08 + uMedBands.x * 0.45);
  fragColor = vec4(col, 0.0);
}`;
}

/** rOS rain: falling glyphs down both sides of the screen, in the brand lime. */
class RainOverlay extends OverlayScene {
  readonly id = 'rain';
  readonly scale = 1;
  private atlas!: WebGLTexture;
  private brand = hexToLinearRgb('#afff00');
  protected readonly fs = /* glsl */ `
uniform sampler2D uGlyphs;
uniform vec2 uCell;
uniform vec3 uBrand;
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
  float h = hash21(vec2(cell.x, 3.7));
  float clock = uFlow * (0.08 + h * 0.12) + h * 9.1;
  float head = 1.0 - fract(clock);           // falls from the top
  float on = step(hash21(vec2(cell.x, floor(clock))), 0.75);
  float dist = fract((cell.y + 0.5) / grid.y - head);  // how far above the head
  float trail = 0.12 + h * 0.2 + uMedBands.x * 0.2;
  float k = dist < trail ? pow(1.0 - dist / trail, 1.6) : 0.0;
  float rate = 2.0 + h * 5.0 + uMedBands.z * 8.0;
  float code = 33.0 + floor(hash21(cell + floor(uTime * rate) * 0.37) * 93.0);
  vec3 ink = dist * grid.y < 1.0 ? mix(uBrand, vec3(1.0), 0.6) : mix(uBrand, vivid(PRIMARY), 0.35);
  vec3 col = ink * glyph(code, cuv) * k * on * mask * (1.1 + uMedBands.y * 1.0);
  fragColor = vec4(col, 0.0);
}`;
  init(r: Renderer) {
    super.init(r);
    this.atlas = createGlyphAtlas(r);
  }
  protected draw(r: Renderer, _f: FrameState, _t: Target, p: Program) {
    const cellH = Math.round(18 * r.pixelRatio);
    p.tex('uGlyphs', 1, this.atlas)
      .f('uCell', Math.round(cellH * 0.6), cellH)
      .f('uBrand', this.brand[0], this.brand[1], this.brand[2]);
    r.drawFullscreen();
  }
}

/** Wave: a ribbon of light threads along the bottom, swelling with the spectrum (bass in the middle). */
class WaveOverlay extends OverlayScene {
  readonly id = 'wave';
  readonly scale = 0.75;
  private bands = new BandLevels(32);
  protected readonly fs = /* glsl */ `
${levelsGlsl(32)}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float py = gl_FragCoord.y;
  float lv = level(abs(uv.x - 0.5) * 2.0);
  float base = 0.09 * uRes.y;
  vec3 col = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    float amp = (0.01 + lv * 0.09) * uRes.y * (1.0 - fk * 0.18);
    float phase = uv.x * (7.0 + fk * 2.3) - uDrift * (0.7 + fk * 0.25) + fk * 1.7;
    float y = base + sin(phase) * amp * (0.6 + 0.4 * sin(uv.x * 3.0 + uDrift * 0.2 + fk));
    float dy = abs(py - y);
    float w = (1.0 + lv * 1.5) * uRes.y / 1000.0;
    float line = exp(-dy / w) + 0.2 * exp(-dy / (w * 10.0));
    vec3 c = vivid(mix(PRIMARY, ACCENT, fract(uv.x * 0.5 + fk * 0.3 + uDrift * 0.02)));
    col += c * line * (0.45 + lv) * (1.0 - fk * 0.2);
  }
  fragColor = vec4(col, 0.0);
}`;
  protected draw(r: Renderer, frame: FrameState, _t: Target, p: Program) {
    r.gl.uniform1fv(p.loc('uLevels[0]'), this.bands.update(frame));
    r.drawFullscreen();
  }
}

export function createOverlayScenes(): Record<OverlayMode, Scene> {
  return {
    halo: new HaloOverlay(),
    horizon: new HorizonOverlay(),
    orbit: new OrbitOverlay(),
    curtain: new CurtainOverlay(),
    embers: new EmbersOverlay(),
    rain: new RainOverlay(),
    wave: new WaveOverlay(),
  };
}

/** Bloom strength per style. */
export const OVERLAY_BLOOM: Record<OverlayMode, number> = { halo: 0.6, horizon: 0.55, orbit: 0.45, curtain: 0.6, embers: 0.9, rain: 0.5, wave: 0.8 };
