// Meta wearable companion — real backend client.
//
// AUTHORITY: the deployed `wearable-bridge` Edge Function (pairing, sessions,
// action ledger) plus `wearable-scan` / `wearable-save` / `wearable-open-on-phone`
// on K Scan AI Staging (project yzqjvdfgefveprobvvyw). This module intentionally
// mirrors kscan-glasses-webapp/src/companion/wearableBackend.js field-for-field —
// that file (and phoneCompanion.js, which drives it) is the verified reference
// for this contract. Do NOT reintroduce the retired `wearable-companion`
// function, its string protocolVersion, or its 8-character alphanumeric
// challenge codes: none of that was ever deployed and none of it matches what
// is live.
//
// TOPOLOGY NOTE (why this one module calls both "wearable" and "phone" shaped
// operations): there is no code running on the physical Meta glasses in this
// candidate build — Meta does not expose that. Exactly as the webapp reference
// documents ("the phone, standing in for the wearable in this reference
// topology"), the K Scan phone app mints its own pairing challenge (pair.create),
// approves it with its own identity (pair.approve), and claims the resulting
// session (pair.poll) — then uses that session token to call wearable-scan /
// wearable-save / wearable-open-on-phone itself, because the phone is the
// device actually doing the capture. `phone.poll` / `phone.send` (the durable
// wearable_messages relay for a real second device) exist on the bridge but
// are not used by any client in the reference implementation either, so they
// are not wired here — there is nothing on the other end of that relay yet.
//
// Trust model (see kscan-glasses-webapp/supabase/README.md): the phone is the
// auth authority. pair.approve/deny, phone.sessions/revoke* all require the
// phone's Supabase user JWT. pair.create/poll are unauthenticated by design
// (the wearable side has no identity yet) and are gated only by the
// pairingHandle+pairingSecret the creator receives back. wearable-scan/save/
// open-on-phone authenticate via the short-lived wearable session token
// (bearer-equivalent body field), never a refresh token.

import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabaseClient';
import { resolveAuthenticatedFunctionSession } from './authenticatedFunctionSession';

export const META_WEARABLE_PROTOCOL_VERSION = 1;
const PHONE_DEVICE_ID_STORAGE_KEY = 'metaWearable:phoneDeviceId';
const PAIR_CHALLENGE_TTL_MS = 60_000;

type WearableFunctionName = 'wearable-bridge' | 'wearable-scan' | 'wearable-save' | 'wearable-open-on-phone';

export class MetaWearableCompanionError extends Error {
  readonly code: string;

  constructor(code: string, message = 'The Meta companion request could not be completed.') {
    super(message);
    this.name = 'MetaWearableCompanionError';
    this.code = code;
  }
}

export type MetaWearablePairingChallenge = {
  wearableDeviceId: string;
  challengeCode: string;
  pairingHandle: string;
  pairingSecret: string;
  expiresAt: number;
};

export type MetaWearableSessionClaim = {
  wearableToken: string;
  sessionId: string;
  sessionExpiresAt: number | null;
  capabilities: string[];
};

export type MetaWearableSessionSummary = {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  expiresAt: string;
  lastSeenAt: string | null;
  createdAt: string;
};

export type MetaWearableScanResult = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readInvokeErrorCode(error: unknown): Promise<string | null> {
  try {
    const context = (error as { context?: { status?: unknown; json?: () => Promise<unknown> } } | undefined)?.context;
    if (!context || typeof context.json !== 'function') return null;
    const body = await context.json();
    if (!isPlainObject(body)) return null;
    return typeof body.code === 'string' && body.code.trim() ? body.code.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Shared invoke wrapper for all four wearable Edge Functions. Mirrors
 * wearableBackend.js's `safeInvoke` semantics exactly: only an explicit
 * `data.ok === false` is a failure. Several real success responses
 * (pair.create, pair.poll, phone.sessions, phone.action) never set `ok` at
 * all, so treating a missing `ok` as failure — as the retired invented
 * backend's client did — would reject every one of those calls.
 */
async function invokeWearableFn<T extends Record<string, unknown>>(
  functionName: WearableFunctionName,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke(functionName, { body });
  if (error) {
    const code = await readInvokeErrorCode(error);
    throw new MetaWearableCompanionError(code ?? 'WEARABLE_REQUEST_FAILED');
  }
  if (!isPlainObject(data)) throw new MetaWearableCompanionError('INVALID_RESPONSE');
  if (data.ok === false) {
    const code = typeof data.code === 'string' ? data.code : 'WEARABLE_REQUEST_FAILED';
    throw new MetaWearableCompanionError(code);
  }
  return data as T;
}

async function invokeBridge<T extends Record<string, unknown>>(
  operation: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  return invokeWearableFn<T>('wearable-bridge', { operation, ...body });
}

async function requirePhoneJwt(): Promise<void> {
  const auth = await resolveAuthenticatedFunctionSession();
  if (!auth.ok) throw new MetaWearableCompanionError('AUTH_REQUIRED');
}

// ── Phone device identity ───────────────────────────────────────────────────

/**
 * Stable per-install UUID identifying this phone to the bridge. Persisted
 * locally (not secret — it is only ever used as a non-authenticating
 * correlation id in pair.approve / frame validation, never as a credential).
 */
export async function getOrCreateMetaPhoneDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(PHONE_DEVICE_ID_STORAGE_KEY);
  if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) return existing;
  const created = Crypto.randomUUID();
  await AsyncStorage.setItem(PHONE_DEVICE_ID_STORAGE_KEY, created);
  return created;
}

