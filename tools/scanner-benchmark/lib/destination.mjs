// Merchant-link classifier for benchmark scoring.
//
// Deliberately independent of supabase/functions/scan-identify: the benchmark
// must not grade the pipeline with the pipeline's own rules. Input is either a
// URL string or the archived `{ host, path, https }` shape used by the
// scanner-live-certification evidence.

const SEARCH_INTERMEDIARY = [
  /(^|\.)google\.[a-z.]{2,6}$/,
  /(^|\.)googleadservices\.com$/,
  /(^|\.)googleusercontent\.com$/,
  /(^|\.)bing\.com$/,
  /(^|\.)duckduckgo\.com$/,
  /(^|\.)search\.yahoo\.com$/,
];

const DNS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const RESERVED_SUFFIX = /\.(local|localhost|internal|invalid|test|example|onion)$/i;
const SEARCH_PATH = /^\/(?:search|s|collections?|category|categories)(?:\/|$)/i;
const PRODUCT_PATH = /\/(?:p|pd|dp|product|products|listing|item)\/[^/]+/i;

function parts(input) {
  if (input && typeof input === 'object' && typeof input.host === 'string') {
    return { https: input.https === true, host: input.host.toLowerCase(), path: String(input.path ?? '/') };
  }
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const u = new URL(input);
    if (u.username || u.password) return null;
    return { https: u.protocol === 'https:', host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return null;
  }
}

/**
 * direct          HTTPS hostname and product-shaped path, pending listing verification
 * search_handoff  HTTPS search intermediary or catalogue/search path
 * unverified      HTTPS destination without a recognized product or search path
 * invalid         unparseable, non-HTTPS, credentialed, reserved or IP-literal destination
 */
export function classifyDestination(input) {
  const p = parts(input);
  if (!p || !p.https) return 'invalid';
  const host = p.host.replace(/\.$/, '');
  if (!DNS_HOST.test(host) || RESERVED_SUFFIX.test(host)) return 'invalid';
  if (SEARCH_INTERMEDIARY.some((re) => re.test(host)) || SEARCH_PATH.test(p.path)) return 'search_handoff';
  return PRODUCT_PATH.test(p.path) ? 'direct' : 'unverified';
}

export function destinationHostPath(input) {
  const p = parts(input);
  return p ? `${p.host}${p.path}` : null;
}
