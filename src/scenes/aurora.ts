import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// Curtains of light over a mountain ridge, mirrored in a still lake.
const FS = /* glsl */ `
const float HORIZON = 0.27;

float stars(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = hash21(cell);
  if (h > 0.1) return 0.0;
  float d = length(f - (hash22(cell) - 0.5) * 0.7);
  return smoothstep(0.09, 0.0, d) * (0.5 + 0.5 * sin(uTime * (1.0 + h * 9.0) + h * 50.0));
}

// A color that wanders around the palette (primary -> accent -> secondary -> primary).
vec3 paletteCycle(float h) {
  h = fract(h) * 3.0;
  if (h < 1.0) return mix(PRIMARY, ACCENT, smoothstep(0.0, 1.0, h));
  if (h < 2.0) return mix(ACCENT, SECONDARY, smoothstep(1.0, 2.0, h));
  return mix(SECONDARY, PRIMARY, smoothstep(2.0, 3.0, h));
}

// Light of all curtains at a point of the sky (x in aspect units, y from 0 at the horizon).
// Everything here follows smoothed values: the curtains breathe with the song, they don't flicker.
vec3 aurora(float x, float y, float t) {
  vec3 m = uMedBands;
  vec3 light = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float fold = sin(x * (1.8 + fi * 0.6) + t * (0.5 + fi * 0.15) + fi * 2.0 + fbm(vec2(x * 1.1 + fi * 5.0, t * 0.2), 3) * 4.0);
    fold *= 0.8 + m.y * 0.8;
    // The lower edge is a long, slowly swinging ribbon.
    float bottom = 0.08 + fi * 0.08 + fbm(vec2(x * 0.7 + t * 0.1 * (fi + 1.0), fi * 3.1), 3) * 0.3 + sin(x * 1.3 + t * 0.3 + fi * 2.0) * 0.06 + fold * 0.03;
    float sx = fract(x * 0.18 + fi * 0.31 + 0.5);
    float height = 0.14 + m.x * 0.22 + spectrum(abs(sx * 2.0 - 1.0) * 0.6 + 0.04) * 0.12 + fi * 0.04;
    float yy = y - bottom;
    if (yy < -0.05) continue;
    // Thin vertical rays that slide along with the folds.
    float rays = 0.45 + 0.55 * vnoise(vec2(x * 38.0 + fold * 3.0 + t * 1.2, t * 0.6 + fi * 10.0));
    rays *= 0.7 + 0.3 * vnoise(vec2(x * 90.0 + t * 2.0, t * (1.0 + m.z * 2.0) + fi));
    float body = smoothstep(-0.01, 0.015, yy) * exp(-max(yy, 0.0) / height);
    float edge = exp(-abs(yy) * 55.0);
    // Separate curtains with dark gaps between them, drifting sideways.
    float mask = smoothstep(0.3, 0.52, fbm(vec2(x * 0.45 + fi * 7.3 + t * 0.05, fi * 2.0), 3));
    float k = (body * rays + edge * 0.7) * (0.55 + 0.45 * fold) * mask;
    // Color drifts along each curtain and over time; brighter music leans toward the accent.
    vec3 base = paletteCycle(fbm(vec2(x * 0.3 + t * 0.15, fi * 4.0), 2) * 1.4 + t * 0.04 + fi * 0.33 + uCentroid * 0.25);
    vec3 c = mix(base, mix(SECONDARY, HIGHLIGHT, 0.2), smoothstep(0.0, height * 1.8, yy) * 0.7);
    light += c * k * (0.8 - fi * 0.15);
  }
  return light * (1.1 + m.y * 0.8 + uSlowEnergy * 0.5);
}

float ridge(float x) {
  return HORIZON + 0.015 + fbm(vec2(x * 1.1, 2.0), 5) * 0.11 + fbm(vec2(x * 4.0, 7.0), 3) * 0.025 - 0.03;
}

vec3 sky(vec2 uv, float aspect, float t) {
  float x = (uv.x - 0.5) * aspect;
  float y = uv.y - HORIZON;
  vec3 c = mix(mix(BG, SECONDARY, 0.12), BG * 0.5, smoothstep(0.0, 0.7, y));
  c += HIGHLIGHT * stars(uv * vec2(aspect, 1.0) * 70.0) * 0.8;
  c += aurora(x, y, t);
  return c;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  float t = uDrift * 0.06;
  float x = (uv.x - 0.5) * aspect;

  vec3 col;
  if (uv.y >= HORIZON) {
    col = sky(uv, aspect, t);
    // Mountains in front of the sky.
    float m = ridge(x);
    if (uv.y < m) col = BG * 0.25 + PRIMARY * 0.015;
  } else {
    // Lake: the sky mirrored, rippled and darkened.
    float depth = HORIZON - uv.y;
    vec2 ref = vec2(uv.x + sin(uv.y * 160.0 + uTime * 1.2) * 0.002 * (1.0 + uMedBands.x), HORIZON + depth);
    col = sky(ref, aspect, t);
    float m = ridge(x);
    if (ref.y < m) col = BG * 0.25;
    col *= 0.35 * (1.0 - depth * 1.5);
  }
  fragColor = vec4(col, 1.0);
}`;

export class AuroraScene implements Scene {
  readonly id = 'aurora';
  readonly scale = 0.5;
  private prog!: Program;

  init(r: Renderer) {
    this.prog = r.sceneProgram(FS);
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    r.bindTarget(target);
    r.common(this.prog.use(), frame, target.w, target.h);
    r.drawFullscreen();
  }
}
