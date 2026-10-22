import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// Every particle's position is a pure function of its index, time and two "shapes", so there
// is no simulation state at all: the vertex shader is the whole galaxy. Each particle is placed
// in the current shape and in the next one, and uMorph slides it from one to the other.
const VS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uDrift;
uniform float uSlowBass;
uniform float uBass;
uniform float uHigh;
uniform float uEnergy;
uniform float uShockR;
uniform float uShockAmp;
uniform float uPointScale;
uniform vec4 uShapeA;  // kind, arms, twist, size
uniform vec4 uShapeB;
uniform float uMorph;
uniform vec3 uPal[5];
uniform sampler2D uAudio;
out vec3 vColor;

#define TAU 6.28318530718
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// kind: 0 spiral, 1 barred spiral, 2 ring, 3 elliptical.
// Returns the position; .w of the result is the normalised radius used for color.
vec4 place(vec4 shape, vec4 h, float g) {
  float kind = shape.x;
  float arms = shape.y;
  float twist = shape.z;
  float size = shape.w;
  float spin = uDrift * 0.2 + 0.2 * sin(uDrift * 0.17);
  vec3 p;
  float rn;

  if (kind < 0.5 || kind > 0.5 && kind < 1.5) {
    bool barred = kind > 0.5;
    float r = pow(h.y, 1.25) * 3.3 * size + 0.06;
    rn = clamp(r / 3.3, 0.0, 1.0);
    float bar = barred ? 0.9 * size : 0.0;
    float ang;
    if (h.w < 0.3) {
      // Diffuse disc between the arms.
      ang = h.x * TAU;
    } else if (barred && r < bar) {
      // Stars along the central bar.
      p = vec3((h.x * 2.0 - 1.0) * bar, 0.0, (h.z - 0.5) * 0.25);
      p.xz = rot(spin) * p.xz;
      p.y = g * 0.25;
      return vec4(p, rn);
    } else {
      float n = barred ? 2.0 : arms;
      float arm = floor(h.x * n);
      float spread = (h.z - 0.5) * 0.45 / (r * 0.6 + 0.5);
      ang = arm / n * TAU + (r - bar) * twist + spread;
    }
    p = vec3(cos(ang + spin) * r, 0.0, sin(ang + spin) * r);
    p.xz += (vec2(hash11(h.x * 91.7), hash11(h.y * 53.1)) - 0.5) * 0.18 * (0.3 + r * 0.25);
    p.y = g * 0.55 * exp(-r * 0.8) + g * 0.06;
  } else if (kind < 2.5) {
    // Ring galaxy: a bright ring around a small core.
    float core = step(h.w, 0.22);
    float r = mix(2.2 * size + (h.z - 0.5) * 0.45, pow(h.y, 2.0) * 0.6, core);
    rn = mix(0.75, r / 3.3, core);
    float ang = h.x * TAU + spin * 0.7;
    p = vec3(cos(ang) * r, g * mix(0.15, 0.5, core), sin(ang) * r);
  } else {
    // Elliptical: a soft, slightly flattened 3D blob.
    float th = h.x * TAU;
    float ph = acos(2.0 * h.z - 1.0);
    float r = pow(h.y, 1.6) * 2.4 * size;
    rn = clamp(r / 3.0, 0.0, 1.0);
    p = vec3(sin(ph) * cos(th) * 1.3, cos(ph) * 0.75, sin(ph) * sin(th)) * r;
    p.xz = rot(spin * 0.5) * p.xz;
  }
  return vec4(p, rn);
}

