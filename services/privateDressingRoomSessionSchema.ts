/**
 * Private Dressing Room session identifiers, allowlisted record construction,
 * and schema validation.
 *
 * Every function here is PURE and never mutates its input.
 * `migratePrivateDressingRoomSessionRecord` in particular RECONSTRUCTS through
 * the allowlist rather than editing the raw value, so a hostile or future record
 * cannot carry an unknown key forward simply by being on disk.
 *
 * NO v0 MIGRATION EXISTS, deliberately. This domain is greenfield: there is no
 * legacy private-session data anywhere, and inventing a migration for a shape
 * that never shipped would be inventing a "before" that has to be maintained
 * forever. The version seam below is what a real future migration hooks into —
 * an unsupported version is REFUSED, never guessed at.
 */

import * as ExpoCrypto from 'expo-crypto';
import {
  PRIVATE_DRESSING_ROOM_SESSION_SCHEMA_VERSION,
  PRIVATE_DRESSING_ROOM_SESSION_MAX_SUPPORTED_SCHEMA_VERSION,
  PRIVATE_DRESSING_ROOM_SESSION_STATUSES,
  PRIVATE_DRESSING_ROOM_SESSION_BOUNDS,
} from '../types/privateDressingRoomSession';
import type {
  PrivateDressingRoomSession,
  PrivateDressingRoomSessionStatus,
  PrivateDressingRoomSessionErrorCode,
} from '../types/privateDressingRoomSession';

let sessionIdCounter = 0;

// ── Identifiers ──────────────────────────────────────────────────────────────

/**
 * Collision-resistant random suffix.
 *
 * Mirrors services/closetCandidateSchema.js#randomSuffix exactly — the chain
 * already proven in this repository (Web Crypto -> expo-crypto -> Math.random),
 * because Hermes may ship without global Web Crypto. The final fallback is last,
 * not first: neither `Date.now()` nor `Math.random()` alone survives both a
 * same-millisecond burst and a process restart, and combining a monotonic
 * timestamp, a process-scoped counter and strong randomness does.
 */
