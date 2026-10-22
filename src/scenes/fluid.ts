import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// Ink in water: a dye texture that persists between frames, carried around by a swirling
// (divergence-free) velocity field. Drops of the palette's colors fall in on beats.

const MAX_DROPS = 4;

const ADVECT_FS = /* glsl */ `
uniform sampler2D uPrev;
uniform float uDt;
uniform float uInit;
uniform vec4 uDrops[${MAX_DROPS}];      // xy = position (0..1), z = radius, w = strength
uniform vec3 uDropColor[${MAX_DROPS}];

// Stream function; its curl is a velocity field without sources or sinks, so the ink
// swirls and folds instead of piling up or thinning out.
float stream(vec2 p, float t) {
  // A large swirl plus a finer one: the fine layer stretches the ink into thin filaments.
  return fbm(p * 1.4 + vec2(t * 0.16, -t * 0.1), 3) + 0.55 * fbm(p * 4.0 - vec2(t * 0.09, t * 0.2), 2);
}

vec2 velocity(vec2 p, float t) {
  float e = 0.01;
  float dx = stream(p + vec2(e, 0.0), t) - stream(p - vec2(e, 0.0), t);
  float dy = stream(p + vec2(0.0, e), t) - stream(p - vec2(0.0, e), t);
  return vec2(dy, -dx) / (2.0 * e);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  vec3 col;
  if (uInit > 0.5) {
    col = BG;
  } else {
    // Each beat gives the water a push.
    float speed = 0.11 + uSlowEnergy * 0.16 + uMedBands.x * 0.06 + uBeat * 0.12;
    vec2 v = velocity(p, uDrift);
    // Semi-Lagrangian step: fetch the dye from where this pixel's water came from.
    vec2 back = vUv - vec2(v.x / aspect, v.y) * speed * uDt;
    col = texture(uPrev, back).rgb;
    // Old ink slowly settles back into the background.
    col = mix(col, BG, 1.0 - pow(0.993, uDt * 60.0));
  }
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    vec4 d = uDrops[i];
    if (d.w <= 0.0) continue;
    vec2 q = vec2((vUv.x - d.x) * aspect, vUv.y - d.y);
    // A soft-edged drop with a little ragged rim.
    float r = d.z * (1.0 + 0.25 * (vnoise(q * 18.0 + d.xy * 50.0) - 0.5));
    float k = exp(-dot(q, q) / (r * r)) * d.w;
    col = mix(col, uDropColor[i], clamp(k, 0.0, 1.0));
  }
  fragColor = vec4(col, 1.0);
}`;

const SHOW_FS = /* glsl */ `
uniform sampler2D uDye;
void main() {
  vec2 px = 1.0 / uRes;
  vec3 c = texture(uDye, vUv).rgb;
  // Wet sheen from the dye's own gradient.
  float l = luma(c);
  float lx = luma(texture(uDye, vUv + vec2(px.x * 2.0, 0.0)).rgb) - l;
  float ly = luma(texture(uDye, vUv + vec2(0.0, px.y * 2.0)).rgb) - l;
  float sheen = clamp(-(lx + ly) * 6.0, -0.4, 0.6);
  c *= 0.85 + uEnergy * 0.3 + uBeat * 0.12;
  c += HIGHLIGHT * max(sheen, 0.0) * 0.25 * (0.6 + uHigh);
  c *= 1.0 + min(sheen, 0.0) * 0.5;
  fragColor = vec4(c, 1.0);
}`;

interface Drop {
  x: number;
  y: number;
  radius: number;
  strength: number;
  color: [number, number, number];
}

export class FluidScene implements Scene {
  readonly id = 'fluid';
  readonly scale = 0.5;
  private advect!: Program;
  private show!: Program;
  private flip = false;
  private needsInit = true;
  private lastDrip = 0;
  private colorTurn = 0;
  private queue: Drop[] = [];
  private size = '';

  init(r: Renderer) {
    this.advect = r.sceneProgram(ADVECT_FS);
    this.show = r.sceneProgram(SHOW_FS);
  }

  private drop(frame: FrameState, big: boolean) {
    // Cycle through primary, secondary, accent and highlight (never the background).
    const role = [1, 2, 3, 1, 2, 4][this.colorTurn++ % 6];
    const p = frame.palette;
    const boost = role === 4 ? 0.9 : 1.15;
    this.queue.push({
      x: 0.12 + Math.random() * 0.76,
      y: 0.12 + Math.random() * 0.76,
      radius: big ? 0.045 + frame.features.bass * 0.05 : 0.02 + Math.random() * 0.02,
      strength: big ? 1 : 0.85,
      color: [p[role * 3] * boost, p[role * 3 + 1] * boost, p[role * 3 + 2] * boost],
    });
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    const f = frame.features;
    const a = r.target('fluidA', target.w, target.h);
    const b = r.target('fluidB', target.w, target.h);
    // A resize gives us fresh (empty) textures: start over with a few drops.
    const size = `${target.w}x${target.h}`;
    if (size !== this.size) {
      this.size = size;
      this.needsInit = true;
    }
    const [prev, cur] = this.flip ? [a, b] : [b, a];
    this.flip = !this.flip;

    if (this.needsInit) for (let i = 0; i < 4; i++) this.drop(frame, true);
    if (f.onBeat) this.drop(frame, true);
    // Gentle drips keep things alive in quiet passages.
    if (frame.time - this.lastDrip > 0.55 - frame.slowEnergy * 0.3) {
      this.lastDrip = frame.time;
      this.drop(frame, false);
    }

    const drops = new Float32Array(MAX_DROPS * 4);
    const colors = new Float32Array(MAX_DROPS * 3);
    this.queue.splice(0, MAX_DROPS).forEach((d, i) => {
      drops.set([d.x, d.y, d.radius, d.strength], i * 4);
      colors.set(d.color, i * 3);
    });

    r.bindTarget(cur);
    const p = r.common(this.advect.use(), frame, cur.w, cur.h).tex('uPrev', 1, prev.tex).f('uDt', frame.dt).f('uInit', this.needsInit ? 1 : 0);
    const gl = r.gl;
    gl.uniform4fv(p.loc('uDrops[0]'), drops);
    gl.uniform3fv(p.loc('uDropColor[0]'), colors);
    r.drawFullscreen();
    this.needsInit = false;

    r.bindTarget(target);
    r.common(this.show.use(), frame, target.w, target.h).tex('uDye', 1, cur.tex);
    r.drawFullscreen();
  }
}
