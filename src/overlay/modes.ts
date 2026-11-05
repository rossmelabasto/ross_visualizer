/** Overlay styles, in menu order. src-tauri/src/overlay.rs keeps the same list for the tray menu. */
export const OVERLAY_MODES = ['halo', 'horizon', 'orbit', 'curtain', 'embers', 'rain', 'wave'] as const;
export type OverlayMode = (typeof OVERLAY_MODES)[number];

export function isOverlayMode(v: unknown): v is OverlayMode {
  return typeof v === 'string' && (OVERLAY_MODES as readonly string[]).includes(v);
}

export const EDGES = ['bottom', 'top', 'both'] as const;
/** Reading order, so the settings can lay them out as a 3 × 3 grid. */
export const SPOTS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;

export type OptionSpec =
  | { key: string; kind: 'choice'; values: readonly string[]; default: string }
  | { key: string; kind: 'range'; min: number; max: number; step: number; default: number };

/** Per-style settings. Heights and sizes are fractions of the screen height. */
export const OVERLAY_OPTIONS: Partial<Record<OverlayMode, OptionSpec[]>> = {
  halo: [
    { key: 'color', kind: 'choice', values: ['cover', 'white', 'black'], default: 'cover' },
    { key: 'intensity', kind: 'range', min: 0.4, max: 3, step: 0.1, default: 1 },
  ],
  horizon: [
    { key: 'position', kind: 'choice', values: EDGES, default: 'bottom' },
    { key: 'height', kind: 'range', min: 0.03, max: 0.3, step: 0.01, default: 0.09 },
  ],
  orbit: [
    { key: 'inside', kind: 'choice', values: ['kaleido', 'cover'], default: 'kaleido' },
    { key: 'position', kind: 'choice', values: SPOTS, default: 'bottom-right' },
    { key: 'size', kind: 'range', min: 0.06, max: 0.22, step: 0.01, default: 0.12 },
  ],
  curtain: [{ key: 'height', kind: 'range', min: 0.04, max: 0.3, step: 0.01, default: 0.09 }],
  wave: [
    { key: 'position', kind: 'choice', values: EDGES, default: 'bottom' },
    { key: 'height', kind: 'range', min: 0.03, max: 0.3, step: 0.01, default: 0.09 },
  ],
};

/** Saved settings: { [mode]: { [key]: value } }. Missing values fall back to the defaults above. */
export type OverlayOptions = Record<string, Record<string, string | number>>;

export function optionOf(all: OverlayOptions, mode: OverlayMode, key: string): string | number {
  const spec = OVERLAY_OPTIONS[mode]?.find((o) => o.key === key);
  const saved = all[mode]?.[key];
  if (!spec) return saved ?? 0;
  if (spec.kind === 'choice') return typeof saved === 'string' && spec.values.includes(saved) ? saved : spec.default;
  return typeof saved === 'number' && saved >= spec.min && saved <= spec.max ? saved : spec.default;
}
