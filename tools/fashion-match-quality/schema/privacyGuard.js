'use strict';

/**
 * Privacy guard (spec section 25).
 *
 * Recursively rejects any object that carries a prohibited key or a value
 * matching a prohibited pattern (JWT-shaped strings, data URIs carrying
 * base64 media, precise GPS pairs). Applied to fixture manifests, baseline
 * artifacts, replay files, and reports before they are accepted/written.
 *
 * FAILS CLOSED: on violation, callers must reject the input outright. This
 * module never silently strips a field and continues - spec section 25 is
 * explicit that silent stripping is not acceptable.
 */

const PROHIBITED_KEYS = new Set([
  'user_id', 'userid', 'userId',
  'email',
  'phone', 'phone_number', 'phoneNumber',
  'jwt',
  'auth_token', 'authtoken', 'authToken',
  'refresh_token', 'refreshtoken', 'refreshToken',
  'access_token', 'accesstoken', 'accessToken',
  'device_id', 'deviceid', 'deviceId',
  'customer_id', 'customerid', 'customerId',
  'storage_token', 'storageToken',
  'signed_url', 'signedUrl', 'signedURL',
  'data_uri', 'dataUri', 'dataURI', 'base64_image', 'base64Image',
  'gps', 'precise_gps', 'preciseGps', 'lat_lng', 'latLng',
  'voice_transcript', 'voiceTranscript', 'transcript',
  'vto_customer_media', 'vtoCustomerMedia',
  'closet_customer_media', 'closetCustomerMedia',
  'dressing_room_customer_media', 'dressingRoomCustomerMedia',
  'password', 'ssn', 'passport',
]);

// Value-shape checks independent of key name, so a differently-named field
// carrying the same class of secret is still caught.
const VALUE_PATTERNS = [
  { name: 'jwt_shaped_string', re: /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/ },
  { name: 'data_uri_base64_media', re: /^data:(image|video|audio)\/[a-zA-Z0-9.+-]+;base64,/ },
  { name: 'bearer_token', re: /^Bearer\s+[A-Za-z0-9._-]{10,}$/ },
  { name: 'precise_gps_pair', re: /^-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}$/ },
  { name: 'supabase_service_role_like', re: /^sb[a-z_]*_(secret|service)_[A-Za-z0-9]{10,}$/ },
];

function keyIsProhibited(key) {
  return PROHIBITED_KEYS.has(key) || PROHIBITED_KEYS.has(String(key).toLowerCase());
}

function valueViolatesPattern(value) {
  if (typeof value !== 'string') return null;
  for (const p of VALUE_PATTERNS) {
    if (p.re.test(value.trim())) return p.name;
  }
  return null;
}

/**
 * Recursively scan `input` for privacy violations.
 * Returns { safe: boolean, violations: Array<{ path, reason }> }.
 */
function scanForPrivacyViolations(input, path = '$') {
  const violations = [];

  function walk(node, currentPath) {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, `${currentPath}[${idx}]`));
      return;
    }

    if (typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const childPath = `${currentPath}.${key}`;
        if (keyIsProhibited(key)) {
          violations.push({ path: childPath, reason: `prohibited_key:${key}` });
          continue; // do not also value-scan a field we already rejected
        }
        walk(node[key], childPath);
      }
      return;
    }

    const patternHit = valueViolatesPattern(node);
    if (patternHit) {
      violations.push({ path: currentPath, reason: `prohibited_value_pattern:${patternHit}` });
    }
  }

  walk(input, path);
  return { safe: violations.length === 0, violations };
}

/** Throws if unsafe. Use at write/accept boundaries (fail closed). */
function assertPrivacySafe(input, label = 'input') {
  const result = scanForPrivacyViolations(input);
  if (!result.safe) {
    const summary = result.violations.map((v) => `${v.path} (${v.reason})`).join('; ');
    throw new Error(`PRIVACY_GUARD_REJECTED[${label}]: ${summary}`);
  }
  return result;
}

module.exports = { scanForPrivacyViolations, assertPrivacySafe, PROHIBITED_KEYS, VALUE_PATTERNS };
