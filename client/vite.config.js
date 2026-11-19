import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Brand icon: keep the served copy in sync and cache-bust its URL.
 *
 * `assets/busicon.png` at the repo root is the master artwork; the file the site
 * actually serves is `client/public/busicon.png` (Vite copies it verbatim into
 * dist/). Because public files keep a stable URL, two things are needed so a
 * replaced icon actually shows up:
 *
 *   1. the master is copied over the served copy at the start of every build, and
 *   2. the URL is stamped with a short hash of those bytes
 *      (`/busicon.png?v=1a2b3c4d`), so a new icon is a new URL that browsers must
 *      fetch again rather than reuse a cached copy.
 *
 * The versioned URL is substituted into `index.html` (favicon + apple touch
 * icon) and into the copied web manifest, and published to the app code as the
 * `__BRAND_ICON_URL__` constant used by `<BrandMark>`.
 */
function brandIcon() {
  let url = '/busicon.png';
  let outDir = 'dist';
  return {
    name: 'brand-icon',
    config: () => {
      // `vite`/`vite build` run with the client directory as cwd.
      const clientDir = process.cwd();
      const master = resolve(clientDir, '..', 'assets', 'busicon.png');
      const served = resolve(clientDir, 'public', 'busicon.png');
      let bytes = null;
      if (existsSync(master)) {
        bytes = readFileSync(master);
        if (!existsSync(served) || !readFileSync(served).equals(bytes)) {
          writeFileSync(served, bytes);
        }
      } else if (existsSync(served)) {
        bytes = readFileSync(served);
      }
      if (bytes) {
        const version = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
        url = `/busicon.png?v=${version}`;
      }
      return { define: { __BRAND_ICON_URL__: JSON.stringify(url) } };
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    transformIndexHtml(html) {
      return html.replaceAll('__BUS_ICON__', url);
    },
    closeBundle() {
      const manifest = resolve(outDir, 'manifest.webmanifest');
      if (existsSync(manifest)) {
        const html = readFileSync(manifest, 'utf8');
        writeFileSync(manifest, html.replaceAll('/busicon.png"', `${url}"`));
      }
    },
  };
}

// The Express server serves `dist/` in production and proxies nothing, so the
// dev server must proxy `/api` itself. Proxying (rather than pointing fetch at
// http://localhost:3100) keeps the browser on a single origin, which matters
// because helmet's CSP sets `connectSrc: ["'self'"]` and login relies on an
// httpOnly cookie that cross-origin requests would not send.
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:3100';

/**
 * Google Sign-In is a build-time feature, enabled for the primary self-hosted
 * console by default.
 *
 * A plain `npm run build` (including the service's prepare-client preflight)
 * must keep the "Continue with Google" button. Only a Git-hosted fallback build
 * that has no Google client id sets VITE_ENABLE_GOOGLE_AUTH=false, in which case
 * the GIS script, button and /auth/google call are removed by dead-code
 * elimination. Defaulting to enabled prevents an ordinary rebuild from silently
 * taking sign-in away from the live deployment.
 */
const GOOGLE_AUTH_ENABLED = process.env.VITE_ENABLE_GOOGLE_AUTH !== 'false';

export default defineConfig({
  // A boolean literal (not a runtime lookup) so the minifier can fold it.
  define: {
    __GOOGLE_AUTH_ENABLED__: JSON.stringify(GOOGLE_AUTH_ENABLED),
  },
  plugins: [react(), tailwindcss(), brandIcon(), spaFallback404()],
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
        // rewriting Host to localhost:3100 would make every LAN/Tailscale client
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
    // Keep previously built hashed assets. A browser holding an older
    // index.html must still be able to load its JS/CSS until it refreshes;
    // wiping dist on every build makes those requests return the SPA shell
    // instead, which the browser then tries to execute as JavaScript and the
    // app renders a blank page. Dist is small; retaining old hashes is cheap.
    emptyOutDir: false,
    // The console is an internal ops tool; a single vendor chunk keeps the
    // dashboard's first paint fast behind a slow campus link.
    chunkSizeWarningLimit: 900,
  },
});