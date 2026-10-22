import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// A real fluid: the stable-fluids solver (curl → vorticity → divergence → pressure → projection
// → advection), adapted from Pavel Dobryakov's WebGL-Fluid-Simulation (MIT), which follows
// "Fast Fluid Dynamics Simulation on the GPU" from GPU Gems.
//
// The music pours ink in: three nozzles drift slowly around the screen, one per band (bass,
// mids, highs), each trickling its palette color as much as its band plays. The motion comes
// from the beats: each one fires a burst and kicks the bass nozzle, then the water settles.
// Velocity is in simulation texels per second; the dye lives on a finer grid than the velocity.

const MAX_SPLATS = 8;
const SIM_SIZE = 128; // shorter side of the velocity grid
const DYE_SIZE = 720; // shorter side of the dye grid
const PRESSURE_ITERATIONS = 20;
const PRESSURE_DECAY = 0.8;
// High enough that the water settles between beats (about half the speed is gone after
// 0.3 s), so each kick reads as a push instead of the whole tank churning nonstop.
const VELOCITY_DISSIPATION = 2.6;

/** Fullscreen pass with the left/right/top/bottom neighbours precomputed. */
const NEIGHBOURS_VS = /* glsl */ `#version 300 es
uniform vec2 uTexel;
out vec2 vUv, vL, vR, vT, vB;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  vL = p - vec2(uTexel.x, 0.0);
  vR = p + vec2(uTexel.x, 0.0);
  vT = p + vec2(0.0, uTexel.y);
  vB = p - vec2(0.0, uTexel.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB;
out vec4 fragColor;
`;

const SPLAT_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec4 uSplat[${MAX_SPLATS}];   // xy = position (0..1), zw = force or unused
uniform vec4 uValue[${MAX_SPLATS}];   // rgb = what to add, a = radius
uniform int uCount;
void main() {
  vec3 base = texture(uTarget, vUv).xyz;
  for (int i = 0; i < ${MAX_SPLATS}; i++) {
    if (i >= uCount) break;
    vec2 p = vUv - uSplat[i].xy;
    p.x *= uAspect;
    base += exp(-dot(p, p) / uValue[i].a) * uValue[i].rgb;
  }
  fragColor = vec4(base, 1.0);
}`;

const CURL_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;

// Vorticity confinement: puts back the small swirls that the coarse grid smears out.
const VORTICITY_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uStrength;
uniform float uDt;
void main() {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= uStrength * C;
  force.y *= -1.0;
  vec2 v = texture(uVelocity, vUv).xy + force * uDt;
  fragColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}`;

const DIVERGENCE_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  // Solid walls: mirror the velocity at the edges.
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;
  fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

const SCALE_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uTarget;
uniform float uValue;
void main() { fragColor = texture(uTarget, vUv) * uValue; }`;

const PRESSURE_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float div = texture(uDivergence, vUv).x;
  fragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 v = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  fragColor = vec4(v, 0.0, 1.0);
}`;

const ADVECT_FS =
  HEAD +
  /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uSimTexel;
