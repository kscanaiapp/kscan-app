/**
 * Pending terminal-deletion markers — keychain-only, owner-bound, multi-record.
 *
 * WHAT THIS HOLDS. One record per deletion lifecycle this device started:
 * the raw Repair 06 capability, the owner scope its local data is filed under,
 * and just enough bookkeeping to resume a partially completed purge. Nothing
 * else. No email, no display name, no session material, no lifecycle detail
 * beyond what the terminal decision needs.
 *
 * WHY EXPO-SECURE-STORE DIRECTLY, AND NOT `secureSessionStorage`. That adapter
 * is the app's Supabase-session storage authority and is the right home for
 * session material, but it is not usable for this: its read path migrates from
 * AsyncStorage, its write path clears an AsyncStorage copy, and on web it IS
 * AsyncStorage. A bearer capability must never touch AsyncStorage on any
 * platform. This module therefore uses the SAME underlying secure storage
 * dependency the app already ships (`expo-secure-store`, the platform
 * keychain/keystore) with no plaintext fallback of any kind — it is not a
 * second secrets architecture, it is the existing one without the migration
 * path that would leak.
 *
 * WHY IT SURVIVES LOGOUT. Deletion intake revokes the session, so the app
 * signs out moments after the marker is written. Sign-out clears auth secrets
 * through `clearPersistedAuthSessions()`, which removes only the keys the
 * Supabase auth storage adapter has itself observed
 * (services/authSessionBootstrap.ts `clearPersistedSessions`). These keys are
 * never written through that adapter, so they are structurally outside its
 * reach. That is the mechanism, and it is asserted by test rather than assumed.
 *
 * WHY MULTIPLE RECORDS. The device is not one actor's. A can have a deletion
 * pending, B can sign in, and A can be purged afterwards; A can also delete,
 * restore, and delete again, producing two distinct capabilities. A single
 * global slot would let the newer lifecycle silently destroy the older one's
 * only means of ever being resolved.
 *
 * WHY THE INDEX IS ALSO IN THE KEYCHAIN. It names record ids only — never a
 * receipt, never a hash of one — but it also names owner ids, which are
 * account identifiers, so it belongs behind the same protection.
 */

import * as SecureStore from 'expo-secure-store';

/** SecureStore keys are restricted to [A-Za-z0-9._-]; these fit that alphabet. */
const INDEX_KEY = 'kscan.deletion.pendingIndex.v1';
const RECORD_KEY_PREFIX = 'kscan.deletion.pending.v1.';

export const PENDING_DELETION_INDEX_KEY = INDEX_KEY;
export const PENDING_DELETION_RECORD_KEY_PREFIX = RECORD_KEY_PREFIX;

export const PENDING_DELETION_SCHEMA_VERSION = 1;

/**
 * How the backend responded to the capability this device supplied.
 *
 *  - `unconfirmed` — the marker was persisted but no intake response has been
 *    observed yet. This is the LOST-RESPONSE state, and it is deliberately
 *    still resolvable: the request may well have committed, and the whole
 *    point of pre-creating the capability is that such a lifecycle stays
 *    observable. A lookup that finds nothing simply returns not-found, which
 *    never authorises anything.
 *  - `bound` — the backend reported `statusReceiptBound: true`. Provably
 *    trackable.
 *  - `unbound` — the backend reported `statusReceiptBound: false`. The hash did
 *    not reach the database, so this capability can never resolve a lifecycle.
 *  - `unsupported` — the response carried no `statusReceiptBound` field at all,
 *    i.e. a backend without Repair 06. Same consequence, different cause, and
 *    worth distinguishing because it is a deployment fact rather than a failure.
 */
export type ReceiptBindingState = 'unconfirmed' | 'bound' | 'unbound' | 'unsupported';

/** Where a terminal purge got to. Only `complete` may retire a record. */
export type TerminalPurgeState = 'not_started' | 'in_progress' | 'complete';

