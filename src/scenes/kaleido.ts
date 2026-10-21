import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// The artwork folded into a kaleidoscope and pulled through a log-polar tunnel.
const FS = /* glsl */ `
uniform sampler2D uCover;
uniform sampler2D uCoverPrev;
uniform float uCoverMix;
uniform float uSegments;

vec3 cover(vec2 uv) {
  return mix(texture(uCoverPrev, uv).rgb, texture(uCover, uv).rgb, uCoverMix);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  uv *= 1.0 - uBeat * 0.06;
  float r = length(uv) + 1e-4;
  float a = atan(uv.y, uv.x) + uFlow * 0.04;

  float seg = TAU / uSegments;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);

  // log(r) turns zoom into translation: moving along it is an endless tunnel.
  float depth = -log(r) * 0.55 + uFlow * 0.07;
  vec2 tc = vec2(a / seg * 0.9 + 0.05, depth);
  tc += vec2(sin(uTime * 0.3), cos(uTime * 0.23)) * 0.04;
  tc += vec2(0.0, sin(a * 8.0 + uTime) * 0.01 * uMid);

  float split = 0.004 + uBass * 0.012;
  vec3 c = vec3(cover(tc + vec2(split, 0.0)).r, cover(tc).g, cover(tc - vec2(split, 0.0)).b);

  // Pull the image towards the palette a little so every cover still feels "graded".
  c = mix(c, paletteRamp(luma(c) * 1.1), 0.22);
  c *= 0.75 + uEnergy * 0.5 + uBeat * 0.35;

  // Spectrum drawn as a glowing ring.
  float s = spectrum(a / seg * 0.9);
  float ringR = 0.36 + uBass * 0.08;
  float ring = exp(-abs(r - ringR - s * 0.08) * 70.0) * (0.25 + s);
  c += ACCENT * ring * 1.4;

  // The vanishing point gets dark, with a glow on bass.
  c *= smoothstep(0.0, 0.22, r);
  c += PRIMARY * exp(-r * 9.0) * (0.3 + uBass * 1.2);
  fragColor = vec4(c, 1.0);
}`;

export class KaleidoScene implements Scene {
  readonly id = 'kaleido';
  readonly scale = 1;
  private prog!: Program;

  init(r: Renderer) {
    this.prog = r.sceneProgram(FS);
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    r.bindTarget(target);
    r.common(this.prog.use(), frame, target.w, target.h)
      .tex('uCover', 1, frame.cover.tex)
      .tex('uCoverPrev', 2, frame.cover.prev)
      .f('uCoverMix', frame.cover.mix)
      .f('uSegments', 6);
    r.drawFullscreen();
  }
}
