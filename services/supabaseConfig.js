/**
 * Public Supabase configuration validation.
 *
 * Pure, dependency-free, and shared by the runtime client and the tests. No
 * function here ever places key material in a returned message, so every
 * result is safe to log or display.
 */

function decodeBase64Url(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  try {
    if (typeof atob === 'function') return atob(padded);
    if (typeof Buffer !== 'undefined') return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
  return null;
}

/**
 * Reads only the `ref` claim. The signature is never verified — this is a
 * configuration-consistency check, not an authentication decision.
 */
function readLegacyJwtProjectRef(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  const payload = decodeBase64Url(parts[1]);
  if (!payload) return null;
  try {
    const { ref } = JSON.parse(payload);
    return typeof ref === 'string' && ref ? ref : null;
  } catch {
    return null;
  }
}

function classifyKey(key) {
  if (!key) return 'absent';
  if (key.startsWith('sb_publishable_')) return 'publishable';
  if (key.startsWith('eyJ')) return 'legacy_jwt';
  return 'unknown';
}

/**
 * Validates the public Supabase configuration before a client is built, so a
 * misconfigured build fails with a named cause instead of surfacing later as an
 * indistinguishable auth error.
 *
 * @param {string|null|undefined} rawUrl
 * @param {string|null|undefined} rawKey
 * @returns {{ok: boolean, code: string, message: string, urlProjectRef: string|null, keyProjectRef: string|null, keyType: string}}
 */
function validateSupabaseConfig(rawUrl, rawKey) {
  const url = (rawUrl ?? '').trim();
  const key = (rawKey ?? '').trim();
  const keyType = classifyKey(key);
  const keyProjectRef = keyType === 'legacy_jwt' ? readLegacyJwtProjectRef(key) : null;
  const base = { urlProjectRef: null, keyProjectRef, keyType };

  if (!url) {
    return { ...base, ok: false, code: 'missing_url', message: 'EXPO_PUBLIC_SUPABASE_URL is not set.' };
  }
  if (!key) {
    return { ...base, ok: false, code: 'missing_key', message: 'EXPO_PUBLIC_SUPABASE_ANON_KEY is not set.' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ...base, ok: false, code: 'malformed_url', message: 'EXPO_PUBLIC_SUPABASE_URL is not a valid URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ...base, ok: false, code: 'insecure_url', message: 'EXPO_PUBLIC_SUPABASE_URL must use https.' };
  }

  const host = parsed.host;
  if (!host.endsWith('.supabase.co')) {
    return { ...base, ok: false, code: 'unexpected_host', message: `EXPO_PUBLIC_SUPABASE_URL host is not a Supabase host (${host}).` };
  }

  const urlProjectRef = host.slice(0, -'.supabase.co'.length);
  if (!urlProjectRef) {
    return { ...base, ok: false, code: 'unexpected_host', message: `EXPO_PUBLIC_SUPABASE_URL host has no project ref (${host}).` };
  }

  // Only a legacy JWT carries a ref claim; a publishable key cannot be cross-checked.
  if (keyProjectRef && keyProjectRef !== urlProjectRef) {
    return {
      ok: false,
      code: 'project_mismatch',
      message: `Supabase URL project (${urlProjectRef}) and key project (${keyProjectRef}) do not match.`,
      urlProjectRef,
      keyProjectRef,
      keyType,
    };
  }

  return { ok: true, code: 'ok', message: 'Supabase configuration is valid.', urlProjectRef, keyProjectRef, keyType };
}

module.exports = { validateSupabaseConfig };
