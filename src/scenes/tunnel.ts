import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// Flying through a tunnel of irregular contour lines that bends as it goes.
// Rings and the lengthwise "spokes" come from the same function, so they always form one mesh.

const RINGS = 72;
const SEGMENTS = 480;
const SPOKES = 28;
const SPACING = 0.34;

/** Where the tunnel's center is at absolute depth z. Mirrored in TypeScript below. */
const PATH_GLSL = /* glsl */ `
vec2 pathAt(float z) {
  return vec2(sin(z * 0.045) * 1.7 + sin(z * 0.11 + 1.3) * 0.65,
              cos(z * 0.037) * 1.25 + sin(z * 0.093 + 2.1) * 0.55);
}`;

function pathAt(z: number): [number, number] {
  return [Math.sin(z * 0.045) * 1.7 + Math.sin(z * 0.11 + 1.3) * 0.65, Math.cos(z * 0.037) * 1.25 + Math.sin(z * 0.093 + 2.1) * 0.55];
}

const VS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uDrift;
uniform float uTravel;
uniform float uRoll;
uniform float uMode;  // 0 = rings, 1 = spokes
uniform float uBeat;
uniform float uHigh;
uniform float uSlowEnergy;
uniform vec3 uPal[5];
uniform sampler2D uAudio;
out vec3 vColor;

#define TAU 6.28318530718
const float RINGS = ${RINGS}.0;
const float SEGMENTS = ${SEGMENTS}.0;
const float SPOKES = ${SPOKES}.0;
const float SPACING = ${SPACING};

float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
${PATH_GLSL}

void main() {
  float slot = uMode < 0.5 ? float(gl_InstanceID) : float(gl_VertexID);
  float a = uMode < 0.5 ? float(gl_VertexID) / SEGMENTS * TAU : (float(gl_InstanceID) + 0.5) / SPOKES * TAU;
  // Spokes wander a little instead of running dead straight.
  if (uMode > 0.5) a += sin(slot * 0.35 + float(gl_InstanceID) * 1.7 + uDrift * 0.4) * 0.08;

  float phase = fract(uTravel / SPACING);
  float zView = (slot + 1.0 - phase) * SPACING;
  float zAbs = uTravel + zView;
  vec2 dir = vec2(cos(a), sin(a));

  // Irregular outline: noise sampled around a circle is seamless, and it slides along the tunnel.
  float n = vnoise(dir * 1.3 + vec2(zAbs * 0.07, -zAbs * 0.05)) + 0.5 * vnoise(dir * 3.1 + vec2(-zAbs * 0.11, zAbs * 0.08));
  float rad = 1.0 + (n - 0.75) * 0.75;
  rad *= 1.0 + 0.22 * sin(2.0 * a + zAbs * 0.05 + uDrift * 0.1);

  // Near rings listen to the spectrum (mirrored so there's no seam at a = 0).
  float near = 1.0 - slot / RINGS;
  float s = texture(uAudio, vec2(abs(fract(a / TAU + 0.25) * 2.0 - 1.0) * 0.75 + 0.02, 0.25)).r;
  rad *= 1.0 + s * 0.3 * near * near;
  rad += sin(a * 46.0 + zAbs * 3.0 + uTime * 2.5) * 0.012 * (0.2 + uHigh * 1.5) * near;

  // Look along the path: subtract the camera position and the current heading,
  // so only the curvature ahead shows up as the tunnel bending away.
  vec2 here = pathAt(uTravel);
  vec2 heading = (pathAt(uTravel + 1.0) - pathAt(uTravel - 1.0)) * 0.5;
  vec2 xy = pathAt(zAbs) - here - heading * zView + dir * rad;
  xy = rot(uRoll) * xy;

  float aspect = uRes.x / uRes.y;
  float focal = 1.15;
  gl_Position = zView > 0.12 ? vec4(xy.x * focal / aspect, xy.y * focal, 0.0, zView) : vec4(2.0, 2.0, 2.0, 1.0);

  float fog = pow(near, 1.4);
  float fadeIn = smoothstep(0.12, 0.9, zView);
  vec3 col = mix(uPal[2], uPal[1], smoothstep(0.15, 0.75, near));
  col = mix(col, uPal[3], s * near);
  float bright = (0.35 + s * 1.2 + uSlowEnergy * 0.4) * fog * fadeIn;
  // A flash that rolls down the tunnel on each beat.
  bright += uBeat * exp(-pow((1.0 - uBeat) * RINGS - slot, 2.0) / 30.0) * 1.6;
  if (uMode > 0.5) bright *= 0.1 * smoothstep(0.0, 0.5, near);
  vColor = col * bright;
}`;

const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() { fragColor = vec4(vColor, 1.0); }`;

const BG_FS = /* glsl */ `
uniform vec2 uExit;
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 c = BG * 0.6;
  float d = length(uv - uExit);
  // Glow at the far end of the tunnel.
  c += mix(SECONDARY, PRIMARY, 0.4) * exp(-d * 4.0) * (0.18 + uSlowEnergy * 0.35 + uBass * 0.25);
  fragColor = vec4(c, 1.0);
}`;

export class TunnelScene implements Scene {
  readonly id = 'tunnel';
  readonly scale = 1;
  private lines!: Program;
  private bg!: Program;
  private travel = 0;

  init(r: Renderer) {
    this.lines = r.program(VS, LINE_FS);
    this.bg = r.sceneProgram(BG_FS);
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    const gl = r.gl;
    const f = frame.features;
    this.travel += frame.dt * (1.4 + frame.slowEnergy * 3.2 + f.beat * 0.9);
    const roll = frame.drift * 0.06 + Math.sin(frame.drift * 0.13) * 0.5;

    // Where the far end lands on screen, for the glow behind it.
    const zView = RINGS * SPACING;
    const here = pathAt(this.travel);
    const ahead = pathAt(this.travel + 1);
    const behind = pathAt(this.travel - 1);
    const far = pathAt(this.travel + zView);
    let ex = far[0] - here[0] - ((ahead[0] - behind[0]) / 2) * zView;
    let ey = far[1] - here[1] - ((ahead[1] - behind[1]) / 2) * zView;
    // Same rotation as GLSL's rot(): mat2(c, -s, s, c) is column-major.
    [ex, ey] = [ex * Math.cos(roll) + ey * Math.sin(roll), -ex * Math.sin(roll) + ey * Math.cos(roll)];
    const focal = 1.15;

    r.bindTarget(target);
    r.common(this.bg.use(), frame, target.w, target.h).f('uExit', (ex * focal) / zView / 2, (ey * focal) / zView / 2);
    r.drawFullscreen();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const p = r.common(this.lines.use(), frame, target.w, target.h).f('uTravel', this.travel).f('uRoll', roll);
    p.f('uMode', 0);
    gl.drawArraysInstanced(gl.LINE_STRIP, 0, SEGMENTS + 1, RINGS);
    p.f('uMode', 1);
    gl.drawArraysInstanced(gl.LINE_STRIP, 0, RINGS, SPOKES);
    gl.disable(gl.BLEND);
  }
}
