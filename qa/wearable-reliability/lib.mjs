import crypto from 'node:crypto';

export const BASE = 'https://yzqjvdfgefveprobvvyw.supabase.co';
export const FN_URL = `${BASE}/functions/v1/wearable-bridge`;
export const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6cWp2ZGZnZWZ2ZXByb2J2dnl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3MjA3MzUsImV4cCI6MjA5NDI5NjczNX0.G2KhgpTyccVauWdRpC67v3bOxXhygnDb_MROnr6MwWE';
// The wearable-bridge function's `withSupabase({ auth: ["publishable","secret"] })`
// wrapper expects the modern sb_publishable_... key on the `apikey` header for
// unauthenticated calls (matches KSCAN_WEARABLE_PUBLISHABLE_KEY in local.properties
// / what HttpWearableBridgeApi actually sends) — the legacy anon JWT is rejected.
export const PUBLISHABLE_KEY = 'sb_publishable_vyI28NK--LQTNWS1lfLmaw_oHjRARjJ';
export const PROTOCOL_VERSION = 1;

export function uuid() {
  return crypto.randomUUID();
}

// Byte-for-byte reimplementation of java.util.UUID.nameUUIDFromBytes: MD5 of the
// input, version nibble set to 3, variant bits set to RFC4122 10xx. This is the
// exact algorithm the Kotlin fix (stableActionId) now uses, so deriving actionId
// this way in the harness gives a true end-to-end check of the fix, not just an
// independent simulation.
export function nameUUIDv3(str) {
  const md5 = crypto.createHash('md5').update(str, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function stableActionId(type, resultId) {
  return nameUUIDv3(`${type}:${resultId}`);
}

export function frame(messageType, sessionId, deviceId, payload, expiresAt) {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    messageType,
    requestId: uuid(),
    sessionId,
    deviceId,
    timestamp: Date.now(),
    expiresAt: expiresAt ?? null,
    payload,
  });
}

export async function callFn(body, jwt) {
  // Matches the real glasses client (HttpWearableBridgeApi): apikey header only,
  // no Authorization, for unauthenticated calls. Authorization is added only when
  // a real user JWT is supplied (phone-side authenticated operations).
  const headers = {
    'Content-Type': 'application/json',
    apikey: PUBLISHABLE_KEY,
  };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const res = await fetch(FN_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  let json;
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

export async function signUp(email, password) {
  const res = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  return { status: res.status, json };
}

export async function signIn(email, password) {
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  return { status: res.status, json };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
