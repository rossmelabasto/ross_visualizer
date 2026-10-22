// Stroke icons drawn at 24×24 (Lucide-style geometry, written by hand).
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  monitor: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><circle cx="11" cy="15" r="2"/><path d="M13 15v-4l2 1"/>'),
  sparkles: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/>'),
  play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  pause: svg('<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>'),
  next: svg('<path d="M6 5v14l9-7zM18 5v14"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  shrink: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  settings: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  share: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  waves: svg('<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0"/>'),
  scene: {
    fluid: svg('<path d="M3 15c3-4 6 2 9-2s6 2 9-2"/><path d="M3 9c3-4 6 2 9-2s6 2 9-2"/>'),
    galaxy: svg('<circle cx="12" cy="12" r="1.5"/><path d="M12 4a8 8 0 0 1 8 8M12 20a8 8 0 0 1-8-8M17 7a6 6 0 0 0-10 2M7 17a6 6 0 0 0 10-2"/>'),
    nebula: svg('<path d="M4 14c2-5 7-7 11-5s5 6 2 8-7 1-8-2 2-5 5-4"/><circle cx="6" cy="6" r=".8"/><circle cx="19" cy="5" r=".8"/><circle cx="20" cy="18" r=".8"/>'),
    aurora: svg('<path d="M3 13c3-6 6 2 9-4s6 1 9-5"/><path d="M3 17c3-4 6 1 9-3s6 0 9-3" opacity=".6"/><path d="M2 21l5-4 4 3 4-5 7 6"/>'),
    kaleido: svg('<path d="M12 3l3 6h-6zM12 21l-3-6h6zM3 12l6-3v6zM21 12l-6 3V9z"/>'),
    tunnel: svg('<path d="M4 6c3-2 13-2 16 0M5 18c3 2 11 2 14 0M7 9c2-1 8-1 10 0M8 15c2 1 6 1 8 0"/><ellipse cx="12" cy="12" rx="2.5" ry="1.5"/>'),
    ascii: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>'),
  },
};