export type PendingDeletionRecord = {
  schemaVersion: number;
  /** Random, unrelated to the capability. Never derived from the receipt. */
  recordId: string;
  /**
   * The raw capability, or null once it can no longer resolve anything
   * (`unbound` / `unsupported`) — holding a useless secret is strictly worse
   * than dropping it.
   */
  receipt: string | null;
  /**
   * The Supabase user id every owner-scoped local store files this actor's
   * records under. Captured at intake because the Auth user may no longer
   * exist by the time terminal cleanup runs.
   */
  ownerId: string;
  bindingState: ReceiptBindingState;
  purgeState: TerminalPurgeState;
  createdAt: string;
  /** ISO timestamp of the last completed status lookup, for bounded pacing. */
  lastCheckedAt: string | null;
  /** Public lifecycle state last observed, or null before the first lookup. */
  lastKnownState: string | null;
};

export type SecureStoreLike = {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
};

type Deps = { store?: SecureStoreLike; now?: () => Date; randomId?: () => string };

function resolveStore(deps: Deps): SecureStoreLike {
  return deps.store ?? (SecureStore as unknown as SecureStoreLike);
}

function recordKey(recordId: string): string {
  return `${RECORD_KEY_PREFIX}${recordId}`;
}

/** Record ids are opaque and local; 16 hex chars is ample and key-safe. */
function defaultRandomId(): string {
  const bytes = new Uint8Array(8);
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    // A record id is a local lookup handle, not a secret: unlike the receipt
    // it authorises nothing, so a non-CSPRNG fallback here is a collision
    // question, not a security one.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function normalizeOwnerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{4,64}$/.test(value);
}

