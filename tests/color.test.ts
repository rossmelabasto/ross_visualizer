import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hexToLinearRgb, linearRgbToHex, linearRgbToOklab, oklabToLinearRgb, oklabToOklch, type Vec3 } from '../src/color/oklab';
import { ROLES, extractPalette, kmeans, paletteFromHue, paletteToLinearRgb } from '../src/color/palette';

function image(fill: (x: number, y: number) => [number, number, number]) {
  const size = 64;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fill(x, y);
      data.set([r, g, b, 255], (y * size + x) * 4);
    }
  return data;
}

const hue = (v: Vec3) => (oklabToOklch(v)[2] * 180) / Math.PI;

describe('oklab', () => {
  it('round-trips sRGB colors', () => {
    for (const hex of ['#afff00', '#8b5cf6', '#000000', '#ffffff', '#123456']) {
      const back = linearRgbToHex(oklabToLinearRgb(linearRgbToOklab(hexToLinearRgb(hex))));
      expect(back).toBe(hex);
    }
  });
});

describe('kmeans', () => {
  it('is deterministic', () => {
    const pts: Vec3[] = Array.from({ length: 300 }, (_, i) => [((i * 37) % 100) / 100, ((i * 13) % 50) / 200, 0]);
    expect(kmeans(pts, 5)).toEqual(kmeans(pts, 5));
  });
});

describe('extractPalette', () => {
  it('finds the main hue of a two-color cover', () => {
    const data = image((x) => (x < 40 ? [200, 30, 40] : [20, 40, 160]));
    const { palette } = extractPalette(data);
    const h = hue(palette.primary);
    // Red dominates (40 of 64 columns).
    expect(h < 45 || h > 330).toBe(true);
    const s = hue(palette.secondary);
    expect(s > 230 && s < 290).toBe(true);
  });

  it('gives a dark background', () => {
    const data = image((x, y) => ((x + y) % 2 ? [240, 200, 60] : [30, 90, 200]));
    expect(extractPalette(data).palette.bg[0]).toBeLessThanOrEqual(0.16);
  });

  it('uses the brand lime for black-and-white covers', () => {
    const data = image((x, y) => {
      const v = (x * 4 + y) % 255;
      return [v, v, v];
    });
    const { palette } = extractPalette(data);
    expect(linearRgbToHex(oklabToLinearRgb(palette.accent))).toBe('#afff00');
  });

  it('keeps the hue of muted, tinted artwork (Querido…)', () => {
    const data = new Uint8Array(readFileSync(new URL('./fixtures/querido-64.rgba', import.meta.url)));
    const { palette } = extractPalette(data);
    const h = hue(palette.primary);
    expect(h).toBeGreaterThan(120);
    expect(h).toBeLessThan(200);
    expect(oklabToOklch(palette.primary)[1]).toBeGreaterThanOrEqual(0.09);
  });

  it('always returns in-gamut colors', () => {
    const data = image((x, y) => [(x * 4) % 256, (y * 4) % 256, ((x + y) * 2) % 256]);
    for (const p of [extractPalette(data).palette, paletteFromHue(1), paletteFromHue(4.5)]) {
      const rgb = paletteToLinearRgb(p);
      expect(rgb.length).toBe(ROLES.length * 3);
      for (const c of rgb) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});
