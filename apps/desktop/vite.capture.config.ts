import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Renderer-only dev server used by scripts/assets screenshot capture. */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