// ── Pairing lifecycle (wearable-bridge) ─────────────────────────────────────

/**
 * pair.create — UNAUTHENTICATED. Mints a fresh UUID to stand in for the
 * wearable's backend identity (the bridge requires a UUID-shaped deviceId;
 * there is no real one yet) and asks the bridge for a 6-digit challenge code
 * plus the pairingHandle/pairingSecret needed to claim the session later.
 * Shape matches wearableBackend.js's createPairingChallenge exactly.
 */
export async function createMetaPairingChallenge(
  hudDeviceName = 'K Scan Meta HUD candidate',
): Promise<MetaWearablePairingChallenge> {
  const wearableDeviceId = Crypto.randomUUID();
  const requestId = Crypto.randomUUID();
  const now = Date.now();
  const frame = JSON.stringify({
    protocolVersion: META_WEARABLE_PROTOCOL_VERSION,
    messageType: 'pair.request',
    requestId,
    sessionId: '',
    deviceId: wearableDeviceId,
    timestamp: now,
    expiresAt: now + PAIR_CHALLENGE_TTL_MS,
    payload: { model: String(hudDeviceName || 'K Scan Meta HUD').slice(0, 80), appVersion: '' },
  });
  const data = await invokeBridge<{ ticket?: Record<string, unknown> }>('pair.create', { frame });
  const ticket = data.ticket;
  if (
    !isPlainObject(ticket) ||
    typeof ticket.challengeCode !== 'string' ||
    typeof ticket.pairingHandle !== 'string' ||
    typeof ticket.pairingSecret !== 'string'
  ) {
    throw new MetaWearableCompanionError('INVALID_RESPONSE');
  }
  return {
    wearableDeviceId,
    challengeCode: ticket.challengeCode,
    pairingHandle: ticket.pairingHandle,
    pairingSecret: ticket.pairingSecret,
    expiresAt: typeof ticket.expiresAt === 'number' ? ticket.expiresAt : now + PAIR_CHALLENGE_TTL_MS,
  };
}

/**
 * pair.approve — phone-JWT-authenticated. challengeCode must be the 6-digit
 * numeric code from createMetaPairingChallenge; phoneDeviceId must be a UUID.
 */
export async function approveMetaPairing(
  challengeCode: string,
  phoneDeviceId: string,
): Promise<{ pairingHandle: string | null; deviceModel: string | null }> {
  const trimmed = challengeCode.trim();
  if (!/^\d{6}$/u.test(trimmed)) throw new MetaWearableCompanionError('PAIR_CODE_INVALID');
  await requirePhoneJwt();
  const data = await invokeBridge<{ pairingHandle?: string; deviceModel?: string }>('pair.approve', {
    challengeCode: trimmed,
    phoneDeviceId,
  });
  return {
    pairingHandle: typeof data.pairingHandle === 'string' ? data.pairingHandle : null,
    deviceModel: typeof data.deviceModel === 'string' ? data.deviceModel : null,
  };
}

/** pair.deny — phone-JWT-authenticated, 6-digit numeric code. */
export async function denyMetaPairing(challengeCode: string): Promise<void> {
  const trimmed = challengeCode.trim();
  if (!/^\d{6}$/u.test(trimmed)) throw new MetaWearableCompanionError('PAIR_CODE_INVALID');
  await requirePhoneJwt();
  await invokeBridge('pair.deny', { challengeCode: trimmed });
}