void main() {
  float id = float(gl_VertexID);
  vec4 h = vec4(hash11(id * 1.17 + 0.31), hash11(id * 3.31 + 1.73), hash11(id * 7.13 + 2.97), hash11(id * 0.71 + 5.11));
  float h5 = hash11(id * 9.37 + 7.43);

  vec3 pos;
  vec3 col;
  float size;
  float bright;

  if (h5 > 0.94) {
    // Background stars on a big sphere.
    float th = h.x * TAU;
    float ph = acos(2.0 * h.y - 1.0);
    pos = vec3(sin(ph) * cos(th), cos(ph), sin(ph) * sin(th)) * 9.0;
    col = mix(uPal[4], uPal[2], h.z);
    size = 0.8 + h.z * 1.4;
    bright = 0.18 + 0.5 * pow(h.z, 4.0) + uHigh * 0.6 * step(0.8, h.w);
  } else {
    float g = (hash11(id * 2.3) + hash11(id * 5.9) + hash11(id * 4.4)) / 3.0 - 0.5; // ~gaussian
    vec4 a = place(uShapeA, h, g);
    vec4 b = place(uShapeB, h, g);
    // Particles don't all leave at once: each has its own delay, so the change ripples through.
    float m = smoothstep(h5 * 0.4, h5 * 0.4 + 0.6, uMorph);
    pos = mix(a.xyz, b.xyz, m);
    float rn = mix(a.w, b.w, m);
    float r = length(pos.xz);
    float s = texture(uAudio, vec2(rn * 0.8 + 0.03, 0.25)).r;
    pos *= 1.0 + uSlowBass * 0.08 + uBass * 0.04;

    // Shockwave ring that travels out after each beat.
    float d = r - uShockR;
    float push = exp(-d * d * 18.0) * uShockAmp;
    pos.xz *= 1.0 + push * 0.12;
    pos.y += push * 0.25 * (h.z - 0.5);

    col = mix(mix(uPal[4], uPal[3], 0.5), uPal[3], smoothstep(0.0, 0.12, rn));
    col = mix(col, uPal[1], smoothstep(0.1, 0.42, rn));
    col = mix(col, uPal[2], smoothstep(0.42, 0.9, rn));
    float disc = h.w < 0.3 ? 0.45 : 1.0;
    bright = (0.26 + s * 1.2 + push * 1.6 + uEnergy * 0.2) * disc * mix(0.14, 1.0, smoothstep(0.1, 1.3, r));
    size = 0.8 + h.z * 1.3 + s * 1.4;
  }

  // Orbiting camera.
  pos.xz = rot(uTime * 0.045) * pos.xz;
  pos.yz = rot(1.0 + sin(uTime * 0.07) * 0.18) * pos.yz;
  float dist = 6.3 - uBass * 0.5;
  float z = pos.z + dist;
  float aspect = uRes.x / uRes.y;
  float focal = 1.9;
  gl_Position = z > 0.05 ? vec4(pos.x * focal / aspect, pos.y * focal, 0.0, z) : vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = clamp(size * uPointScale / z, 1.0, 48.0);
  vColor = col * bright;
}`;

const MORPH_SECONDS = 5;
type Shape = [kind: number, arms: number, twist: number, size: number];

/** Pick a galaxy different from the current kind (spirals are the most common, as in the sky). */
function randomShape(notKind: number): Shape {
  const kinds = [0, 0, 0, 1, 1, 2, 3].filter((k) => k !== notKind || k === 0);
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  const arms = 2 + Math.floor(Math.random() * 5);
  const twist = 1.4 + Math.random() * 2.2;
  const size = 0.8 + Math.random() * 0.35;
  return [kind, arms, twist, size];
}

const PARTICLE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = exp(-dot(d, d) * 14.0);
  fragColor = vec4(vColor * a, 1.0);
}`;

const FADE_FS = /* glsl */ `
uniform sampler2D uPrev;
uniform float uDecay;
void main() {
  fragColor = vec4(texture(uPrev, vUv).rgb * uDecay, 1.0);
}`;

const OUT_FS = /* glsl */ `
uniform sampler2D uTrail;
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 bg = BG * (0.7 + 0.5 * (1.0 - length(uv)));
  // Faint nebula behind the disc.
  bg += mix(SECONDARY, PRIMARY, fbm(uv * 2.0 + uFlow * 0.02, 3)) * 0.05 * (0.6 + uEnergy) * smoothstep(1.2, 0.0, length(uv));
  fragColor = vec4(bg + texture(uTrail, vUv).rgb, 1.0);
}`;

export class GalaxyScene implements Scene {
  readonly id = 'galaxy';
  readonly scale = 1;
  private particles!: Program;
  private fade!: Program;
  private out!: Program;
  private flip = false;
  private shockTime = -10;
  private shockAmp = 0;
  private shapeA = randomShape(0);
  private shapeB = this.shapeA;
  private morphStart = -100;
  private nextChange = 25;
  private beatsSinceChange = 0;

  constructor(private count = 120_000) {}

  setCount(n: number) {
    this.count = n;
  }

  init(r: Renderer) {
    this.particles = r.program(VS, PARTICLE_FS);
    this.fade = r.sceneProgram(FADE_FS);
    this.out = r.sceneProgram(OUT_FS);
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    const gl = r.gl;
    const f = frame.features;
    if (f.onBeat) {
      this.shockTime = frame.time;
      this.shockAmp = 0.5 + f.bass * 0.8;
      this.beatsSinceChange++;
    }
    // A new shape every ~25 s (sooner when the music is busy), landing on a beat when there is one.
    let morph = Math.min(1, (frame.time - this.morphStart) / MORPH_SECONDS);
    if (morph >= 1) this.shapeA = this.shapeB;
    const due = frame.time > this.nextChange && (f.onBeat || f.silent || this.beatsSinceChange > 64);
    if (morph >= 1 && due) {
      this.shapeB = randomShape(this.shapeA[0]);
      this.morphStart = frame.time;
      this.nextChange = frame.time + 22 + Math.random() * 10;
      this.beatsSinceChange = 0;
      morph = 0;
    }
    const age = frame.time - this.shockTime;

    const a = r.target('galaxyA', target.w, target.h);
    const b = r.target('galaxyB', target.w, target.h);
    const [prev, cur] = this.flip ? [a, b] : [b, a];
    this.flip = !this.flip;

    r.bindTarget(cur);
    const decay = Math.pow(0.72 + f.energy * 0.08, frame.dt * 60);
    r.common(this.fade.use(), frame, cur.w, cur.h).tex('uPrev', 1, prev.tex).f('uDecay', decay);
    r.drawFullscreen();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    r.common(this.particles.use(), frame, cur.w, cur.h)
      .f('uShockR', age * 2.6)
      .f('uShockAmp', this.shockAmp * Math.exp(-age * 1.6))
      .f('uPointScale', 2.2 * (cur.h / 900) * 2.2)
      .f('uShapeA', ...this.shapeA)
      .f('uShapeB', ...this.shapeB)
      .f('uMorph', morph);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);

    r.bindTarget(target);
    r.common(this.out.use(), frame, target.w, target.h).tex('uTrail', 1, cur.tex);
    r.drawFullscreen();
  }
}
