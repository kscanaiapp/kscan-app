import { supabase } from './supabaseClient';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/** True when Supabase URL + anon key are configured (project is reachable). */
export function isSupabaseProjectConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/**
 * @deprecated Use isSupabaseProjectConfigured() and check auth session state.
 * The manual-token path is no longer the production path.
 */
export function isPrivacyBackendConfigured() {
  return false;
}

async function resolveAccessToken() {
  // Always prefer the real session token — never stale after a token refresh.
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) {
    return data.session.access_token;
  }
  return null;
}

async function supabaseFetch(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      'Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.'
    );
  }
  const token = await resolveAccessToken();
  if (!token) {
    throw new Error('No authenticated session. Sign in to use account-level privacy features.');
  }
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      typeof data === 'string'
        ? data
        : data?.error || data?.message || `Supabase request failed (${response.status})`
    );
  }

  return data;
}

export async function ensurePrivacySettings() {
  return supabaseFetch('/rest/v1/rpc/ensure_privacy_settings', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function fetchProfile() {
  const rows = await supabaseFetch(
    '/rest/v1/profiles?select=id,account_status,age_group,deletion_requested_at,account_locked_at',
    { method: 'GET', headers: { Accept: 'application/json' } }
  );
  return Array.isArray(rows)
    ? rows[0] ?? { age_group: 'unknown', account_status: 'active' }
    : rows;
}

export async function updatePrivacySettings(patch) {
  const rows = await supabaseFetch('/rest/v1/privacy_settings?select=*', {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function requestDeletion() {
  return supabaseFetch('/functions/v1/handle-user-deletion', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function requestDataExport() {
  return supabaseFetch('/functions/v1/privacy-data-export', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function requestCorrection(requestedChanges) {
  return supabaseFetch('/functions/v1/privacy-correction-request', {
    method: 'POST',
    body: JSON.stringify({ requested_changes: requestedChanges }),
  });
}
