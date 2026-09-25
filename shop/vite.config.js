import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The shop a customer sees. Built to a plain static bundle, which the backend serves so that each
// shop's page can carry its own link-preview tags -- see backend/src/routes/shop-page.routes.ts.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    /*
     * Running this app on its own, against a real shop.
     *
     * In production the bundle and the API share one host, so `/_api` is just a path and there is
     * no cross-origin anything. In development the page is on localhost, and pointing it straight
     * at shop.scaleezy.com fails: the public shop routes send no Access-Control-Allow-Origin,
     * quite rightly, because in production nobody ever needs one.
     *
     * So the dev server does the hop instead of the browser. `changeOrigin` is the part that
     * matters -- the backend only serves shop pages when the Host header matches SHOP_BASE_URL,
     * so a request still carrying `localhost` would be waved past as an ordinary API call.
     *
     * SHOP_ORIGIN points it somewhere else (a staging host, or a local backend) when needed.
     */
    proxy: {
      '/_api': {
        target: process.env.SHOP_ORIGIN || 'https://shop.scaleezy.com',
        changeOrigin: true,
        secure: true
      }
    }
  },
  build: { outDir: 'dist', sourcemap: false }
});
