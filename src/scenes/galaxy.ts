import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// Every particle's position is a pure function of its index and time, so there is
// no simulation state at all: the vertex shader is the whole galaxy.
const VS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uFlow;
uniform float uDrift;
uniform float uSlowBass;
uniform float uBass;
uniform float uHigh;
uniform float uEnergy;
uniform float uShockR;
uniform float uShockAmp;
uniform float uPointScale;
uniform vec3 uPal[5];
uniform sampler2D uAudio;
out vec3 vColor;

#define TAU 6.28318530718
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  float id = float(gl_VertexID);
  float h1 = hash11(id * 1.17 + 0.31);
  float h2 = hash11(id * 3.31 + 1.73);
  float h3 = hash11(id * 7.13 + 2.97);
  float h4 = hash11(id * 0.71 + 5.11);
  float h5 = hash11(id * 9.37 + 7.43);

  vec3 pos;
  vec3 col;
  float size;
  float bright;

  if (h4 > 0.94) {
    // Background stars on a big sphere.
    float th = h1 * TAU;
    float ph = acos(2.0 * h2 - 1.0);
    pos = vec3(sin(ph) * cos(th), cos(ph), sin(ph) * sin(th)) * 9.0;
    col = mix(uPal[4], uPal[2], h3);
    size = 0.8 + h3 * 1.4;
    bright = 0.18 + 0.5 * pow(h3, 4.0) + uHigh * 0.6 * step(0.8, h5);
  } else {
    const float ARMS = 3.0;
    float arm = floor(h1 * ARMS);
    float r = pow(h2, 1.35) * 3.4 + 0.08;
    float tcol = clamp(r / 3.3, 0.0, 1.0);
    float s = texture(uAudio, vec2(tcol * 0.8 + 0.03, 0.25)).r;
    r *= 1.0 + uSlowBass * 0.1 + uBass * 0.05;

    // Rigid rotation plus a small, bounded wobble. (Real differential rotation winds the
    // arms tighter forever, and after a few minutes they melted into one bright disc.)
    float spread = (h3 - 0.5) * (0.9 / (r + 0.5));
    float ang = arm / ARMS * TAU + r * 2.2 + spread + uDrift * 0.22 + 0.25 * sin(uDrift * 0.21 + r * 1.3);
    pos = vec3(cos(ang) * r, 0.0, sin(ang) * r);
    pos.xz += (vec2(h5, hash11(id * 4.71)) - 0.5) * 0.35 * (0.3 + r * 0.4);
    float g = (h4 + hash11(id * 2.3) + hash11(id * 5.9)) / 3.0 - 0.5; // ~gaussian
    pos.y = g * 0.7 * exp(-r * 0.7) + g * 0.05;

    // Shockwave ring that travels out after each beat.
    float d = r - uShockR;
    float push = exp(-d * d * 18.0) * uShockAmp;
    pos.xz *= 1.0 + push * 0.14;
    pos.y += push * 0.25 * (h3 - 0.5);

    col = mix(mix(uPal[4], uPal[3], 0.5), uPal[3], smoothstep(0.0, 0.12, tcol));
    col = mix(col, uPal[1], smoothstep(0.1, 0.42, tcol));
    col = mix(col, uPal[2], smoothstep(0.42, 0.9, tcol));
    bright = (0.28 + s * 1.3 + push * 1.6 + uEnergy * 0.2) * mix(0.14, 1.0, smoothstep(0.1, 1.3, r));
    size = 0.9 + h3 * 1.5 + s * 1.6;
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
      .f('uPointScale', 2.2 * (cur.h / 900) * 2.2);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);

    r.bindTarget(target);
    r.common(this.out.use(), frame, target.w, target.h).tex('uTrail', 1, cur.tex);
    r.drawFullscreen();
  }
}
