// Post-processing: bright pass, separable blur and the final composite.

export const BRIGHT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uMix;
uniform float uThreshold;
void main() {
  vec3 c = mix(texture(uA, vUv).rgb, texture(uB, vUv).rgb, uMix);
  float l = max(c.r, max(c.g, c.b));
  // Soft knee so the bloom fades in instead of popping.
  float k = clamp((l - uThreshold * 0.5) / max(uThreshold, 1e-3), 0.0, 1.0);
  fragColor = vec4(c * k * k, 1.0);
}`;

export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uDir;
void main() {
  // 9-tap Gaussian using linear sampling (5 fetches).
  vec3 c = texture(uSrc, vUv).rgb * 0.2270270270;
  c += texture(uSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture(uSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  fragColor = vec4(c, 1.0);
}`;

export const POST_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uBloom;
uniform float uMix;
uniform vec2 uRes;
uniform float uTime;
uniform float uBloomAmt;
uniform float uBeat;
uniform float uTransparent;
uniform vec3 uBg;

vec3 sampleScene(vec2 uv) {
  return mix(texture(uA, uv).rgb, texture(uB, uv).rgb, uMix);
}

// ACES fitted (Stephen Hill).
vec3 aces(vec3 x) {
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  x = i * x;
  vec3 a = x * (x + 0.0245786) - 0.000090537;
  vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return clamp(o * (a / b), 0.0, 1.0);
}

vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  // Chromatic aberration that kicks in on beats.
  float ca = 0.0015 + uBeat * 0.004;
  vec3 c;
  c.r = sampleScene(uv + d * ca).r;
  c.g = sampleScene(uv).g;
  c.b = sampleScene(uv - d * ca).b;
  c += texture(uBloom, uv).rgb * uBloomAmt;

  // Exposure keeps the mid-tones where the ACES curve looks best.
  c = aces(c * 1.15);

  float vig = smoothstep(1.05, 0.25, length(d * vec2(uRes.x / uRes.y, 1.0)) * 0.9);
  float alpha = 1.0;
  if (uTransparent > 0.5) {
    alpha = clamp(max(c.r, max(c.g, c.b)) * 1.6, 0.0, 1.0);
  } else {
    c = mix(aces(uBg) * 0.6, c, mix(0.55, 1.0, vig));
  }
  c = toSrgb(c);
  c += (hash(uv * uRes + fract(uTime) * 100.0) - 0.5) / 255.0 * 2.0; // dither, kills banding
  fragColor = vec4(c * alpha, alpha);
}`;
