import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  server: { host: '127.0.0.1', port: 5190 },
  preview: { host: '127.0.0.1', port: 5191 },
});
