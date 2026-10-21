import {
  type Vec3,
  deltaE,
  gamutMapOklch,
  hexToLinearRgb,
  linearRgbToOklab,
  oklabToOklch,
  oklchToLinearRgb,
  oklchToOklab,
  srgbToLinear,
} from './oklab';

/** Five roles every scene understands. Stored in OKLab so transitions interpolate perceptually. */
export interface Palette {
  bg: Vec3;
  primary: Vec3;
  secondary: Vec3;
  accent: Vec3;
  highlight: Vec3;
}

export const ROLES = ['bg', 'primary', 'secondary', 'accent', 'highlight'] as const;

interface Cluster {
  lab: Vec3;
  lch: Vec3;
  weight: number;
}

const BRAND_LIME = '#afff00';

export const BRAND_PALETTE: Palette = fromHexes(['#0a0c08', BRAND_LIME, '#8b5cf6', '#2dd4bf', '#f4ffe0']);

export function fromHexes(hexes: [string, string, string, string, string]): Palette {
  const [bg, primary, secondary, accent, highlight] = hexes.map((h) => linearRgbToOklab(hexToLinearRgb(h)));
  return { bg, primary, secondary, accent, highlight };
}

/** Palette for when there is no artwork: everything hangs off one hue, which the audio can rotate. */
export function paletteFromHue(h: number): Palette {
  const lab = (L: number, C: number, hue: number) => oklchToOklab(gamutMapOklch([L, C, hue]));
  return {
    bg: lab(0.13, 0.035, h),
    primary: lab(0.74, 0.17, h),
    secondary: lab(0.6, 0.16, h + 0.95),
    accent: lab(0.84, 0.18, h - 0.75),
    highlight: lab(0.96, 0.03, h),
  };
}

export function paletteToLinearRgb(p: Palette): Float32Array {
  const out = new Float32Array(15);
  ROLES.forEach((role, i) => {
    const rgb = oklchToLinearRgb(oklabToOklch(p[role]));
    out.set(rgb, i * 3);
  });
  return out;
}

