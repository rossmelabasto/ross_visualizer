import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    // The overlay page is only used by the desktop app.
    rollupOptions: { input: { main: 'index.html', overlay: 'overlay.html' } },
  },
  // Tauri runs the dev server itself and shows its own errors.
  clearScreen: false,
  server: { host: '127.0.0.1', port: 5190 },
  preview: { host: '127.0.0.1', port: 5191 },
});
