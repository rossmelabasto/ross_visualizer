const es = {
  tagline: 'Tu música, hecha luz.',
  lead: 'Los colores salen de la portada. El movimiento, del sonido.',
  searchPlaceholder: 'Busca una canción o artista…',
  searchHintPlay: 'Suena una vista previa de 30 s',
  searchHintCover: 'Elige qué suena para usar su portada',
  orListen: 'o escucha',
  mic: 'Micrófono',
  system: 'Audio de la PC',
  file: 'Archivo',
  demo: 'Demo',
  privacy: 'El audio se analiza en tu navegador. Nada se sube a ningún lado.',
  scenes: { fluid: 'Fluido', nebula: 'Nebulosa', galaxy: 'Galaxia', aurora: 'Aurora', kaleido: 'Caleidoscopio', tunnel: 'Túnel', ascii: 'rOS' },
  play: 'Reproducir',
  pause: 'Pausar',
  source: 'Cambiar fuente',
  fullscreen: 'Pantalla completa',
  settings: 'Ajustes',
  close: 'Cerrar',
  sensitivity: 'Sensibilidad',
  quality: 'Calidad',
  qualityAuto: 'Auto',
  qualityHigh: 'Alta',
  qualityLow: 'Batería',
  autoCycle: 'Cambiar de escena sola',
  showStats: 'Mostrar datos del audio',
  share: 'Copiar enlace',
  copied: 'Enlace copiado',
  preview: 'Vista previa',
  openSpotify: 'Abrir en Spotify',
  openApple: 'Apple Music',
  listening: { mic: 'Escuchando el micrófono', system: 'Escuchando la PC', demo: 'Demo · sintetizador en vivo', media: '' },
  noResults: 'Sin resultados',
  searchError: 'No se pudo buscar. ¿Hay internet?',
  errors: {
    denied: 'Permiso denegado. Revisa los permisos del navegador.',
    unsupported: 'Tu navegador no permite esto.',
    'no-audio-track': 'No llegó audio: marca "Compartir audio" al elegir la pantalla o pestaña.',
    'load-failed': 'No se pudo reproducir.',
  },
  systemHelp: 'Elige una pantalla o pestaña y activa "Compartir audio".',
  noWebgl: 'Tu navegador no tiene WebGL2, que es lo que dibuja el visualizer.',
  keys: 'Teclas: 1–7 escenas · ←/→ · espacio · F · H · V versión del túnel',
  tunnelVersion: 'Versión',
  tunnelVersions: { original: 'Original', cheese: 'Queso', paths: 'Caminos' },
  tapHint: 'Desliza para cambiar de escena',
  madeBy: 'Hecho por',
  code: 'Código',
};

export type Strings = typeof es;

const en: Strings = {
  tagline: 'Your music, turned into light.',
  lead: 'Colors come from the album art. Motion comes from the sound.',
  searchPlaceholder: 'Search a song or artist…',
  searchHintPlay: 'Plays a 30 s preview',
  searchHintCover: "Pick what's playing to use its artwork",
  orListen: 'or listen to',
  mic: 'Microphone',
  system: 'Computer audio',
  file: 'File',
  demo: 'Demo',
  privacy: 'Audio is analyzed in your browser. Nothing is uploaded.',
  scenes: { fluid: 'Fluid', nebula: 'Nebula', galaxy: 'Galaxy', aurora: 'Aurora', kaleido: 'Kaleidoscope', tunnel: 'Tunnel', ascii: 'rOS' },
  play: 'Play',
  pause: 'Pause',
  source: 'Change source',
  fullscreen: 'Fullscreen',
  settings: 'Settings',
  close: 'Close',
  sensitivity: 'Sensitivity',
  quality: 'Quality',
  qualityAuto: 'Auto',
  qualityHigh: 'High',
  qualityLow: 'Battery',
  autoCycle: 'Cycle scenes automatically',
  showStats: 'Show audio data',
  share: 'Copy link',
  copied: 'Link copied',
  preview: 'Preview',
  openSpotify: 'Open in Spotify',
  openApple: 'Apple Music',
  listening: { mic: 'Listening to the microphone', system: 'Listening to the computer', demo: 'Demo · live synth', media: '' },
  noResults: 'No results',
  searchError: "Search failed. Are you online?",
  errors: {
    denied: 'Permission denied. Check your browser permissions.',
    unsupported: "Your browser doesn't support this.",
    'no-audio-track': 'No audio came through: tick "Share audio" when picking the screen or tab.',
    'load-failed': "Couldn't play it.",
  },
  systemHelp: 'Pick a screen or tab and turn on "Share audio".',
  noWebgl: "Your browser doesn't have WebGL2, which is what draws the visualizer.",
  keys: 'Keys: 1–7 scenes · ←/→ · space · F · H · V tunnel version',
  tunnelVersion: 'Version',
  tunnelVersions: { original: 'Original', cheese: 'Cheese', paths: 'Paths' },
  tapHint: 'Swipe to change scene',
  madeBy: 'Made by',
  code: 'Code',
};

const dict = { es, en };
export type Lang = keyof typeof dict;

export function detectLang(): Lang {
  const saved = safeGet('rv_lang');
  if (saved === 'es' || saved === 'en') return saved;
  return (navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function strings(lang: Lang): Strings {
  return dict[lang];
}

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
