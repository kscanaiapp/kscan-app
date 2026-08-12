/**
 * Commerce destination selection and safety.
 *
 * A product record can carry several URLs (merchant offer, search-engine product
 * page, affiliate redirect) spread across inconsistent keys, and providers do
 * not agree on which key holds which. Selecting by key order therefore cannot be
 * made correct — this module selects by classifying the destination instead.
 *
 * Priority, matching the product contract:
 *   1. a verified retailer destination
 *   2. a generic aggregator/search page, only when no retailer URL exists
 *   3. nothing, so the caller can suppress the action entirely
 */

/**
 * Search/aggregator intermediaries — a results or redirect page rather than a
 * place to buy the item. Deliberately NOT a retailer list: it names only the
 * generic middlemen, so every actual retailer stays equally eligible and
 * retailer neutrality is preserved.
 */
const AGGREGATOR_HOSTS = [
  'google.com', 'google.co.uk', 'googleadservices.com', 'googleusercontent.com',
  'shopping.google.com', 'bing.com', 'duckduckgo.com', 'search.yahoo.com',
];

/**
 * Hosts that must never be opened as a commerce destination. Product metadata is
 * untrusted input, so a URL aimed at loopback, RFC1918 space or the link-local
 * metadata endpoint is treated as hostile rather than merely useless.
 */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

/** True when the URL lands on a search/aggregator intermediary, not a retailer. */
export function isAggregatorDestination(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let host: string;
  try {
    host = new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AGGREGATOR_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`));
}

/**
 * Returns the URL only when it is safe to hand to the browser: HTTPS, no
 * embedded credentials, no internal network target. Anything else — javascript:,
 * data:, file:, a malformed string, a non-string — resolves to null.
 */
export function isSafeCommerceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname || isPrivateHost(parsed.hostname.toLowerCase())) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Picks the best destination from a record's candidate URLs.
 *
 * Unsafe and malformed candidates are skipped individually, so one bad URL never
 * suppresses a valid one alongside it.
 */
export function selectCommerceDestination(candidates: unknown[]): string | null {
  const safe: string[] = [];
  for (const candidate of candidates) {
    const url = isSafeCommerceUrl(candidate);
    if (url && !safe.includes(url)) safe.push(url);
  }
  if (safe.length === 0) return null;
  return safe.find((url) => !isAggregatorDestination(url)) ?? safe[0];
}
