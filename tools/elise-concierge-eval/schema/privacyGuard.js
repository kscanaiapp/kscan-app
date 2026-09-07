'use strict';

/**
 * PRIVACY guard — spec section 55.
 *
 * Recursively rejects real-looking user identifiers, secrets, tokens, and
 * media references anywhere inside a fixture or artifact. Fails CLOSED: a
 * fixture the guard cannot confidently clear is rejected, never silently
 * redacted and passed through (spec is explicit: "Fail unsafe fixtures --
 * never silently redact and continue").
 *
 * Written fresh for this lane; not imported from any other research branch
 * (parallel-lane firewall). Deliberately independent of, and narrower in
 * scope than, this repo's production _shared/aiSecurity/inputLimits.ts
 * secret-redaction patterns — this guard's job is to REJECT a fixture
 * outright, not to sanitize live model input.
 */

const PATTERNS = [
  { id: 'JWT', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { id: 'BEARER_TOKEN', re: /\bBearer\s+[A-Za-z0-9._\-]{10,}\b/i },
  { id: 'AUTHORIZATION_HEADER', re: /\bAuthorization\s*:\s*\S+/i },
  { id: 'API_KEY_LIKE', re: /\b(?:sk-|AIza|ghp_|xox[baprs]-)[A-Za-z0-9._\-]{8,}\b/ },
  { id: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { id: 'PHONE', re: /\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/ },
  { id: 'UUID', re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/ },
  { id: 'SUPABASE_STORAGE_URL', re: /\bhttps?:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/[^\s"']+/i },
  { id: 'SIGNED_URL_TOKEN', re: /[?&]token=[A-Za-z0-9_\-.]{16,}/ },
  { id: 'PRECISE_GPS', re: /\b-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}\b/ },
  { id: 'DEVICE_ID_LIKE', re: /\b(?:ExponentPushToken|GCM|APNs)\[[^\]]+\]/ },
  { id: 'FILE_URI', re: /\b(?:file|content):\/\/[^\s"']+/i },
  { id: 'DATA_URI_MEDIA', re: /\bdata:(?:image|audio|video)\/[a-z0-9.+-]+;base64,/i },
];

const FORBIDDEN_KEY_NAMES = new Set([
  'realUserId', 'authToken', 'refreshToken', 'accessToken', 'jwt', 'password',
  'ssn', 'socialSecurityNumber', 'deviceId', 'pushToken', 'voiceRecordingUrl',
  'rawVoiceTranscript', 'closetMediaUrl', 'userPhotoUrl',
]);

/**
 * Scan a fixture-shaped value recursively. Returns a list of violations, each
 * { path, patternId|reason }. Empty list means the guard found nothing.
 */
function scan(value, path = '$') {
  const violations = [];
  if (value === null || value === undefined) return violations;

  if (typeof value === 'string') {
    for (const { id, re } of PATTERNS) {
      if (re.test(value)) violations.push({ path, patternId: id });
    }
    return violations;
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => violations.push(...scan(v, `${path}[${i}]`)));
    return violations;
  }

  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY_NAMES.has(key)) {
        violations.push({ path: `${path}.${key}`, reason: `forbidden key name "${key}"` });
        continue;
      }
      violations.push(...scan(v, `${path}.${key}`));
    }
    return violations;
  }

  return violations;
}

/**
 * @returns {{ safe: boolean, violations: Array<{path: string, patternId?: string, reason?: string}> }}
 */
function checkPrivacy(fixtureLikeValue) {
  const violations = scan(fixtureLikeValue);
  return { safe: violations.length === 0, violations };
}

module.exports = { checkPrivacy, PATTERNS, FORBIDDEN_KEY_NAMES };
