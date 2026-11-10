// Keyboard shortcuts for the overlay, written out for the user's desktop. The app can't add
// them itself: every compositor keeps its bindings in its own config.
import type { DesktopInfo } from '../desktop/bridge';
import type { Lang } from './i18n';

export type Desktop = DesktopInfo['desktop'];

export const DESKTOP_NAMES: Record<Desktop, string> = {
  niri: 'niri',
  hyprland: 'Hyprland',
  sway: 'Sway',
  kde: 'KDE Plasma',
  gnome: 'GNOME',
  other: '',
};

/** Quote for a shell (Hyprland's and Sway's exec) only when it needs it. */
const sh = (s: string) => (/^[\w./+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** A KDL string (niri's config). */
const kdl = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The two commands a shortcut runs. */
export function overlayCommands(command: string): [string, string] {
  return [`${sh(command)} overlay toggle`, `${sh(command)} overlay next`];
}

/** Lines to paste into the desktop's config, or null where it's done in a settings window. */
export function shortcutConfig(desktop: Desktop, command: string, lang: Lang): string | null {
  const [toggle, next] = overlayCommands(command);
  const title = lang === 'es' ? ['Visualizer: overlay sí/no', 'Visualizer: siguiente estilo'] : ['Visualizer: overlay on/off', 'Visualizer: next overlay style'];
  switch (desktop) {
    case 'niri':
      return [
        `Mod+Ctrl+V hotkey-overlay-title=${kdl(title[0])} { spawn ${kdl(command)} "overlay" "toggle"; }`,
        `Mod+Ctrl+B hotkey-overlay-title=${kdl(title[1])} { spawn ${kdl(command)} "overlay" "next"; }`,
      ].join('\n');
    case 'hyprland':
      return [`bind = SUPER CTRL, V, exec, ${toggle}`, `bind = SUPER CTRL, B, exec, ${next}`].join('\n');
    case 'sway':
      return [`bindsym Mod4+Ctrl+v exec ${toggle}`, `bindsym Mod4+Ctrl+b exec ${next}`].join('\n');
    default:
      return null;
  }
}
