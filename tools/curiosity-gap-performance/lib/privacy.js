'use strict';
/**
 * Privacy guard for the performance lab.
 *
 * The lab models STRUCTURE and BYTES. It never needs a real customer payload,
 * a real user id, a token, or a private media URL — so any appearance of one
 * is a bug in whatever fed the lab, not an input to be quietly scrubbed.
 *
 * Policy (deliberate): UNSAFE INPUT FAILS. It is not redacted. A silent
 * redaction would let a pipeline keep shipping customer data into artifacts
 * that get committed to a public repository; a hard failure stops it.
 */

/** Field names that must never appear anywhere in a lab artifact. */
const PROHIBITED_KEYS = Object.freeze([
  'user_id', 'userId', 'uid', 'auth_user_id',
  'email', 'email_address', 'phone', 'phone_number', 'msisdn',
  'jwt', 'access_token', 'refresh_token', 'id_token', 'bearer',
  'authorization', 'apikey', 'api_key', 'secret', 'password',
  'signed_url', 'signedUrl', 'image_url', 'imageUrl', 'image_base64',
  'imageBase64', 'photo_uri', 'photoUri', 'scan_image', 'avatar_url',
  'transcript', 'voice_transcript', 'latitude', 'longitude', 'lat', 'lng',
  'closet_media', 'vto_media', 'gps',
]);

/** Value shapes that betray a credential or a private locator. */
const PROHIBITED_VALUE_PATTERNS = Object.freeze([
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/ },
  { name: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: 'supabase_publishable_key', re: /\bsb_(publishable|secret)_[A-Za-z0-9_-]{8,}/ },
  { name: 'signed_storage_url', re: /[?&]token=[A-Za-z0-9._-]{16,}/ },
  { name: 'data_uri_image', re: /^data:image\/[a-z+]+;base64,/i },
  { name: 'long_base64_blob', re: /^[A-Za-z0-9+/]{512,}={0,2}$/ },
]);

class PrivacyViolationError extends Error {
  constructor(violations) {
    super(
      `lab input rejected: ${violations.length} privacy violation(s): ` +
        violations.map((v) => `${v.path} (${v.reason})`).join(', '),
    );
    this.name = 'PrivacyViolationError';
    this.violations = violations;
  }
}

function scanForViolations(node, path = '$', out = [], seen = new WeakSet()) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') {
    for (const pattern of PROHIBITED_VALUE_PATTERNS) {
      if (pattern.re.test(node)) out.push({ path, reason: `value matches ${pattern.name}` });
    }
    return out;
  }
  if (typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);

  if (Array.isArray(node)) {
    node.forEach((item, i) => scanForViolations(item, `${path}[${i}]`, out, seen));
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    const childPath = `${path}.${key}`;
    if (PROHIBITED_KEYS.includes(key)) {
      out.push({ path: childPath, reason: `prohibited key "${key}"` });
    }
    scanForViolations(value, childPath, out, seen);
  }
  return out;
}

/** Returns the input unchanged, or throws. Never mutates, never redacts. */
function assertPrivacySafe(value, label = 'input') {
  const violations = scanForViolations(value, `$${label === 'input' ? '' : `(${label})`}`);
  if (violations.length > 0) throw new PrivacyViolationError(violations);
  return value;
}

function isPrivacySafe(value) {
  return scanForViolations(value).length === 0;
}

module.exports = {
  PROHIBITED_KEYS,
  PROHIBITED_VALUE_PATTERNS,
  PrivacyViolationError,
  assertPrivacySafe,
  isPrivacySafe,
  scanForViolations,
};