function randomSuffix(): string {
  try {
    const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
      .crypto;
    if (crypto && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through
  }
  try {
    if (typeof ExpoCrypto.getRandomBytes === 'function') {
      const bytes = ExpoCrypto.getRandomBytes(8);
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through
  }
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(36);
  return `${rand()}${rand()}`;
}

/**
 * Mint an opaque session id.
 *
 * The actor id is deliberately NOT part of it: an id that encodes who owns it
 * leaks the owner to anything that can see the id, and authorization here is
 * done by comparing the record's `actorId` against the live actor context — not
 * by parsing an identifier. Adding a dependency for this was unnecessary; the
 * repository's proven generator shape is reused verbatim.
 */
export function createPrivateDressingRoomSessionId(): string {
  sessionIdCounter = (sessionIdCounter + 1) % 0x100000;
  return `drsession_${Date.now().toString(36)}_${sessionIdCounter.toString(36)}_${randomSuffix()}`;
}

// ── Field hygiene ────────────────────────────────────────────────────────────

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeActorId(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.actorId)
    : null;
}

export function isPrivateDressingRoomSessionStatus(
  value: unknown,
): value is PrivateDressingRoomSessionStatus {
  return (
    typeof value === 'string' &&
    (PRIVATE_DRESSING_ROOM_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

/** An ISO 8601 instant this build can round-trip. Fails closed. */
function cleanTimestamp(value: unknown): string | null {
  const text = cleanText(value, 40);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return text;
}

// ── Construction ─────────────────────────────────────────────────────────────

/**
 * Build a brand-new active session for an actor.
 *
 * `createdAt` and `updatedAt` start equal. `createdAt` is never written again by
 * any code path — see `reviseSession`, which is the ONLY way a stored session
 * changes and which structurally cannot alter it.
 */
export function buildPrivateDressingRoomSession(input: {
  actorId: string | null;
  anchorClosetItemId?: string | null;
  occasion?: string | null;
  now?: string;
}): PrivateDressingRoomSession {
  const timestamp = cleanTimestamp(input.now) ?? new Date().toISOString();
  return {
    sessionId: createPrivateDressingRoomSessionId(),
    actorId: normalizeActorId(input.actorId),
    anchorClosetItemId: cleanText(
      input.anchorClosetItemId,
      PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.anchorClosetItemId,
    ),
    occasion: cleanText(input.occasion, PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.occasion),
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: PRIVATE_DRESSING_ROOM_SESSION_SCHEMA_VERSION,
  };
}

/**
 * Produce the next value of an existing session.
 *
 * `createdAt`, `sessionId` and `actorId` are carried from the previous record
 * and are not patchable — a revision cannot re-home a session to another actor
 * or restart its clock. `updatedAt` always advances, because every caller of
 * this function is committing a real change; recovery paths that did NOT change
 * anything must not call it (see the store's `recoverActiveSession`).
 */
export function revisePrivateDressingRoomSession(
  previous: PrivateDressingRoomSession,
  patch: {
    anchorClosetItemId?: string | null;
    occasion?: string | null;
    status?: PrivateDressingRoomSessionStatus;
  },
  now?: string,
): PrivateDressingRoomSession {
  return {
    sessionId: previous.sessionId,
    actorId: previous.actorId,
    anchorClosetItemId:
      'anchorClosetItemId' in patch
        ? cleanText(
            patch.anchorClosetItemId,
            PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.anchorClosetItemId,
          )
        : previous.anchorClosetItemId,
    occasion:
      'occasion' in patch
        ? cleanText(patch.occasion, PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.occasion)
        : previous.occasion,
    status:
      patch.status && isPrivateDressingRoomSessionStatus(patch.status)
        ? patch.status
        : previous.status,
    createdAt: previous.createdAt,
    updatedAt: cleanTimestamp(now) ?? new Date().toISOString(),
    schemaVersion: PRIVATE_DRESSING_ROOM_SESSION_SCHEMA_VERSION,
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * FLAT, not a discriminated union, deliberately.
 *
 * This project compiles without `strictNullChecks` (expo/tsconfig.base sets no
 * `strict`), and under that setting TypeScript does not narrow a union by a
 * BOOLEAN literal discriminant: `if (!result.ok)` leaves `result` unnarrowed and
 * every field access on the failure branch is an error. Carrying all fields on
 * one shape is what this repository already does for TS result objects
 * (services/legalAcceptance.ts, services/closetCandidatePromotionContract.ts),
 * and it lets a caller read `errorCode` without a cast or a type guard.
 */
export type PrivateDressingRoomSessionMigration = {
  ok: boolean;
  record: PrivateDressingRoomSession | null;
  errorCode: PrivateDressingRoomSessionErrorCode | null;
};

/**
 * Validate one raw persisted record and RECONSTRUCT it through the allowlist.
 *
 * A future schema is refused with its own code so the UI can say "a newer
 * version of the app made this" rather than "your data is broken" — those are
 * different situations and only one of them is a corruption.
 */
export function migratePrivateDressingRoomSessionRecord(
  raw: unknown,
): PrivateDressingRoomSessionMigration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, record: null, errorCode: 'session_store_corrupt' };
  }
  const record = raw as Record<string, unknown>;

  const version = record.schemaVersion;
  if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) {
    return { ok: false, record: null, errorCode: 'session_store_corrupt' };
  }
  if (version > PRIVATE_DRESSING_ROOM_SESSION_MAX_SUPPORTED_SCHEMA_VERSION) {
    return { ok: false, record: null, errorCode: 'session_store_future_schema' };
  }

  const sessionId = cleanText(record.sessionId, PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.sessionId);
  if (!sessionId) return { ok: false, record: null, errorCode: 'session_store_corrupt' };

  if (!isPrivateDressingRoomSessionStatus(record.status)) {
    return { ok: false, record: null, errorCode: 'session_store_corrupt' };
  }

  const createdAt = cleanTimestamp(record.createdAt);
  const updatedAt = cleanTimestamp(record.updatedAt);
  if (!createdAt || !updatedAt) return { ok: false, record: null, errorCode: 'session_store_corrupt' };

  // `actorId` is intentionally NOT rejected when null: null is the signed-out
  // device-local partition, not a malformed value. A non-string, non-null
  // actorId normalizes to null and is then caught by the store's actor check,
  // which compares against the LIVE actor rather than trusting the file.
  return {
    ok: true,
    errorCode: null,
    record: {
      sessionId,
      actorId: normalizeActorId(record.actorId),
      anchorClosetItemId: cleanText(
        record.anchorClosetItemId,
        PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.anchorClosetItemId,
      ),
      occasion: cleanText(record.occasion, PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.occasion),
      status: record.status,
      createdAt,
      updatedAt,
      schemaVersion: PRIVATE_DRESSING_ROOM_SESSION_SCHEMA_VERSION,
    },
  };
}
