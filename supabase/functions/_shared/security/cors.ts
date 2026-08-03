// Caller-aware CORS and HTTP method enforcement.
//
// K Scan's provider-backed functions are called from three kinds of caller:
//   - native mobile clients (React Native / Expo) — these do not enforce browser
//     CORS at all, so an Origin allow-list is not an authorization layer for them.
//   - the K Scan web origin (kscan.app) — browser CORS genuinely restricts which
//     pages can read the response, so this is the origin allow-list that matters.
//   - server-to-server callers (no Origin header) — CORS is a browser-only concept,
//     so these are unaffected by the allow-list either way.
//
// This module only decides what CORS headers to *send*; it never gates request
// handling on Origin, since that would incorrectly block legitimate non-browser
// callers while providing no real security for browser callers who lie about
// their Origin. Authorization always comes from the bearer token (security/context.ts).

export type CorsHeaders = Record<string, string>;

// Update this list when new K Scan browser surfaces (marketing site, glasses
// companion web app, staging web preview) need direct browser access.
export const DEFAULT_APPROVED_ORIGINS: readonly string[] = [
  'https://kscan.app',
  'https://www.kscan.app',
];

export interface CorsPolicy {
  approvedOrigins?: readonly string[];
  allowedMethods: readonly string[];
}

export function buildCorsHeaders(req: Request, policy: CorsPolicy): CorsHeaders {
  const approvedOrigins = policy.approvedOrigins ?? DEFAULT_APPROVED_ORIGINS;
  const origin = req.headers.get('Origin');

  const headers: CorsHeaders = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': [...policy.allowedMethods, 'OPTIONS'].join(', '),
    Vary: 'Origin',
  };

  // Only echo back an Origin that is on the approved list. Native mobile clients
  // send no Origin header at all and are unaffected by this omission; unapproved
  // browser origins simply receive a response the browser will not expose to script.
  if (origin && approvedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

// Handles OPTIONS preflight consistently. Returns null for non-OPTIONS requests
// so callers can fall through to method enforcement.
export function handleCorsPreflight(req: Request, policy: CorsPolicy): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response('ok', { headers: buildCorsHeaders(req, policy) });
}

export function isMethodAllowed(req: Request, policy: CorsPolicy): boolean {
  return policy.allowedMethods.includes(req.method);
}
