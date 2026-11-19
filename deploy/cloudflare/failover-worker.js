/**
 * TransitSync edge router — Cloudflare Worker (primary-first with static fallback).
 *
 * Public hostname : transitsync.me/*  (Worker route)
 * PRIMARY_ORIGIN  : https://origin.transitsync.me  (your VPS / tunnel origin;
 *                   must NOT be covered by the same Worker route or it loops)
 * FALLBACK_ORIGIN : https://<project>.pages.dev      (Git-hosted, Google-free build)
 *
 * Behaviour
 *   - Primary is probed at /api/health every 15s (5s while degraded). The probe
 *     requires success:true AND data.database:"up", so a Node process with a
 *     dead MySQL is treated as DOWN.
 *   - Healthy  -> every request (including SSE and auth cookies) proxies to the
 *     primary. Git-hosted assets can never override a live server build.
 *   - Unhealthy/network error/5xx -> static pages are served from GitHub Pages;
 *     /api/* and /socket.io/* get a clean JSON 503 PRIMARY_OFFLINE instead of
 *     being sent to a static host that cannot answer them.
 *   - HTML/JSON is no-store; fingerprinted assets are immutable. There is no
 *     Service Worker registered by this app, so there is nothing else to bust.
 *
 * Deploy: see deploy/README.md (wrangler deploy / dashboard Workers route).
 */

const DEFAULT_PRIMARY = 'https://origin.transitsync.me';
// GitHub Pages serves project sites under /<repo>/; the proxy below preserves that
// prefix so root-absolute asset paths (/assets/...) resolve correctly.
const DEFAULT_FALLBACK = 'https://pixel-development-server.github.io/transitsync.web';
const HEALTH_CACHE_KEY = 'https://edge-health.transitsync.invalid/primary-health';
const HEALTH_TTL_SECONDS = 15;
const DOWN_TTL_SECONDS = 5;
const PROBE_TIMEOUT_MS = 2_500;
const BAD_GATEWAY_STATUSES = new Set([500, 502, 503, 504, 520, 521, 522, 524]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function cachedPrimaryHealth() {
  try {
    const cached = await caches.default.match(new Request(HEALTH_CACHE_KEY));
    if (!cached) return null;
    return (await cached.text()) === 'up';
  } catch {
    return null;
  }
}

function writePrimaryHealth(up, ctx) {
  const response = new Response(up ? 'up' : 'down', {
    headers: {
      'Cache-Control': `public, max-age=${up ? HEALTH_TTL_SECONDS : DOWN_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(caches.default.put(HEALTH_CACHE_KEY, response));
}

async function probePrimary(origin) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(new URL('/api/health', origin), {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        cf: { cacheTtl: 0 },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return false;
    const data = await response.json();
    return data?.success === true && data?.data?.database === 'up';
  } catch {
    return false;
  }
}

async function primaryIsHealthy(origin, ctx) {
  const cached = await cachedPrimaryHealth();
  if (cached !== null) return cached;
  const up = await probePrimary(origin);
  writePrimaryHealth(up, ctx);
  return up;
}

function proxy(request, url, originBase) {
  // Preserve a path prefix on the origin (e.g. GitHub Pages project subpath).
  // new URL('/assets/x', 'https://host/sub') would drop '/sub'; prepending it
  // keeps fallback assets reachable while leaving bare origins unchanged.
  const basePath = new URL(originBase).pathname.replace(/\/$/, '');
  const target = new URL(basePath + url.pathname + url.search, originBase);
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', 'https');
  return new Request(target.toString(), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
    duplex: 'half',
  });
}

function isFingerprinted(pathname) {
  return /\.[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|webp|ico|jpg)$/.test(pathname);
}

function decorate(response, mode, url) {
  const headers = new Headers(response.headers);
  headers.set('X-TransitSync-Mode', mode);
  if (isFingerprinted(url.pathname)) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (
    url.pathname.startsWith('/api/') ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/'
  ) {
    headers.set('Cache-Control', 'no-store');
  }
  if (response.webSocket) return response;
  const body = response.status === 204 || response.status === 304 ? null : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function offlineApi() {
  return json(
    {
      success: false,
      error: {
        code: 'PRIMARY_OFFLINE',
        message:
          'The primary TransitSync server is offline. Sign-in and live data are temporarily unavailable.',
      },
    },
    503,
  );
}

async function serveFallback(request, url, fallback) {
  // Static hosting cannot answer these namespaces. A deliberate 503 keeps the
  // fallback from exposing dead auth/API endpoints or a broken OAuth handshake.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    return offlineApi();
  }
  try {
    return decorate(await proxy(request, url, fallback), 'fallback', url);
  } catch {
    return json({ success: false, error: { code: 'FALLBACK_UNAVAILABLE' } }, 503);
  }
}

export default {
  async fetch(request, env, ctx) {
    const primary = env.PRIMARY_ORIGIN || DEFAULT_PRIMARY;
    const fallback = env.FALLBACK_ORIGIN || DEFAULT_FALLBACK;
    const url = new URL(request.url);

    // Edge self-check: always 200, reports which origin would serve right now.
    if (url.pathname === '/__edge/health') {
      const up = await primaryIsHealthy(primary, ctx);
      return json({
        mode: up ? 'primary' : 'fallback',
        primary: up ? 'up' : 'down',
        timestamp: new Date().toISOString(),
      });
    }

    if (await primaryIsHealthy(primary, ctx)) {
      try {
        const response = await proxy(request, url, primary);
        if (!BAD_GATEWAY_STATUSES.has(response.status)) {
          return decorate(response, 'primary', url);
        }
      } catch {
        /* fall through to the static host */
      }
      // The tunnel/origin answered 5xx: stop routing to it for the short TTL.
      writePrimaryHealth(false, ctx);
    }

    return serveFallback(request, url, fallback);
  },
};
