/**
 * Runtime configuration.
 *
 * Every API/Socket call in the app is built from these base URLs (see
 * context.tsx, AuthGate, Wallet, Profile, Football, Admin, ...).
 *
 * Resolution order:
 *  1. `REACT_APP_API_URL` build-time env (recommended for deployed frontends),
 *     e.g. https://your-api-host.example.com (no trailing slash).
 *  2. Local browser hosts (localhost/127.0.0.1) -> http://localhost:5001 for
 *     local development without extra env setup.
 *  3. Any other deployed host -> same-origin. This avoids the broken default of
 *     pointing production users at their own localhost and works when the API is
 *     served from the same origin or proxied. If your API is on a different
 *     host, you MUST set `REACT_APP_API_URL` in the build environment.
 */
const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const resolveApiBase = (): string => {
  const envBase = process.env.REACT_APP_API_URL;
  if (envBase) return trimTrailingSlash(envBase);

  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'http://localhost:5001';
    }
    return trimTrailingSlash(window.location.origin);
  }

  return 'http://localhost:5001';
};

const API_BASE = resolveApiBase();
const isLocalDev =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

export const config = {
  development: isLocalDev,
  debug: isLocalDev,
  appKey: "crash-0.1.0",
  api: `${API_BASE}/api`,
  wss: API_BASE,
  development_api: `${API_BASE}/api`,
  development_wss: API_BASE,
  production_api: `${API_BASE}/api`,
  production_wss: API_BASE,
};
