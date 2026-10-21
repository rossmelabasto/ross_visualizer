import { extractPalette, paletteToLinearRgb, type ExtractedPalette, type Palette } from './palette';
import { linearRgbToHex, type Vec3 } from './oklab';

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image: ${src}`));
    img.src = src;
  });
}

export function paletteFromImage(img: CanvasImageSource): ExtractedPalette {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, size, size);
  return extractPalette(ctx.getImageData(0, 0, size, size).data);
}

export function paletteHexes(p: Palette): string[] {
  const rgb = paletteToLinearRgb(p);
  return [0, 1, 2, 3, 4].map((i) => linearRgbToHex(Array.from(rgb.subarray(i * 3, i * 3 + 3)) as Vec3));
}

/**
 * Procedural "artwork" for sources without one (mic, system audio, demo):
 * soft blobs and a few rings in the palette colors, so the kaleidoscope still has texture.
 */
export function generateCover(p: Palette, seed = 1): HTMLCanvasElement {
  const [bg, primary, secondary, accent, highlight] = paletteHexes(p);
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  let s = seed * 9301 + 49297;
  const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  const colors = [primary, secondary, accent, secondary, primary];
  for (let i = 0; i < 9; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = size * (0.15 + rand() * 0.35);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, colors[i % colors.length]);
    g.addColorStop(1, 'transparent');
    ctx.globalAlpha = 0.55 + rand() * 0.4;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 6;
  for (let i = 0; i < 5; i++) {
    ctx.strokeStyle = i % 2 ? highlight : accent;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 20 + rand() * 120, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return c;
}
