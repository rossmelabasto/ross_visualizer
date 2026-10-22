import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// Layers of glowing gas at different depths drifting with parallax, cut by dark dust lanes,
// over a field of twinkling stars.
const FS = /* glsl */ `
float stars(vec2 p, float density, float tw) {
  vec2 cell = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = hash21(cell);
  if (h > density) return 0.0;
  vec2 off = (hash22(cell) - 0.5) * 0.7;
  float d = length(f - off);
  float size = 0.05 + 0.08 * hash21(cell + 7.1);
  float twinkle = 0.6 + 0.4 * sin(uTime * (1.5 + h * 6.0) + h * 40.0) * tw;
  return smoothstep(size, 0.0, d) * twinkle;
}

// One cloud layer: domain-warped fbm shaped into wisps.
float gas(vec2 p, float t) {
  vec2 q = vec2(fbm(p + vec2(0.0, t), 5), fbm(p + vec2(3.1, 1.7) - t, 5));
  float f = fbm(p + 2.6 * q + vec2(t * 0.5, -t * 0.3), 5);
  return smoothstep(0.42, 0.95, f) * (0.6 + 0.9 * q.x);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uDrift * 0.05;
  vec2 drift = vec2(t * 0.9, t * 0.35);

  vec3 col = BG * 0.2;

  // Stars at two depths; the highs make them twinkle harder.
  col += HIGHLIGHT * stars(uv * 60.0 + drift * 4.0, 0.12, 0.4 + uHigh * 1.5) * 0.9;
  col += mix(HIGHLIGHT, ACCENT, 0.4) * stars(uv * 22.0 + drift * 8.0, 0.08, 0.3 + uHigh) * 1.3;

  // Back, middle and front gas, each with its own scale, speed and color.
  float g1 = gas(uv * 1.1 + drift * 0.6, t * 0.7);
  float g2 = gas(uv * 1.7 + drift * 1.2 + 11.3, t);
  float g3 = gas(uv * 2.6 + drift * 2.1 + 27.9, t * 1.4);

  // Big, slow masks decide where the clouds are, leaving real empty space between them.
  float m1 = smoothstep(0.3, 0.62, fbm(uv * 0.55 + drift * 0.25 + 5.0, 3));
  float m2 = smoothstep(0.32, 0.65, fbm(uv * 0.8 - drift * 0.2 + 19.0, 3));
  vec3 neb = SECONDARY * g1 * m1 * 1.1;
  neb += PRIMARY * g2 * m2 * (0.9 + uSlowEnergy * 0.7);
  neb += ACCENT * g3 * g2 * m1 * (0.8 + uMid * 0.9);

  // A bright core that swells with the bass.
  vec2 corePos = vec2(sin(t * 0.8), cos(t * 0.6)) * 0.15;
  float core = exp(-length(uv - corePos) * (3.2 - uSlowBass * 1.2));
  neb += mix(PRIMARY, HIGHLIGHT, 0.5) * core * (0.2 + uBass * 0.6 + uBeat * 0.25) * (0.3 + g2 * m2);

  // Dust lanes eat the light in front.
  float dust = smoothstep(0.45, 0.85, fbm(uv * 2.2 - drift * 1.6 + 41.0, 5));
  neb *= 1.0 - dust * 0.85;
  col *= 1.0 - dust * 0.6;

  // Gas glows: push it into HDR so the bloom picks it up.
  col += neb * (1.8 + uEnergy * 0.7);
  fragColor = vec4(col, 1.0);
}`;

export class NebulaScene implements Scene {
  readonly id = 'nebula';
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
