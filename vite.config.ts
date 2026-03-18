import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    port: 3000,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  optimizeDeps: {
    exclude: ['v86'],
  },
});


