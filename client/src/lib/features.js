/**
 * Build-time feature flags for the TransitSync client.
 *
 * `__GOOGLE_AUTH_ENABLED__` is replaced with a boolean *literal* by Vite
 * (see client/vite.config.js). Because it is a literal, the bundler folds the
 * flag and dead-code-eliminates every Google Sign-In path when it is false:
 * no Google Identity Services script, no "Continue with Google" button, no
 * /auth/google request and no Google OAuth strings in the fallback bundle.
 *
 *   Primary / self-hosted build : enabled by default (plain `npm run build`)
 *   Git-hosted fallback build   : VITE_ENABLE_GOOGLE_AUTH=false
 */
/* global __GOOGLE_AUTH_ENABLED__ */
export const GOOGLE_AUTH_ENABLED = __GOOGLE_AUTH_ENABLED__ === true;