export function lerpPalette(a: Palette, b: Palette, t: number): Palette {
  const mix = (x: Vec3, y: Vec3): Vec3 => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  return {
    bg: mix(a.bg, b.bg),
    primary: mix(a.primary, b.primary),
    secondary: mix(a.secondary, b.secondary),
    accent: mix(a.accent, b.accent),
    highlight: mix(a.highlight, b.highlight),
  };
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted k-means in OKLab with k-means++ seeding (deterministic). */
export function kmeans(points: Vec3[], k: number, iterations = 14, seed = 7): Cluster[] {
  if (points.length === 0) return [];
  const rand = mulberry32(seed);
  k = Math.min(k, points.length);
  const centers: Vec3[] = [points[Math.floor(rand() * points.length)]];
  const dist = new Float64Array(points.length);
  while (centers.length < k) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      let best = Infinity;
      for (const c of centers) best = Math.min(best, deltaE(points[i], c) ** 2);
      dist[i] = best;
      sum += best;
    }
    if (sum === 0) break;
    let r = rand() * sum;
    let idx = 0;
    for (; idx < points.length - 1; idx++) {
      r -= dist[idx];
      if (r <= 0) break;
    }
    centers.push(points[idx]);
  }

  const assign = new Int32Array(points.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < points.length; i++) {
      let best = Infinity;
      let bi = 0;
      for (let c = 0; c < centers.length; c++) {
        const d = deltaE(points[i], centers[c]);
        if (d < best) {
          best = d;
          bi = c;
        }
      }
      assign[i] = bi;
    }
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const a = acc[assign[i]];
      a[0] += points[i][0];
      a[1] += points[i][1];
      a[2] += points[i][2];
      a[3]++;
    }
    acc.forEach((a, c) => {
      if (a[3] > 0) centers[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    });
  }

  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < points.length; i++) counts[assign[i]]++;
  return centers
    .map((lab, c) => ({ lab, lch: oklabToOklch(lab), weight: counts[c] / points.length }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

function vivid(lch: Vec3, minL = 0.55, maxL = 0.9, boost = 1.12): Vec3 {
  return oklchToOklab(gamutMapOklch([Math.min(maxL, Math.max(minL, lch[0])), lch[1] * boost, lch[2]]));
}

export interface ExtractedPalette {
  palette: Palette;
  /** Weighted mean lightness of the artwork, 0..1. */
  brightness: number;
  /** Weighted mean chroma, roughly 0..0.3. */
  colorfulness: number;
}

/**
 * Pick the five roles from RGBA pixels (sRGB, 8-bit). The artwork is expected to be
 * downsampled already (64×64 is plenty).
 */
export function extractPalette(rgba: Uint8ClampedArray | Uint8Array): ExtractedPalette {
  const points: Vec3[] = [];
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    points.push(
      linearRgbToOklab([srgbToLinear(rgba[i] / 255), srgbToLinear(rgba[i + 1] / 255), srgbToLinear(rgba[i + 2] / 255)]),
    );
  }
  if (points.length === 0) return { palette: BRAND_PALETTE, brightness: 0, colorfulness: 0 };

  const clusters = kmeans(points, 8);
  const brightness = clusters.reduce((s, c) => s + c.lch[0] * c.weight, 0);
  const colorfulness = clusters.reduce((s, c) => s + c.lch[1] * c.weight, 0);
  const significant = clusters.filter((c) => c.weight >= 0.02);
  const pool = significant.length ? significant : clusters;

  const darkest = [...pool].sort((a, b) => a.lch[0] - b.lch[0])[0];
  const bg = oklchToOklab(gamutMapOklch([Math.min(0.16, Math.max(0.07, darkest.lch[0])), Math.min(darkest.lch[1], 0.05), darkest.lch[2]]));

  const maxChroma = Math.max(...pool.map((c) => c.lch[1]));

  // Muted but tinted artwork (e.g. dusty greens): keep its hue and give it a bit more voice.
  let ta = 0;
  let tb = 0;
  let tw = 0;
  for (const c of pool) {
    if (c.lch[1] < 0.012) continue;
    ta += c.lab[1] * c.weight;
    tb += c.lab[2] * c.weight;
    tw += c.weight;
  }
  const tintChroma = tw > 0 ? Math.hypot(ta, tb) / tw : 0;
  if (maxChroma < 0.04 && tintChroma >= 0.015 && tw > 0.25) {
    const h = Math.atan2(tb, ta);
    const lab = (L: number, C: number, hue: number) => oklchToOklab(gamutMapOklch([L, C, hue]));
    return {
      palette: {
        bg: lab(Math.min(0.15, Math.max(0.08, darkest.lch[0])), 0.03, h),
        primary: lab(0.78, Math.max(0.1, tintChroma * 3), h),
        secondary: lab(0.52, Math.max(0.07, tintChroma * 2), h - 0.15),
        accent: lab(0.88, Math.max(0.13, tintChroma * 4), h + 0.3),
        highlight: lab(0.97, 0.015, h),
      },
      brightness,
      colorfulness,
    };
  }

  if (maxChroma < 0.04) {
    // Black-and-white artwork: keep its greys and let the brand lime be the only color.
    const byL = [...pool].sort((a, b) => b.lch[0] - a.lch[0]);
    const light = byL[0].lch;
    const mid = byL[Math.min(1, byL.length - 1)].lch;
    return {
      palette: {
        bg,
        primary: oklchToOklab([Math.max(0.7, light[0]), light[1], light[2]]),
        secondary: oklchToOklab([Math.min(0.6, Math.max(0.42, mid[0])), mid[1], mid[2]]),
        accent: linearRgbToOklab(hexToLinearRgb(BRAND_LIME)),
        highlight: oklchToOklab([0.97, 0.01, light[2]]),
      },
      brightness,
      colorfulness,
    };
  }

  const score = (c: Cluster) => Math.sqrt(c.weight) * (c.lch[1] + 0.03) * Math.max(0.15, 1 - Math.abs(c.lch[0] - 0.65) * 1.2);
  const ranked = [...pool].sort((a, b) => score(b) - score(a));
  const primaryC = ranked[0];
  const primary = vivid(primaryC.lch);

  const distinct = (c: Cluster, from: Vec3[]) =>
    from.every((f) => {
      const fl = oklabToOklch(f);
      return deltaE(c.lab, f) > 0.12 && (hueDistance(c.lch[2], fl[2]) > 0.35 || Math.abs(c.lch[0] - fl[0]) > 0.25);
    });

  const secondaryC = ranked.slice(1).find((c) => c.lch[1] > 0.03 && distinct(c, [primary]));
  const secondary = secondaryC
    ? vivid(secondaryC.lch, 0.45, 0.85)
    : oklchToOklab(gamutMapOklch([Math.max(0.45, primaryC.lch[0] - 0.15), primaryC.lch[1], primaryC.lch[2] + 0.7]));

  const accentC = [...pool]
    .filter((c) => c !== primaryC && c !== secondaryC && c.lch[1] > 0.06 && distinct(c, [primary, secondary]))
    .sort((a, b) => b.lch[1] - a.lch[1])[0];
  const accent = accentC
    ? vivid(accentC.lch, 0.65, 0.92, 1.2)
    : oklchToOklab(gamutMapOklch([0.82, Math.max(0.14, primaryC.lch[1]), primaryC.lch[2] - 0.85]));

  const pl = oklabToOklch(primary);
  const highlight = oklchToOklab([0.96, Math.min(pl[1] * 0.3, 0.05), pl[2]]);

  return { palette: { bg, primary, secondary, accent, highlight }, brightness, colorfulness };
}