function parseIndex(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of parsed) {
    if (!isRecordId(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Fails closed on anything it cannot fully understand. A half-parsed marker
 * could otherwise carry a valid receipt with a missing owner scope, and the
 * purge orchestrator would have a capability but no idea whose data to remove.
 */
function parseRecord(raw: string | null): PendingDeletionRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== PENDING_DELETION_SCHEMA_VERSION) return null;
  if (!isRecordId(value.recordId)) return null;

  const ownerId = normalizeOwnerId(value.ownerId);
  if (!ownerId) return null;

  const bindingState = value.bindingState;
  if (
    bindingState !== 'unconfirmed' &&
    bindingState !== 'bound' &&
    bindingState !== 'unbound' &&
    bindingState !== 'unsupported'
  ) {
    return null;
  }

  const purgeState = value.purgeState;
  if (purgeState !== 'not_started' && purgeState !== 'in_progress' && purgeState !== 'complete') {
    return null;
  }

  const receipt = typeof value.receipt === 'string' && value.receipt ? value.receipt : null;
  const createdAt = typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : null;
  if (!createdAt) return null;

  return {
    schemaVersion: PENDING_DELETION_SCHEMA_VERSION,
    recordId: value.recordId,
    receipt,
    ownerId,
    bindingState,
    purgeState,
    createdAt,
    lastCheckedAt:
      typeof value.lastCheckedAt === 'string' && value.lastCheckedAt ? value.lastCheckedAt : null,
    lastKnownState:
      typeof value.lastKnownState === 'string' && value.lastKnownState
        ? value.lastKnownState
        : null,
  };
}

async function readIndex(store: SecureStoreLike): Promise<string[]> {
  try {
    return parseIndex(await store.getItemAsync(INDEX_KEY));
  } catch {
    return [];
  }
}

async function writeIndex(store: SecureStoreLike, ids: string[]): Promise<void> {
  await store.setItemAsync(INDEX_KEY, JSON.stringify(ids));
}

/**
 * Creates and durably persists a marker.
 *
 * ORDER IS LOAD-BEARING: the record is written before the index. A crash
 * between the two leaves an unreferenced record (recoverable, invisible) rather
 * than an index entry pointing at a capability that was never stored.
 *
 * @throws when the keychain write fails. The caller MUST let that abort the
 * deletion request: submitting first and persisting after is exactly the
 * failure mode this whole capability exists to prevent.
 */
export async function persistPendingDeletion(
  input: { receipt: string; ownerId: string },
  deps: Deps = {},
): Promise<PendingDeletionRecord> {
  const store = resolveStore(deps);
  const ownerId = normalizeOwnerId(input.ownerId);
  if (!ownerId) throw new Error('A pending deletion marker requires an owner scope.');
  if (typeof input.receipt !== 'string' || !input.receipt) {
    throw new Error('A pending deletion marker requires a capability.');
  }

  const now = (deps.now ?? (() => new Date()))();
  const record: PendingDeletionRecord = {
    schemaVersion: PENDING_DELETION_SCHEMA_VERSION,
    recordId: (deps.randomId ?? defaultRandomId)(),
    receipt: input.receipt,
    ownerId,
    bindingState: 'unconfirmed',
    purgeState: 'not_started',
    createdAt: now.toISOString(),
    lastCheckedAt: null,
    lastKnownState: null,
  };

  await store.setItemAsync(recordKey(record.recordId), JSON.stringify(record));
  const ids = await readIndex(store);
  if (!ids.includes(record.recordId)) {
    await writeIndex(store, [...ids, record.recordId]);
  }
  return record;
}

/** Every readable marker. Unparseable entries are skipped, never guessed at. */
export async function listPendingDeletions(deps: Deps = {}): Promise<PendingDeletionRecord[]> {
  const store = resolveStore(deps);
  const ids = await readIndex(store);
  const records: PendingDeletionRecord[] = [];
  for (const id of ids) {
    let raw: string | null = null;
    try {
      raw = await store.getItemAsync(recordKey(id));
    } catch {
      continue;
    }
    const record = parseRecord(raw);
    if (record) records.push(record);
  }
  return records;
}

export async function readPendingDeletion(
  recordId: string,
  deps: Deps = {},
): Promise<PendingDeletionRecord | null> {
  if (!isRecordId(recordId)) return null;
  const store = resolveStore(deps);
  try {
    return parseRecord(await store.getItemAsync(recordKey(recordId)));
  } catch {
    return null;
  }
}

/**
 * Patches one marker in place.
 *
 * Refuses to widen: `ownerId`, `recordId`, `schemaVersion` and `createdAt` are
 * immutable, so a bookkeeping update can never silently retarget a purge at a
 * different account.
 */
export async function updatePendingDeletion(
  recordId: string,
  patch: Partial<
    Pick<
      PendingDeletionRecord,
      'receipt' | 'bindingState' | 'purgeState' | 'lastCheckedAt' | 'lastKnownState'
    >
  >,
  deps: Deps = {},
): Promise<PendingDeletionRecord | null> {
  const store = resolveStore(deps);
  const existing = await readPendingDeletion(recordId, deps);
  if (!existing) return null;
  const next: PendingDeletionRecord = {
    ...existing,
    ...('receipt' in patch ? { receipt: patch.receipt ?? null } : {}),
    ...(patch.bindingState ? { bindingState: patch.bindingState } : {}),
    ...(patch.purgeState ? { purgeState: patch.purgeState } : {}),
    ...('lastCheckedAt' in patch ? { lastCheckedAt: patch.lastCheckedAt ?? null } : {}),
    ...('lastKnownState' in patch ? { lastKnownState: patch.lastKnownState ?? null } : {}),
  };
  await store.setItemAsync(recordKey(recordId), JSON.stringify(next));
  return next;
}

/**
 * Destroys one marker: the capability first, then the index entry.
 *
 * Call this ONLY after every required owner cleanup step has succeeded, or for
 * a lifecycle that resolved without any destruction (restored). Removing it
 * early is unrecoverable — the capability is the sole means of ever learning
 * the outcome, and it exists nowhere else.
 *
 * Touches nothing but this record's own two keys, so another actor's markers
 * and every unrelated secure record are untouched by construction.
 */
export async function removePendingDeletion(recordId: string, deps: Deps = {}): Promise<void> {
  if (!isRecordId(recordId)) return;
  const store = resolveStore(deps);
  try {
    await store.deleteItemAsync(recordKey(recordId));
  } catch {
    // Fall through: the index entry must still go, or a permanently
    // unreadable record would be retried forever.
  }
  const ids = await readIndex(store);
  const next = ids.filter((id) => id !== recordId);
  if (next.length !== ids.length) await writeIndex(store, next);
}

/** Test/diagnostic seam. Verifies no raw capability remains for a record. */
export async function pendingDeletionReceiptPresent(
  recordId: string,
  deps: Deps = {},
): Promise<boolean> {
  const record = await readPendingDeletion(recordId, deps);
  return typeof record?.receipt === 'string' && record.receipt.length > 0;
}
