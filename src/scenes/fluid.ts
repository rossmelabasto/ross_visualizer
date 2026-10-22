import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// Domain-warped fbm (after Inigo Quilez) painted with the cover palette.
const FS = /* glsl */ `
// The shape only follows slow, smoothed values (uDrift, uSlowBass, uSlowEnergy) so it flows
// like ink; the fast ones (bass, beat, highs) only touch light and color.
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uDrift * 0.07;

  vec2 p = uv * (1.35 - uSlowBass * 0.12);
  p *= rot(t * 0.35);

  vec2 q = vec2(fbm(p + vec2(0.0, t), 4), fbm(p + vec2(5.2, 1.3) - t * 0.8, 4));
  float warp = 2.4 + uSlowEnergy * 1.4;
  vec2 w = vec2(fbm(p + warp * q + vec2(1.7, 9.2) + t * 0.6, 4), fbm(p + warp * q + vec2(8.3, 2.8) - t * 0.5, 4));
  float f = fbm(p + warp * w, 4);

  vec3 col = mix(BG, SECONDARY, smoothstep(0.3, 0.8, f));
  col = mix(col, PRIMARY, smoothstep(0.6, 1.1, length(q)) * 0.85);
  col = mix(col, ACCENT, smoothstep(0.5, 0.95, w.x) * (0.3 + uMid * 0.6));
  col = mix(col, HIGHLIGHT, pow(smoothstep(0.55, 1.0, f * w.y * 1.7), 3.0) * (0.25 + uHigh * 0.9));

  // Light: valleys stay dark, ridges glow with the music.
  float ridge = smoothstep(0.22, 0.85, f);
  col *= 0.16 + ridge * (1.05 + uEnergy * 0.45 + uBeat * 0.18);
  col += ACCENT * pow(ridge, 6.0) * uBass * 0.25;
  fragColor = vec4(col, 1.0);
}`;

export class FluidScene implements Scene {
  readonly id = 'fluid';
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
