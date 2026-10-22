import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// Standing by a lake at night, looking up at the aurora. The curtains are a real volume: the
// ray climbs through stacked layers of sky, and each layer shows the same folded "footprint"
// (a contour line of slow noise), so the curtains stand upright with vertical rays and recede
// in perspective toward the horizon. Like the real thing they're brightest at their lower edge
// and fade upward into another color (green oxygen low, red oxygen high, mapped to the palette).

const FS = /* glsl */ `
const float HORIZON = 0.3;   // screen height of the horizon
const int STEPS = 48;
const float BOTTOM = 1.0;    // lowest layer of the curtains (world units above the eye)
const float TOP = 5.5;

uniform float uPulse;        // a band of light that sweeps across the sky every few beats
uniform float uPulseFront;
uniform float uPulseDir;

// Wanders around primary -> accent -> secondary.
vec3 paletteCycle(float h) {
  h = fract(h) * 3.0;
  if (h < 1.0) return mix(PRIMARY, ACCENT, smoothstep(0.0, 1.0, h));
  if (h < 2.0) return mix(ACCENT, SECONDARY, smoothstep(1.0, 2.0, h));
  return mix(SECONDARY, PRIMARY, smoothstep(2.0, 3.0, h));
}

float tfbm(vec2 p) {
  return tnoise(p) * 0.55 + tnoise(p * 2.1 + 13.7) * 0.3 + tnoise(p * 4.3 + 41.2) * 0.15;
}

vec3 aurora(vec3 rd, float t) {
  vec3 m = uMedBands;
  vec3 acc = vec3(0.0);
  float dh = (TOP - BOTTOM) / float(STEPS);
  // Fixed per-pixel dither: hides the layer steps without adding flicker.
  float jitter = hash21(gl_FragCoord.xy);
  float az = rd.x / rd.z;
  float pulse = uPulse * exp(-pow((az * uPulseDir - uPulseFront) * 2.2, 2.0));
  // Bass makes the curtains taller, highs make the rays shimmer faster.
  float falloff = 3.4 - m.x * 1.6;
  float shimmer = uTime * (0.3 + m.z * 1.6);

  for (int i = 0; i < STEPS; i++) {
    float h = BOTTOM + (float(i) + jitter) * dh;
    float dist = h / rd.y;
    if (dist > 70.0) break;
    vec2 xz = rd.xz * dist + vec2(t * 2.0, t * 5.0);
    vec2 q = xz * 0.22;

    // Footprint: a contour of slow noise, folded harder by the mids.
    vec2 warp = vec2(tfbm(q * 0.6 + vec2(t, 0.0)), tfbm(q * 0.6 + vec2(5.2, -t))) - 0.5;
    float n = tfbm(q + warp * (0.9 + m.y * 1.6) + vec2(0.0, t * 0.3));
    float width = 0.03 + 0.015 * tnoise(q * 3.0);
    float curtain = smoothstep(width, 0.0, abs(n - 0.5));
    // A second, fainter arc running alongside.
    curtain += 0.45 * smoothstep(width * 0.8, 0.0, abs(n - 0.63));
    if (curtain < 0.001) continue;

    // The lower edge isn't level; it rides up and down along the curtain.
    float base = BOTTOM + 0.6 * tnoise(q * 2.0 + t);
    float above = h - base;
    if (above < 0.0) continue;
    float hn = above / (TOP - BOTTOM);
    float profile = exp(-hn * falloff) * smoothstep(0.0, 0.08, above);

    // Rays: fine streaks along the curtain, the same at every height so they stand vertical.
    float rays = 0.5 + 0.5 * tnoise(xz * 3.0 + vec2(shimmer, -shimmer * 0.7));
    rays *= 0.75 + 0.25 * tnoise(xz * 9.0 - shimmer);

    // Each curtain has its own color, which keeps drifting; brighter music leans to the accent.
    vec3 body = paletteCycle(tnoise(q * 0.35 + 7.0) * 1.6 + t * 0.12 + uCentroid * 0.3);
    vec3 col = mix(body, SECONDARY * 1.1 + PRIMARY * 0.1, smoothstep(0.08, 0.7, hn));
    col = mix(col, HIGHLIGHT, 0.35 * exp(-above * 8.0));
    float fade = exp(-dist * 0.05);
    acc += col * curtain * profile * rays * fade * (1.0 + pulse * 2.5);
  }
  return acc * dh * (0.9 + m.x * 0.7 + uSlowEnergy * 0.6);
}

// Ridged noise for mountain silhouettes: sharp peaks, rounded valleys.
float ridge(float x, float seed) {
  float h = 0.0, a = 0.5, f = 1.0;
  for (int i = 0; i < 5; i++) {
    h += a * (1.0 - abs(vnoise(vec2(x * f, seed)) * 2.0 - 1.0));
    f *= 2.1;
    a *= 0.45;
  }
  return h;
}

vec3 stars(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = hash21(cell);
  if (h > 0.12) return vec3(0.0);
  float d = length(f - (hash22(cell) - 0.5) * 0.7);
  float tw = 0.6 + 0.4 * sin(uTime * (1.0 + h * 8.0) + h * 50.0);
  return HIGHLIGHT * smoothstep(0.08, 0.0, d) * tw * (0.4 + h * 5.0);
}

// Everything above the horizon, for a direction and its screen position.
vec3 sky(vec3 rd, vec2 p, float t, out vec3 glow) {
  vec3 c = mix(BG * 0.9 + SECONDARY * 0.03, BG * 0.35, smoothstep(0.0, 0.8, p.y));
  c += stars(p * 160.0) * smoothstep(0.0, 0.15, p.y);
  glow = aurora(rd, t);
  return c + glow;
}

void main() {
  vec2 p = (gl_FragCoord.xy - vec2(0.5 * uRes.x, HORIZON * uRes.y)) / uRes.y;
  float t = uDrift * 0.05;
  float px = 1.5 / uRes.y;
  bool lake = p.y < 0.0;

  // The lake mirrors the sky, with ripples that the bass stirs a little.
  vec2 sp = p;
  if (lake) {
    float ripple = sin(p.y * 220.0 / (0.2 - p.y) + uTime * 1.3) * (0.002 + uMedBands.x * 0.002);
    sp = vec2(p.x + ripple, -p.y + ripple * 0.5);
  }
  // Camera looks level; slowly pans across the sky.
  vec3 rd = normalize(vec3(sp.x, max(sp.y, 0.002), 0.7));
  rd.xz = rot(sin(uDrift * 0.011) * 0.35) * rd.xz;

  vec3 glow;
  vec3 col = sky(rd, sp, t, glow);
  // A soft wash of aurora light low on the sky, so the mountains stand out against it.
  vec3 haze = (PRIMARY * 0.06 + SECONDARY * 0.04) * (0.4 + uSlowEnergy) * exp(-sp.y * 6.0);
  col += haze;

  // Two mountain ranges: the far one catches a little of the aurora light.
  float x = sp.x + sin(uDrift * 0.011) * 0.4;
  float far = 0.025 + ridge(x * 2.4 + 3.0, 1.0) * 0.07;
  float near = 0.008 + ridge(x * 1.3 + 11.0, 4.0) * 0.06;
  vec3 farCol = BG * 0.45 + haze * 2.0 + SECONDARY * 0.02;
  col = mix(farCol, col, smoothstep(far - px, far + px, sp.y));
  col = mix(BG * 0.18, col, smoothstep(near - px, near + px, sp.y));

  if (lake) {
    float depth = -p.y;
    col *= 0.42 * (1.0 - depth * 1.2);
    // Glints of the aurora on the ripples.
    col += glow * 0.25 * pow(max(0.0, sin(p.y * 900.0 / (0.25 + depth) + p.x * 4.0 + uTime)), 12.0) * exp(-depth * 4.0);
    // A dark shoreline right at the horizon.
    col *= smoothstep(0.0, 0.012, depth) * 0.6 + 0.4;
  }
  fragColor = vec4(col, 1.0);
}`;

export class AuroraScene implements Scene {
  readonly id = 'aurora';
  readonly scale = 0.5;
  private prog!: Program;
  private pulseStart = -100;
  private pulseDir = 1;
  private beats = 0;

  init(r: Renderer) {
    this.prog = r.sceneProgram(FS);
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    // Every fourth beat a band of light runs along the curtains, alternating direction.
    if (frame.features.onBeat && ++this.beats % 4 === 0) {
      this.pulseStart = frame.time;
      this.pulseDir = -this.pulseDir;
    }
    const age = frame.time - this.pulseStart;
    const front = -1.4 + age * 1.3;
    const pulse = age < 3 ? Math.exp(-age * 0.9) * (0.5 + frame.medBands[0] * 0.8) : 0;

    r.bindTarget(target);
    r.common(this.prog.use(), frame, target.w, target.h).f('uPulse', pulse).f('uPulseFront', front).f('uPulseDir', this.pulseDir);
    r.drawFullscreen();
  }
}
