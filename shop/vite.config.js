import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The shop a customer sees. Built to a plain static bundle, which the backend serves so that each
// shop's page can carry its own link-preview tags -- see backend/src/routes/shop-page.routes.ts.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  build: { outDir: 'dist', sourcemap: false }
});
