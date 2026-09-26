import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The shop a customer sees. Built to a plain static bundle, which the backend serves so that each
// shop's page can carry its own link-preview tags -- see backend/src/routes/shop-page.routes.ts.
export default defineConfig(({ mode }) => {
  /*
   * Where the shop's API lives while developing.
   *
   * Read through loadEnv, not process.env alone: this said process.env.SHOP_ORIGIN, and Vite does
   * not put .env files there -- so setting it in a file did nothing and the proxy quietly went on
   * pointing at PRODUCTION. That is a bad way to be wrong. The page looks local, the data is real,
   * and a change you are testing appears not to work because you are looking at a server that does
   * not have it.
   */
  const target = loadEnv(mode, process.cwd(), '').SHOP_ORIGIN || process.env.SHOP_ORIGIN || 'https://shop.scaleezy.com';

  /*
   * A local backend is reached at 127.0.0.1 but still TOLD it is the shop's host.
   *
   * The backend only mounts /_api/shop behind a Host gate, so the request has to carry
   * shop.localhost:4006 -- and Node's resolver does not know *.localhost names at all (browsers
   * and curl do, which is what makes this confusing: the address works everywhere except in the
   * proxy). Pointing at the loopback address and setting the Host by hand satisfies both.
   */
  const url = new URL(target);
  const local = /(^|\.)localhost$/.test(url.hostname) || url.hostname === '127.0.0.1';

  return {
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
     * SHOP_ORIGIN points it somewhere else (a staging host, or a local backend) when needed --
     * put it in backend/shop/.env.local, which is not in git. See the top of this file.
     */
    proxy: {
      '/_api': {
        target: local ? `${url.protocol}//127.0.0.1:${url.port || 80}` : target,
        // changeOrigin rewrites Host to the target's. For a local backend that would send
        // 127.0.0.1 and miss the gate, so the Host is set explicitly instead.
        changeOrigin: !local,
        ...(local ? { headers: { host: url.host } } : {}),
        secure: true
      }
    }
  },
  build: { outDir: 'dist', sourcemap: false }
  };
});
