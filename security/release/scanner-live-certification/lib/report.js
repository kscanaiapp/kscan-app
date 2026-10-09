'use strict';

const crypto = require('node:crypto');

/** Nearest-rank percentile. Averages are never used for latency conclusions. */
function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

function summarize(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  return {
    n: clean.length,
    min: clean.length ? Math.min(...clean) : null,
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    max: clean.length ? Math.max(...clean) : null,
  };
}

function hashShort(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12);
}

function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return null;
  }
}

const FORBIDDEN_EVIDENCE_PATTERNS = Object.freeze([
  /data:image\//i,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\bsbp_[a-f0-9]{40}\b/,
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  // a long unbroken base64-looking run is image bytes or a token, never a report field
  /[A-Za-z0-9+/]{240,}={0,2}/,
]);

class EvidencePrivacyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvidencePrivacyError';
  }
}

function assertEvidencePrivacy(value, path = '$') {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_EVIDENCE_PATTERNS) {
      if (pattern.test(value)) {
        throw new EvidencePrivacyError(`report field ${path} matched a forbidden secret/PII/image shape`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertEvidencePrivacy(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertEvidencePrivacy(entry, `${path}.${key}`);
  }
}

function str(value, max = 160) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : null;
}

/**
 * The only offer fields the report may carry. Offers are public retail data;
 * everything else (provider payload internals, tracking parameters) is dropped.
 * The destination is reduced to host + path, never the query string.
 */
function sanitizeOffer(offer, rank) {
  if (!offer || typeof offer !== 'object') return null;
  let destination = null;
  try {
    const u = new URL(String(offer.productUrl ?? offer.url ?? ''));
    destination = { host: u.host.toLowerCase(), path: u.pathname.slice(0, 120), https: u.protocol === 'https:' };
  } catch {
    destination = null;
  }
  const price = offer.price ?? offer.priceValue ?? offer.priceAmount ?? null;
  return {
    rank,
    title: str(offer.title ?? offer.name ?? offer.displayName, 140),
    retailer: str(offer.retailer ?? offer.merchant ?? offer.source ?? offer.store, 60),
    provider: str(offer.provider ?? offer.sourceProvider, 40),
    price: typeof price === 'number' ? price : str(String(price ?? ''), 24) || null,
    currency: str(offer.currency ?? offer.priceCurrency, 8),
    destination,
    matchScore: typeof offer.matchScore === 'number' ? offer.matchScore : null,
    confidenceTier: str(offer.confidenceTier, 32),
  };
}

module.exports = {
  EvidencePrivacyError,
  FORBIDDEN_EVIDENCE_PATTERNS,
  assertEvidencePrivacy,
  hashShort,
  hostOf,
  percentile,
  sanitizeOffer,
  str,
  summarize,
};
