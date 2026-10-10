import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import config from './config/env.js';
import apiRoutes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { hub } from './services/realtime.js';

/**
 * True when `origin` addresses this very server, judged by Host.
 *
 * Comparing host rather than protocol keeps it correct behind a TLS-terminating
 * proxy, where `req.protocol` is http but the browser legitimately used https.
 * Both sides include the port when non-default, so localhost:8080 matches
 * localhost:8080 and localhost:5173 does not.
 */
function isSelfOrigin(req, origin) {
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    // "null" (sandboxed iframe / file://) and anything unparseable: not us.
    return false;
  }
}

export function createApp() {
  const app = express();

  // Behind nginx/Apache in production — needed for correct client IPs and secure cookies.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Tailwind and a handful of chart components rely on inline style attributes.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          // Helmet ships `upgrade-insecure-requests` by default. On an internal
          // deployment reached over plain HTTP (a LAN IP or a Tailscale name) that
          // directive rewrites every same-origin subresource to https:// and the
          // console dies with failed asset requests. TLS, when present, is
          // terminated by a reverse proxy that sets HSTS itself, so disable it here.
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
      // The SPA is same-origin; COEP would block nothing useful but can trip dev tooling.
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  /**
   * The SPA is served by this same process, so real traffic is same-origin and
   * technically needs no CORS. But browsers attach an `Origin` header to every
   * POST — including same-origin ones, as CSRF defence — and `cors` judges any
   * request carrying one against the allowlist. Forgetting the app's own origin
   * there therefore breaks sign-in with "Origin ... is not permitted by CORS
   * policy" even though nothing is actually cross-origin.
   *
   * `config.corsOrigins` already contains the self origin, and `isSelfOrigin`
   * adds a second, drift-proof check against the request's own Host, so
   * changing PORT, sitting behind a reverse proxy, or opening the console via
   * 127.0.0.1 instead of localhost can never lock the app out of itself.
   */
  app.use(
    cors((req, callback) => {
      const origin = req.headers.origin;

      // No Origin at all: curl, Postman, server-to-server, same-origin GETs.
      if (!origin) return callback(null, { origin: true, credentials: true });
      if (config.corsOrigins.includes(origin) || isSelfOrigin(req, origin)) {
        return callback(null, { origin: true, credentials: true });
      }

      return callback(new Error(`Origin ${origin} is not permitted by CORS policy.`));
    }),
  );

  app.use(
    compression({
      // Server-Sent Events must not be buffered by the compressor.
      filter: (req, res) =>
        !req.path.startsWith('/api/stream') && compression.filter(req, res),
    }),
  );

  app.use(express.json({ limit: config.limits.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: config.limits.bodyLimit }));
  app.use(cookieParser());
  app.use(morgan(config.isProduction ? 'combined' : 'dev', { skip: (req) => req.path === '/api/health' }));

  app.use(
    '/api',
    rateLimit({
      windowMs: config.limits.apiRateWindowMs,
      max: config.limits.apiRateMax,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => config.isTest || req.path === '/health',
    }),
  );

  app.use('/api', apiRoutes);
  app.use('/api', notFoundHandler);

  // -------------------------------------------------------------------------
  // Static SPA
  // -------------------------------------------------------------------------
  mountClient(app);

  app.use(errorHandler);
  return app;
}

/**
 * Serve the built client and provide the client-side routing fallback.
 *
 * The fallback is what stops deep links such as /students or /users/42 from
 * rendering a blank screen: Express returns index.html for extensionless GETs so
 * React Router can take over. Requests for a path *with* a file extension (a
 * missing .js chunk, a stale .css) return a real 404 instead — serving HTML for
 * those produces a confusing MIME-type error in the browser console.
 */
function mountClient(app) {
  const distDir = config.paths.clientDist;
  const indexFile = path.join(distDir, 'index.html');
  const built = fs.existsSync(indexFile);

  if (built) {
    // Hashed assets are immutable; index.html must always be revalidated.
    app.use(
      express.static(distDir, {
        index: false,
        maxAge: '1y',
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
        },
      }),
    );
  }

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();

    // Anything that looks like a file must 404 honestly.
    if (path.extname(req.path)) {
      return res.status(404).type('text/plain').send(`Not found: ${req.path}`);
    }

    if (built) return res.sendFile(indexFile);

    // Client has not been built yet — explain instead of serving a blank page.
    return res
      .status(503)
      .type('html')
      .send(missingClientPage());
  });
}

function missingClientPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TransitSync — client not built</title>
    <style>
      :root { color-scheme: dark; }
      body { margin:0; min-height:100vh; display:grid; place-items:center;
             background:#0B0F17; color:#E2E8F0;
             font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
      .card { max-width:640px; padding:40px; border:1px solid #1E293B; border-radius:16px;
              background:rgba(15,23,42,.6); backdrop-filter:blur(12px); }
      h1 { margin:0 0 8px; font-size:22px; letter-spacing:-.02em; }
      p  { color:#94A3B8; margin:0 0 20px; }
      pre{ background:#0F172A; border:1px solid #1E293B; border-radius:10px; padding:16px;
           color:#7DD3FC; overflow-x:auto; font-size:13px; }
      code { color:#F8FAFC; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>TransitSync API is running</h1>
      <p>The dashboard bundle has not been built yet, so there is no UI to serve.
         Build it once and reload this page:</p>
      <pre><code>npm run build</code></pre>
      <p style="margin-top:20px">Then open <a style="color:#38BDF8" href="http://localhost:${config.port}">http://localhost:${config.port}</a>.
         The API is live at <code>/api/health</code>.</p>
    </div>
  </body>
</html>`;
}

export { hub };
export default createApp;
