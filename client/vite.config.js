import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * GitHub Pages SPA fallback.
 *
 * GitHub Pages answers any request that does not match a real file with its own
 * `404.html`. Copying the built `index.html` to `404.html` makes a hard refresh
 * — or a shared deep link such as /students/42 — boot the React app instead,
 * because the browser keeps the requested URL and React Router resolves the
 * same route on load. Netlify-style `_redirects` files are ignored by Pages, so
 * this copy is the mechanism that actually works on our host.
 *
 * Generated after the bundle is written so the fallback points at the same
 * content-hashed assets as the real entry document.
 */
function spaFallback404() {
  let outDir = 'dist';
  return {
    name: 'spa-fallback-404',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const index = resolve(outDir, 'index.html');
      const fallback = resolve(outDir, '404.html');
      if (existsSync(index)) copyFileSync(index, fallback);
    },
  };
}

// The Express server serves `dist/` in production and proxies nothing, so the
// dev server must proxy `/api` itself. Proxying (rather than pointing fetch at
// http://localhost:8080) keeps the browser on a single origin, which matters
// because helmet's CSP sets `connectSrc: ["'self'"]` and login relies on an
// httpOnly cookie that cross-origin requests would not send.
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), tailwindcss(), spaFallback404()],
  server: {
    port: 5173,
    // Listen on every interface so phones/tablets on the LAN — and machines on a
    // Tailscale tailnet — can reach the dev server at http://<ip>:5173.
    host: true,
    // Accept any Host header (e.g. a Tailscale MagicDNS name like host.tailnet.ts.net).
    // Vite's DNS-rebinding guard otherwise 403s hostnames it does not recognise.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        // Keep the browser's Host on the proxied request. The API's CORS layer
        // treats a request as same-origin when its Origin host matches Host, so
        // rewriting Host to localhost:8080 would make every LAN/Tailscale client
        // look cross-origin and fail. Keeping it also means the session cookie is
        // scoped to the address the device actually used.
        changeOrigin: false,
        // SSE must not be buffered by the proxy.
        configure(proxy) {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  preview: {
    host: true,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // The console is an internal ops tool; a single vendor chunk keeps the
    // dashboard's first paint fast behind a slow campus link.
    chunkSizeWarningLimit: 900,
  },
});