/**
 * pair.poll — UNAUTHENTICATED; trust is the pairingHandle+pairingSecret pair.
 * Frames are JSON strings and must be parsed before inspection, exactly as
 * wearableBackend.js's pollPairing does.
 */
export async function pollMetaPairing(
  pairingHandle: string,
  pairingSecret: string,
): Promise<MetaWearableSessionClaim> {
  const data = await invokeBridge<{ poll?: { cursor?: number; frames?: unknown[]; wearableToken?: string } }>(
    'pair.poll',
    { pairingHandle, pairingSecret },
  );
  const poll = data.poll;
  if (!isPlainObject(poll) || !Array.isArray(poll.frames)) throw new MetaWearableCompanionError('INVALID_RESPONSE');
  const parsedFrames = poll.frames
    .map((raw) => {
      try {
        return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })
    .filter((frame): frame is Record<string, unknown> => frame !== null);
  if (parsedFrames.some((frame) => frame.messageType === 'pair.denied')) {
    throw new MetaWearableCompanionError('PAIR_DENIED');
  }
  if (parsedFrames.some((frame) => frame.messageType === 'pair.expired')) {
    throw new MetaWearableCompanionError('PAIR_EXPIRED');
  }
  const approved = parsedFrames.find((frame) => frame.messageType === 'pair.approved');
  const ready = parsedFrames.find((frame) => frame.messageType === 'session.ready');
  const wearableToken = typeof poll.wearableToken === 'string' ? poll.wearableToken : null;
  if (!wearableToken || !approved) throw new MetaWearableCompanionError('PAIR_PENDING');
  const approvedPayload = isPlainObject(approved.payload) ? approved.payload : {};
  const readyPayload = ready && isPlainObject(ready.payload) ? ready.payload : {};
  return {
    wearableToken,
    sessionId: typeof approved.sessionId === 'string' ? approved.sessionId : '',
    sessionExpiresAt: typeof approvedPayload.sessionExpiresAt === 'number' ? approvedPayload.sessionExpiresAt : null,
    capabilities: Array.isArray(readyPayload.features) ? (readyPayload.features as string[]) : [],
  };
}

/**
 * Convenience wrapper used by the UI: approve, then immediately claim the
 * session. Two separate bridge calls (matching the real three-step
 * pair.create → pair.approve → pair.poll flow) rather than the single
 * approve-and-get-session call the retired backend used.
 */
export async function approveAndClaimMetaSession(
  challengeCode: string,
  phoneDeviceId: string,
  pairingHandle: string,
  pairingSecret: string,
): Promise<MetaWearableSessionClaim> {
  await approveMetaPairing(challengeCode, phoneDeviceId);
  return pollMetaPairing(pairingHandle, pairingSecret);
}

// ── Session lifecycle (wearable-bridge, phone JWT) ──────────────────────────

function normalizeSessionRow(row: unknown): MetaWearableSessionSummary | null {
  if (!isPlainObject(row)) return null;
  const sessionId = typeof row.id === 'string' ? row.id : null;
  const deviceId = typeof row.device_id === 'string' ? row.device_id : null;
  const expiresAt = typeof row.expires_at === 'string' ? row.expires_at : null;
  if (!sessionId || !deviceId || !expiresAt) return null;
  const pairingRaw = row.wearable_pairings;
  const pairingRow = Array.isArray(pairingRaw) ? pairingRaw[0] : pairingRaw;
  const deviceName =
    isPlainObject(pairingRow) && typeof pairingRow.device_model === 'string' && pairingRow.device_model.trim()
      ? pairingRow.device_model
      : 'Meta Glasses';
  return {
    sessionId,
    deviceId,
    deviceName,
    expiresAt,
    lastSeenAt: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : expiresAt,
  };
}

/** phone.sessions — phone-JWT-authenticated. */
export async function listMetaWearableSessions(): Promise<MetaWearableSessionSummary[]> {
  await requirePhoneJwt();
  const data = await invokeBridge<{ sessions?: unknown[] }>('phone.sessions');
  const rows = Array.isArray(data.sessions) ? data.sessions : [];
  return rows.map(normalizeSessionRow).filter((row): row is MetaWearableSessionSummary => row !== null);
}

/** phone.revoke — revoke a single session (explicit unpair / device removal). */
export async function revokeMetaWearableSession(
  sessionId: string,
  reason: 'user_revoked' | 'sign_out' = 'user_revoked',
): Promise<void> {
  await requirePhoneJwt();
  await invokeBridge('phone.revoke', { sessionId, reason: reason === 'sign_out' ? 'sign_out' : 'user_revoked' });
}

/** phone.revoke_all — revoke every wearable session for the signed-in user (sign-out path). */
export async function revokeAllMetaWearableSessions(): Promise<void> {
  await requirePhoneJwt();
  await invokeBridge('phone.revoke_all');
}

// ── Scan / Save / Open-on-Phone (session-token authenticated) ──────────────

/**
 * wearable-scan — authenticates via the wearable session token in the body,
 * NOT a user JWT. `image` must already be a sanitized
 * `data:image/jpeg;base64,...` data URL (the phone privacy pipeline's output);
 * the server rejects anything else, including plain HTTPS URLs, to avoid an
 * SSRF surface and to keep raw captures off the wire.
 */
export async function submitMetaWearableScan(
  sessionToken: string,
  imageDataUrl: string,
  requestId: string,
): Promise<{ result: MetaWearableScanResult; requestId: string }> {
  const data = await invokeWearableFn<{ result?: unknown; requestId?: string }>('wearable-scan', {
    action: 'scan',
    sessionToken,
    image: imageDataUrl,
    requestId,
  });
  if (!isPlainObject(data.result)) throw new MetaWearableCompanionError('INVALID_RESPONSE');
  return {
    result: data.result,
    requestId: typeof data.requestId === 'string' ? data.requestId : requestId,
  };
}

/** wearable-save (`save`) — idempotent on resultId, session-token authenticated. */
export async function saveMetaWearableResult(
  sessionToken: string,
  result: MetaWearableScanResult,
  requestId: string,
): Promise<{ savedScanId: string | null; idempotent: boolean }> {
  const data = await invokeWearableFn<{ savedScanId?: string; idempotent?: boolean }>('wearable-save', {
    action: 'save',
    sessionToken,
    result,
    requestId,
  });
  return {
    savedScanId: typeof data.savedScanId === 'string' ? data.savedScanId : null,
    idempotent: data.idempotent === true,
  };
}

/**
 * wearable-save (`save_as_phone`) — phone-JWT-authenticated; the phone holds
 * no wearable token and instead proves ownership of the result via
 * wearable_results (the bridge already recorded it against this user).
 */
export async function saveMetaWearableResultAsPhone(
  resultId: string,
  requestId?: string,
): Promise<{ savedScanId: string | null; idempotent: boolean }> {
  await requirePhoneJwt();
  const data = await invokeWearableFn<{ savedScanId?: string; idempotent?: boolean }>('wearable-save', {
    action: 'save_as_phone',
    resultId,
    requestId: requestId ?? null,
  });
  return {
    savedScanId: typeof data.savedScanId === 'string' ? data.savedScanId : null,
    idempotent: data.idempotent === true,
  };
}

/** wearable-open-on-phone (`generate_link`) — session-token authenticated. */
export async function openMetaWearableResultOnPhone(
  sessionToken: string,
  resultId: string,
  result?: MetaWearableScanResult,
): Promise<{ deepLink: string }> {
  const data = await invokeWearableFn<{ deepLink?: string }>('wearable-open-on-phone', {
    action: 'generate_link',
    sessionToken,
    resultId,
    result: result ?? null,
  });
  if (typeof data.deepLink !== 'string' || !data.deepLink) throw new MetaWearableCompanionError('INVALID_RESPONSE');
  return { deepLink: data.deepLink };
}

// ── Local result cache ──────────────────────────────────────────────────────
//
// The bridge deliberately exposes no "fetch a wearable result by id" client
// operation: wearable_results has row-level security enabled with zero client
// policies (service-role/Edge-Function access only — see
// 20260819000001_add_wearable_pairing_session.sql), and wearable-open-on-phone
// returns only a deep link, not the result payload. In this self-contained
// candidate build the phone produces the result itself (submitMetaWearableScan
// returns it directly), so the deep-link handoff screen reads it from this
// process-local cache rather than re-fetching it from a backend endpoint that
// does not exist. This is a real, documented gap for a genuine second-device
// deployment (see the final report) — not a stand-in for a missed contract call.

const resultCache = new Map<string, MetaWearableScanResult>();

export function cacheMetaWearableResult(result: MetaWearableScanResult): void {
  const resultId = typeof result.resultId === 'string' ? result.resultId : null;
  if (!resultId) return;
  resultCache.set(resultId, result);
}

export function getCachedMetaWearableResult(resultId: string): MetaWearableScanResult | null {
  return resultCache.get(resultId) ?? null;
}
