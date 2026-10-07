import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist/app', sourcemap: true, chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  // Only VITE_-prefixed variables reach the browser. Server secrets must never use that prefix.
  envPrefix: 'VITE_',
});
