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

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)|\.(local|internal|invalid|test|example)$/i;

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
 * direct          https page on a public host that is not a search intermediary
 * search_handoff  https page on a search intermediary (e.g. a Google Shopping /search page)
 * invalid         unparseable, non-https, credentialed or private host
 */
export function classifyDestination(input) {
  const p = parts(input);
  if (!p || !p.https || !p.host || PRIVATE_HOST.test(p.host)) return 'invalid';
  if (SEARCH_INTERMEDIARY.some((re) => re.test(p.host))) return 'search_handoff';
  return 'direct';
}

export function destinationHostPath(input) {
  const p = parts(input);
  return p ? `${p.host}${p.path}` : null;
}
