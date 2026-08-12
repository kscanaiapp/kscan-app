'use strict';

/**
 * The single K Scan observability privacy boundary.
 *
 * WHY THIS FILE EXISTS: the redaction rules used to live only inside
 * `services/observability.ts`. Build 29 added a provider transport (Sentry),
 * and a provider adapter that re-implemented "what is safe to send" would be a
 * second, silently divergent privacy boundary. Extracting the primitives here
 * keeps exactly one allowlist and one redactor: `services/observability.ts`
 * re-exports them for the K Scan event pipeline, and
 * `services/observabilitySentryPolicy.js` applies the same rules to every
 * provider-bound payload before it can leave the device.
 *
 * This module is deliberately dependency-free CommonJS so the privacy rules can
 * be executed directly under `node --test` rather than only asserted on as
 * source text.
 */

const REDACTED = '[REDACTED]';

const SAFE_TOKEN_RE = /^[A-Za-z0-9_.:/-]{1,160}$/;

const SENSITIVE_KEY_FRAGMENTS = [
  'authorization', 'cookie', 'token', 'jwt', 'password', 'secret', 'api_key',
  'apikey', 'email', 'phone', 'prompt', 'message', 'chat', 'conversation',
  'image', 'photo', 'uri', 'signed_url', 'storage_path', 'latitude', 'longitude',
  'face', 'base64', 'access_token', 'refresh_token',
];

const ALLOWED_CONTEXT_KEYS = new Set([
  'release_id', 'source_sha', 'environment', 'platform', 'app_version', 'build',
  'screen', 'operation', 'request_id', 'trace_id', 'error_category',
  'provider_category', 'fallback_used', 'duration_bucket', 'network_category',
  'function_name', 'status_code', 'retry_count',
]);

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function isSensitiveObservabilityKey(key) {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function redactObservabilityValue(value, depth = 0) {
  if (depth > 8) return REDACTED;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (
      /bearer\s+/i.test(value) ||
      /data:image\//i.test(value) ||
      /eyJ[A-Za-z0-9_-]+\./.test(value) ||
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(value) ||
      /https?:\/\/[^\s]+[?&](?:token|signature|key)=/i.test(value) ||
      /\+?\d[\d\s().-]{7,}\d/.test(value)
    ) {
      return REDACTED;
    }
    return value.slice(0, 160);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 24).map((item) => redactObservabilityValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const safe = {};
    for (const [key, nested] of Object.entries(value).slice(0, 48)) {
      safe[key] = isSensitiveObservabilityKey(key)
        ? REDACTED
        : redactObservabilityValue(nested, depth + 1);
    }
    return safe;
  }
  return undefined;
}

function safeScalar(value) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const redacted = redactObservabilityValue(value);
    if (redacted === REDACTED) return REDACTED;
    const bounded = String(redacted).slice(0, 160);
    return SAFE_TOKEN_RE.test(bounded) ? bounded : undefined;
  }
  return undefined;
}

function buildObservabilityContext(input) {
  const safe = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!ALLOWED_CONTEXT_KEYS.has(key) || isSensitiveObservabilityKey(key)) continue;
    const scalar = safeScalar(value);
    if (scalar !== undefined) safe[key] = scalar;
  }
  return safe;
}

module.exports = {
  REDACTED,
  SAFE_TOKEN_RE,
  SENSITIVE_KEY_FRAGMENTS,
  ALLOWED_CONTEXT_KEYS,
  normalizedKey,
  isSensitiveObservabilityKey,
  redactObservabilityValue,
  safeScalar,
  buildObservabilityContext,
};
