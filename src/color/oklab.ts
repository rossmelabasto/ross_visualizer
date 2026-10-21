// OKLab / OKLCh conversions (Björn Ottosson, https://bottosson.github.io/posts/oklab/).
// All RGB values here are linear unless the name says sRGB.

export type Vec3 = [number, number, number];

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function linearRgbToOklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinearRgb([L, a, b]: Vec3): Vec3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function oklabToOklch([L, a, b]: Vec3): Vec3 {
  const C = Math.hypot(a, b);
  let h = Math.atan2(b, a);
  if (h < 0) h += Math.PI * 2;
  return [L, C, h];
}

export function oklchToOklab([L, C, h]: Vec3): Vec3 {
  return [L, C * Math.cos(h), C * Math.sin(h)];
}

function inGamut([r, g, b]: Vec3, eps = 1e-4): boolean {
  return r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && b >= -eps && b <= 1 + eps;
}

/** Reduce chroma (keeping L and hue) until the color fits in sRGB. */
export function gamutMapOklch(lch: Vec3): Vec3 {
  const [L, , h] = lch;
  const Lc = Math.min(1, Math.max(0, L));
  if (inGamut(oklabToLinearRgb(oklchToOklab([Lc, lch[1], h])))) return [Lc, lch[1], h];
  let lo = 0;
  let hi = lch[1];
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinearRgb(oklchToOklab([Lc, mid, h])))) lo = mid;
    else hi = mid;
  }
  return [Lc, lo, h];
}

export function oklchToLinearRgb(lch: Vec3): Vec3 {
  const rgb = oklabToLinearRgb(oklchToOklab(gamutMapOklch(lch)));
  return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
}

export function hexToLinearRgb(hex: string): Vec3 {
  const n = parseInt(hex.replace('#', ''), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

export function linearRgbToHex(rgb: Vec3): string {
  return (
    '#' +
    rgb
      .map((c) => Math.round(clamp01(linearToSrgb(clamp01(c))) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

export function deltaE(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
