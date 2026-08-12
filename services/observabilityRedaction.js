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

/**
 * Identifiers K Scan mints itself, in the exact shapes `services/observability.ts`
 * and `supabase/functions/_shared/observability.ts` produce.
 *
 * These MUST bypass the value heuristics below. A random 32-hex trace id has a
 * ~14% chance of containing a 9+ digit run, which the phone-number heuristic
 * reads as a phone number — silently destroying the correlation identity of
 * roughly one event in seven. Correlation ids are generated from a CSPRNG and
 * carry no user-derived material, so exempting them costs nothing.
 */
const CORRELATION_ID_RE = /^(?:ksr_[a-f0-9]{32}|[a-f0-9]{16}|[a-f0-9]{32}|[a-f0-9]{40})$/;

/**
 * Matched against a key normalized to bare `[a-z0-9]`, so a fragment written
 * with an underscore also catches its camelCase spelling (`storage_path` catches
 * `storagePath`, `signed_url` catches `signedUrl`). Kept in sync with the
 * backend list in `supabase/functions/_shared/observability.ts`.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'authorization', 'cookie', 'token', 'jwt', 'password', 'secret', 'api_key',
  'apikey', 'email', 'phone', 'prompt', 'message', 'chat', 'conversation',
  'image', 'photo', 'uri', 'signed_url', 'storage_path', 'latitude', 'longitude',
  'face', 'base64', 'access_token', 'refresh_token', 'sql',
];

const NORMALIZED_SENSITIVE_FRAGMENTS = SENSITIVE_KEY_FRAGMENTS.map((fragment) =>
  fragment.replace(/[^a-z0-9]/g, ''),
);

const ALLOWED_CONTEXT_KEYS = new Set([
  'release_id', 'source_sha', 'environment', 'platform', 'app_version', 'build',
  'screen', 'operation', 'request_id', 'trace_id', 'error_category',
  'provider_category', 'fallback_used', 'duration_bucket', 'network_category',
  'function_name', 'status_code', 'retry_count',
]);

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveObservabilityKey(key) {
  const normalized = normalizedKey(key);
  return NORMALIZED_SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** True for an identifier K Scan minted itself (request id, trace/span id, source SHA). */
function isCorrelationIdentifier(value) {
  return typeof value === 'string' && CORRELATION_ID_RE.test(value);
}

function redactObservabilityValue(value, depth = 0) {
  if (depth > 8) return REDACTED;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (isCorrelationIdentifier(value)) return value;
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

/**
 * Reduce a free-text diagnostic string (an error message, an error class name, a
 * transaction name) to something that cannot carry user content.
 *
 * WHY THIS IS STRICTER THAN `redactObservabilityValue`: that function redacts on
 * value SHAPE — bearer tokens, JWTs, emails, signed URLs, data URIs. Ordinary
 * prose matches none of those, so a prompt, an Elise reply, or a pasted message
 * that reached an `Error` message survived into `exception.values[].value` and
 * left the device intact. Shape-matching cannot make a free-text field
 * content-blind; only a positive allowlist can.
 *
 * A diagnostic token therefore survives only if it carries no whitespace —
 * which keeps K Scan's own error contract (`TEXTSCAN_TIMEOUT`,
 * `MALFORMED_EDGE_RESPONSE`, `AbortError`, `TypeError`) and every symbol-shaped
 * value, and refuses prose. The stack trace, error type, release, source SHA and
 * operation tag are unaffected and remain the primary diagnostic signal.
 */
function safeDiagnosticToken(value) {
  if (typeof value !== 'string') return REDACTED;
  const trimmed = value.trim();
  if (!trimmed) return REDACTED;
  if (isCorrelationIdentifier(trimmed)) return trimmed;
  const bounded = trimmed.slice(0, 160);
  if (!SAFE_TOKEN_RE.test(bounded)) return REDACTED;
  return redactObservabilityValue(bounded) === REDACTED ? REDACTED : bounded;
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
  CORRELATION_ID_RE,
  SENSITIVE_KEY_FRAGMENTS,
  ALLOWED_CONTEXT_KEYS,
  normalizedKey,
  isSensitiveObservabilityKey,
  isCorrelationIdentifier,
  redactObservabilityValue,
  safeDiagnosticToken,
  safeScalar,
  buildObservabilityContext,
};
