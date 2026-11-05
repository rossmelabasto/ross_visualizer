/** Overlay styles, in menu order. src-tauri/src/overlay.rs keeps the same list for the tray menu. */
export const OVERLAY_MODES = ['halo', 'horizon', 'orbit', 'curtain', 'embers', 'rain', 'wave'] as const;
export type OverlayMode = (typeof OVERLAY_MODES)[number];

export function isOverlayMode(v: unknown): v is OverlayMode {
  return typeof v === 'string' && (OVERLAY_MODES as readonly string[]).includes(v);
}
