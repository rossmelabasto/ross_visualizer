import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';

// A volumetric nebula: the camera drifts around a cloud of glowing gas lit by a star at its
// heart, and each pixel marches a ray through it. Gas emits light and dims what's behind it;
// dust only absorbs, so it shows up as dark lanes against the glow. The gas is hottest (the
// cover's highlight color) near the star and cools through primary to secondary at the rim.
//
// Music, without flashes: the bass swells the gas, the mids churn it, the highs light up the
// filaments and make the stars twinkle. The shape itself keeps evolving with the drift clock.

const FS = /* glsl */ `
const int STEPS = 48;
const float RADIUS = 3.2;

uniform vec3 uCamPos;
uniform vec3 uCamTarget;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// Stars fixed to directions, so they wheel past correctly as the camera orbits.
vec3 starfield(vec3 rd) {
  vec3 c = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    float scale = i == 0 ? 90.0 : 220.0;
    vec3 p = rd * scale;
    vec3 cell = floor(p);
    float h = hash31(cell + float(i) * 17.0);
    if (h > (i == 0 ? 0.05 : 0.09)) continue;
    vec3 off = vec3(hash31(cell + 3.1), hash31(cell + 7.7), hash31(cell + 11.3)) * 0.6 + 0.2;
    float d = length(fract(p) - off);
    float tw = 0.65 + 0.35 * sin(uTime * (1.0 + h * 30.0) + h * 90.0) * (0.4 + uMedBands.z * 1.4);
    vec3 tint = mix(HIGHLIGHT, ACCENT, hash31(cell + 5.0) * 0.5);
    c += tint * smoothstep(i == 0 ? 0.12 : 0.08, 0.0, d) * tw * (i == 0 ? 1.6 : 0.8);
  }
  return c;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 m = uMedBands;
  float t = uDrift * 0.035;

  vec3 ro = uCamPos;
  vec3 fw = normalize(uCamTarget - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.5 + rt * uv.x + up * uv.y);

  vec3 col = BG * 0.25 + starfield(rd);

  // Only march where the ray crosses the nebula's bounding sphere.
  float b = dot(ro, rd);
  float h = b * b - (dot(ro, ro) - RADIUS * RADIUS);
  if (h > 0.0) {
    float sh = sqrt(h);
    float t0 = max(-b - sh, 0.0);
    float t1 = -b + sh;
    float dt = (t1 - t0) / float(STEPS);
    float s = t0 + dt * hash21(gl_FragCoord.xy);
    float tClosest = -b;
    float coreT = 1.0;
    vec3 sum = vec3(0.0);
    float T = 1.0;
    // Bass lowers the threshold: more of the cloud lights up.
    float thr = 0.4 - m.x * 0.09 - uSlowBass * 0.04;
    float coreLight = 0.7 + uSlowBass * 0.8;

    for (int i = 0; i < STEPS; i++) {
      vec3 p = ro + rd * s;
      float r = length(p) / RADIUS;
      vec3 q = p * 1.15 + vec3(t * 0.6, -t * 0.3, t);
      // Mids churn the gas by warping where the noise is read.
      vec2 w = vec2(fbm3(q * 0.8 + 3.1, 2), fbm3(q * 0.8 + 9.7, 2)) - 0.5;
      q.xy += w * (1.3 + m.y * 1.4);
      float n = fbm3(q, 5);
      // Thin out toward the rim so the edges are wispy instead of a sphere.
      float field = n - r * r * 0.5;
      float gas = smoothstep(thr, thr + 0.09, field);
      float dust = smoothstep(0.47, 0.6, fbm3(p * 1.6 + vec3(20.0, -t * 0.5, 4.0), 3)) * smoothstep(1.0, 0.45, r);

      if (gas > 0.001) {
        vec3 c = mix(HIGHLIGHT, PRIMARY, smoothstep(0.0, 0.2, r));
        c = mix(c, SECONDARY, smoothstep(0.35, 0.85, r));
        // Regions of the cloud glow in different colors, like the gases in Hubble photos.
        c = mix(c, SECONDARY * 1.2 + ACCENT * 0.15, smoothstep(0.42, 0.62, noise3(q * 0.35 + 50.0)) * 0.75);
        // The densest ridges are filaments; the highs make them glow in the accent color.
        c += ACCENT * smoothstep(thr + 0.15, thr + 0.3, field) * (0.3 + m.z * 1.6);
        float light = 0.25 + coreLight / (1.0 + r * r * 30.0);
        sum += T * c * gas * light * dt * 1.7;
      }
      T *= exp(-(gas * 0.9 + dust * 3.0) * dt);
      if (s < tClosest) coreT = T;
      if (T < 0.02) break;
      s += dt;
      if (s > t1) break;
    }
    col = col * T + sum;

    // The star at the heart, seen through whatever gas and dust is in front of it.
    float dc = length(ro + rd * max(tClosest, 0.0));
    float star = exp(-dc * 14.0) * 0.6 + 0.003 / (dc * dc + 0.004);
    col += mix(HIGHLIGHT, PRIMARY, 0.25) * star * coreT * coreLight;
  }
  fragColor = vec4(col, 1.0);
}`;

export class NebulaScene implements Scene {
  readonly id = 'nebula';
  readonly scale = 0.6;
  private prog!: Program;

  init(r: Renderer) {
    this.prog = r.sceneProgram(FS);
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    // A slow orbit that also breathes in and out and tilts, so the view keeps changing.
    const d = frame.drift;
    const ang = d * 0.03;
    const dist = 4.8 + Math.sin(d * 0.021) * 1.0;
    const tilt = Math.sin(d * 0.017) * 0.45;
    const cam: [number, number, number] = [Math.sin(ang) * Math.cos(tilt) * dist, Math.sin(tilt) * dist, Math.cos(ang) * Math.cos(tilt) * dist];
    // Look slightly off-center so the core isn't always dead in the middle.
    const look: [number, number, number] = [Math.sin(d * 0.013) * 0.9, Math.cos(d * 0.011) * 0.5, 0];

    r.bindTarget(target);
    r.common(this.prog.use(), frame, target.w, target.h)
      .f('uCamPos', ...cam)
      .f('uCamTarget', ...look);
    r.drawFullscreen();
  }
}
