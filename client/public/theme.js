/**
 * Theme bootstrap.
 *
 * Runs before the first paint (classic script in <head>, no defer) so a reload
 * in dark mode never flashes the light background. Light is the default, so the
 * only thing to do here is opt into dark when the user previously chose it.
 *
 * This lives in an external file rather than an inline <script> on purpose: the
 * server sends a strict `script-src 'self'` Content-Security-Policy, which blocks
 * inline scripts outright. An inline block would silently fail in production
 * while working fine under the Vite dev server.
 */
(function () {
  try {
    if (localStorage.getItem('transitsync.theme') === 'dark') {
      document.documentElement.classList.add('dark');
    }
  } catch {
    /* private mode or blocked storage — keep the light default */
  }
})();