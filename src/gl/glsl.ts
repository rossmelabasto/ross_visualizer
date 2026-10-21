// Shared GLSL. Every scene fragment shader is PRELUDE + its own body.
// GLSL ES 3.00 on purpose: the same code runs on OpenGL ES 3 (Android) later.

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  // One oversized triangle covers the screen; no buffers needed.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const PRELUDE = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform float uFlow;      // time that runs faster when the music is louder
uniform float uBass;
uniform float uLowMid;
uniform float uMid;
uniform float uHigh;
uniform float uEnergy;
uniform float uBeat;      // 1 on a beat, decays
uniform float uBeatCount;
uniform float uCentroid;
uniform float uFlux;
uniform float uBpm;
uniform vec3 uPal[5];     // bg, primary, secondary, accent, highlight (linear RGB)
uniform sampler2D uAudio; // row 0: log spectrum, row 1: waveform

#define PI 3.14159265359
#define TAU 6.28318530718
#define BG uPal[0]
#define PRIMARY uPal[1]
#define SECONDARY uPal[2]
#define ACCENT uPal[3]
#define HIGHLIGHT uPal[4]

float spectrum(float x) { return texture(uAudio, vec2(clamp(x, 0.0, 1.0), 0.25)).r; }
float waveform(float x) { return texture(uAudio, vec2(clamp(x, 0.0, 1.0), 0.75)).r * 2.0 - 1.0; }

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p, int octaves) {
  float s = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    s += a * vnoise(p);
    p = r * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// Walk the palette as a gradient: bg -> secondary -> primary -> accent -> highlight.
vec3 paletteRamp(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  vec3 c = mix(BG, SECONDARY, smoothstep(0.0, 1.0, t));
  c = mix(c, PRIMARY, smoothstep(1.0, 2.0, t));
  c = mix(c, ACCENT, smoothstep(2.0, 3.0, t));
  return mix(c, HIGHLIGHT, smoothstep(3.0, 4.0, t));
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;