uniform float uDt;
uniform float uDissipation;
void main() {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uSimTexel;
  fragColor = vec4(texture(uSource, coord).rgb / (1.0 + uDissipation * uDt), 1.0);
}`;

// Ink over the cover's background, lit as if it had a little relief.
const SHOW_FS = /* glsl */ `
uniform sampler2D uDye;
uniform vec2 uDyeTexel;
void main() {
  vec3 c = texture(uDye, vUv).rgb;
  vec3 l = texture(uDye, vUv - vec2(uDyeTexel.x, 0.0)).rgb;
  vec3 r = texture(uDye, vUv + vec2(uDyeTexel.x, 0.0)).rgb;
  vec3 t = texture(uDye, vUv + vec2(0.0, uDyeTexel.y)).rgb;
  vec3 b = texture(uDye, vUv - vec2(0.0, uDyeTexel.y)).rgb;
  vec3 n = normalize(vec3(length(r) - length(l), length(t) - length(b), length(uDyeTexel) * 8.0));
  float diffuse = clamp(dot(n, normalize(vec3(-0.3, 0.4, 1.0))) + 0.35, 0.8, 1.2);
  // Soft-clip so where lots of ink piles up it stays colourful instead of burning to white.
  c = c * 1.3 / (1.0 + luma(c) * 0.4);
  fragColor = vec4(BG * 0.7 + c * diffuse, 1.0);
}`;

type Vec3 = [number, number, number];
interface Splat {
  x: number;
  y: number;
  dx: number;
  dy: number;
  color: Vec3;
  radius: number;
}
interface DoubleTarget {
  read: Target;
  write: Target;
}

export class FluidScene implements Scene {
  readonly id = 'fluid';
  readonly scale = 1;
  private progs!: Record<'splat' | 'curl' | 'vorticity' | 'divergence' | 'scale' | 'pressure' | 'gradient' | 'advect', Program>;
  private show!: Program;
  private flip = { vel: false, dye: false, press: false };
  private splats: Splat[] = [];
  private size = '';
  private burstTurn = 0;
  private seeded = false;

  init(r: Renderer) {
    const p = (fs: string) => r.program(NEIGHBOURS_VS, fs);
    this.progs = {
      splat: p(SPLAT_FS),
      curl: p(CURL_FS),
      vorticity: p(VORTICITY_FS),
      divergence: p(DIVERGENCE_FS),
      scale: p(SCALE_FS),
      pressure: p(PRESSURE_FS),
      gradient: p(GRADIENT_FS),
      advect: p(ADVECT_FS),
    };
    this.show = r.sceneProgram(SHOW_FS);
  }

  private pair(r: Renderer, name: 'vel' | 'dye' | 'press', w: number, h: number): DoubleTarget {
    const a = r.target(`fluid-${name}A`, w, h);
    const b = r.target(`fluid-${name}B`, w, h);
    return this.flip[name] ? { read: b, write: a } : { read: a, write: b };
  }

  private swap(name: 'vel' | 'dye' | 'press') {
    this.flip[name] = !this.flip[name];
  }

  private pass(r: Renderer, prog: Program, out: Target, texel: [number, number]) {
    r.bindTarget(out);
    prog.f('uTexel', texel[0], texel[1]);
    r.drawFullscreen();
  }

  /** A palette color, a little brighter than the cover so it reads as ink. */
  private color(frame: FrameState, role: number, gain: number): Vec3 {
    const p = frame.palette;
    return [p[role * 3] * gain, p[role * 3 + 1] * gain, p[role * 3 + 2] * gain];
  }

  private queueMusic(frame: FrameState) {
    const f = frame.features;
    const [bass, mid, high] = frame.medBands;
    const t = frame.drift * 0.15;
    const dt = Math.min(frame.dt, 1 / 30);

    // Three nozzles wander on slow Lissajous paths and pour along their direction of travel,
    // each one as much as its band is playing. They only nudge the water; beats move it.
    const nozzles: { role: number; level: number; phase: number; speed: number }[] = [
      { role: 1, level: bass, phase: 0, speed: 1 },
      { role: 2, level: mid, phase: 2.1, speed: 1.3 },
      { role: 3, level: high, phase: 4.2, speed: 1.7 },
    ];
    for (const n of nozzles) {
      const a = t * n.speed + n.phase;
      const x = 0.5 + 0.36 * Math.sin(a * 0.71 + n.phase);
      const y = 0.5 + 0.34 * Math.sin(a * 0.53 + n.phase * 1.7);
      // Direction of travel (the derivative of the path above).
      let dx = 0.36 * 0.71 * Math.cos(a * 0.71 + n.phase);
      let dy = 0.34 * 0.53 * Math.cos(a * 0.53 + n.phase * 1.7);
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      // A trickle even in silence, so the water never goes still.
      const level = 0.08 + n.level * 0.92;
      const kick = f.onBeat && n.role === 1 ? 500 + f.bass * 900 : 0;
      const force = 25 + level * 70 + kick;
      const ink = level * dt * 6;
      const c = this.color(frame, n.role, 1);
      this.splats.push({ x, y, dx: dx * force, dy: dy * force, color: [c[0] * ink, c[1] * ink, c[2] * ink], radius: 0.0012 + level * 0.0015 });
    }

    // Beats: bursts from a random spot, the size of the kick.
    if (f.onBeat) {
      const role = [1, 3, 2, 4, 1, 2][this.burstTurn++ % 6];
      const x = 0.15 + Math.random() * 0.7;
      const y = 0.15 + Math.random() * 0.7;
      const ang = Math.random() * Math.PI * 2;
      const force = 600 + f.bass * 1000;
      const ink = 0.55 + f.bass * 0.5;
      const c = this.color(frame, role, role === 4 ? 0.7 : 1);
      this.splats.push({
        x,
        y,
        dx: Math.cos(ang) * force,
        dy: Math.sin(ang) * force,
        color: [c[0] * ink, c[1] * ink, c[2] * ink],
        radius: 0.0018 + f.bass * 0.0025,
      });
    }
  }

  private applySplats(r: Renderer, vel: DoubleTarget, dye: DoubleTarget, simTexel: [number, number], dyeTexel: [number, number], aspect: number) {
    while (this.splats.length) {
      const batch = this.splats.splice(0, MAX_SPLATS);
      const pos = new Float32Array(MAX_SPLATS * 4);
      const force = new Float32Array(MAX_SPLATS * 4);
      const ink = new Float32Array(MAX_SPLATS * 4);
      batch.forEach((s, i) => {
        pos.set([s.x, s.y, 0, 0], i * 4);
        // The push is a bit wider than the ink, so the ink gets carried, not just shoved.
        force.set([s.dx, s.dy, 0, s.radius * 1.6], i * 4);
        ink.set([...s.color, s.radius], i * 4);
      });
      const gl = r.gl;
      const p = this.progs.splat.use();
      p.f('uAspect', aspect).i('uCount', batch.length);
      gl.uniform4fv(p.loc('uSplat[0]'), pos);

      p.tex('uTarget', 1, vel.read.tex);
      gl.uniform4fv(p.loc('uValue[0]'), force);
      this.pass(r, p, vel.write, simTexel);
      this.swap('vel');
      [vel.read, vel.write] = [vel.write, vel.read];

      p.tex('uTarget', 1, dye.read.tex);
      gl.uniform4fv(p.loc('uValue[0]'), ink);
      this.pass(r, p, dye.write, dyeTexel);
      this.swap('dye');
      [dye.read, dye.write] = [dye.write, dye.read];
    }
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    const aspect = target.w / target.h;
    const grid = (n: number): [number, number] => (aspect >= 1 ? [Math.round(n * aspect), n] : [n, Math.round(n / aspect)]);
    const [sw, sh] = grid(SIM_SIZE);
    const [dw, dh] = grid(Math.min(DYE_SIZE, Math.min(target.w, target.h)));
    const simTexel: [number, number] = [1 / sw, 1 / sh];
    const dyeTexel: [number, number] = [1 / dw, 1 / dh];

    // A resize gives fresh, empty textures: seed them again.
    const size = `${sw}x${sh}:${dw}x${dh}`;
    if (size !== this.size) {
      this.size = size;
      this.seeded = false;
    }

    const vel = this.pair(r, 'vel', sw, sh);
    const dye = this.pair(r, 'dye', dw, dh);
    const press = this.pair(r, 'press', sw, sh);
    const curl = r.target('fluid-curl', sw, sh);
    const div = r.target('fluid-div', sw, sh);
    const dt = Math.min(frame.dt, 1 / 30);
    const P = this.progs;

    if (!this.seeded) {
      this.seeded = true;
      for (let i = 0; i < 5; i++) {
        const ang = Math.random() * Math.PI * 2;
        const c = this.color(frame, 1 + (i % 3), 0.8);
        this.splats.push({ x: 0.2 + Math.random() * 0.6, y: 0.2 + Math.random() * 0.6, dx: Math.cos(ang) * 400, dy: Math.sin(ang) * 400, color: c, radius: 0.004 });
      }
    }
    this.queueMusic(frame);
    this.applySplats(r, vel, dye, simTexel, dyeTexel, aspect);

    // Curl and vorticity confinement: the highs make the swirls finer and livelier.
    P.curl.use().tex('uVelocity', 1, vel.read.tex);
    this.pass(r, P.curl, curl, simTexel);

    P.vorticity
      .use()
      .tex('uVelocity', 1, vel.read.tex)
      .tex('uCurl', 2, curl.tex)
      .f('uStrength', 5 + frame.medBands[2] * 8)
      .f('uDt', dt);
    this.pass(r, P.vorticity, vel.write, simTexel);
    this.swap('vel');
    [vel.read, vel.write] = [vel.write, vel.read];

    P.divergence.use().tex('uVelocity', 1, vel.read.tex);
    this.pass(r, P.divergence, div, simTexel);

    // Keep part of last frame's pressure as the starting guess.
    P.scale.use().tex('uTarget', 1, press.read.tex).f('uValue', PRESSURE_DECAY);
    this.pass(r, P.scale, press.write, simTexel);
    this.swap('press');
    [press.read, press.write] = [press.write, press.read];

    P.pressure.use().tex('uDivergence', 2, div.tex);
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      P.pressure.tex('uPressure', 1, press.read.tex);
      this.pass(r, P.pressure, press.write, simTexel);
      this.swap('press');
      [press.read, press.write] = [press.write, press.read];
    }

    P.gradient.use().tex('uPressure', 1, press.read.tex).tex('uVelocity', 2, vel.read.tex);
    this.pass(r, P.gradient, vel.write, simTexel);
    this.swap('vel');
    [vel.read, vel.write] = [vel.write, vel.read];

    // Self-advection of the velocity, then the dye rides on it.
    P.advect
      .use()
      .tex('uVelocity', 1, vel.read.tex)
      .tex('uSource', 2, vel.read.tex)
      .f('uSimTexel', ...simTexel)
      .f('uDt', dt)
      .f('uDissipation', VELOCITY_DISSIPATION);
    this.pass(r, P.advect, vel.write, simTexel);
    this.swap('vel');
    [vel.read, vel.write] = [vel.write, vel.read];

    // Ink lingers longer in quiet passages and clears faster when the song is busy.
    P.advect
      .use()
      .tex('uVelocity', 1, vel.read.tex)
      .tex('uSource', 2, dye.read.tex)
      .f('uDissipation', 0.65 + frame.slowEnergy * 0.5);
    this.pass(r, P.advect, dye.write, dyeTexel);
    this.swap('dye');
    [dye.read, dye.write] = [dye.write, dye.read];

    r.bindTarget(target);
    r.common(this.show.use(), frame, target.w, target.h)
      .tex('uDye', 1, dye.read.tex)
      .f('uDyeTexel', ...dyeTexel);
    r.drawFullscreen();
  }
}
