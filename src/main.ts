import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './ui/styles.css';
import { App } from './app';
import { detectLang, strings } from './ui/i18n';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
try {
  new App(canvas);
} catch (e) {
  console.error(e);
  const fb = document.getElementById('fallback')!;
  fb.textContent = strings(detectLang()).noWebgl;
  fb.hidden = false;
  document.getElementById('ui')!.hidden = true;
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
