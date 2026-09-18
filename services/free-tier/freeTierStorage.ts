/**
 * Free Tier Utility Expansion — local-first storage helper.
 *
 * Wraps AsyncStorage with a versioned envelope. Defensive by design:
 * - never throws (all failures resolve to fallbacks / false)
 * - corrupt or wrong-version payloads are cleared and reset safely
 * - no raw images, auth tokens, precise location, or sensitive data
 * - no backend sync; device-local only
 *
 * ACCOUNT ISOLATION (B34-FE-FT-001)
 * Every store is PARTITIONED BY ACTOR, on the same rule services/library.js
 * uses for the Style Library:
 *
 *   - an authenticated actor reads and writes `<base>::u:<actorId>`
 *   - the signed-out device-local partition keeps the bare `<base>` key
 *   - an authenticated actor can neither see nor claim the ownerless partition
 *
 * The optional `userId` on the envelope was never a boundary: `readStore` did
 * not compare it, and the keys were flat, so User A's wishlist intents, care
 * notes, wear log, outfit feedback and activity log stayed readable by User B
 * after a sign-out / sign-in on the same installation, and survived an account
 * deletion. `clearAllFreeTierStores` existed for that and had no caller.
 *
 * The partition is derived from services/actorContext — the same authority the
 * Style Library, the Closet and every private Dressing Room store use — NOT
 * from a caller-supplied id and NOT from an auth lifecycle event. That matters:
 * a boundary that depended on an event would be missed by a force-quit, a
 * crash, a reinstall or a terminal session expiry, and a boundary that trusted
 * the caller would be as good as the least careful call site.
 *
 * NOTE ON PRE-PARTITION DATA. Records written before this change carry the bare
 * key, so they become the signed-out partition and are no longer visible to an
 * authenticated actor. Nothing is deleted; it is simply never handed to an
 * actor who cannot be proven to own it. This is the identical trade-off
 * services/library.js already documents ("never claimed by whoever happens to
 * be signed in"), and it is the only resolution available: an unstamped
 * envelope does not say who wrote it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getActorContext } from '../actorContext';
import {
  FREE_TIER_STORAGE_KEYS,
  type FreeTierStorageKey,
} from './wardrobeUtilityTypes';

const ENVELOPE_VERSION = 1;

/** Separator chosen so it cannot collide with any existing `kscan.freeTier.*` key. */
const ACTOR_KEY_PREFIX = '::u:';

function normalizeActorId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The live actor, or null for the signed-out device-local partition. */
function currentActorId(): string | null {
  try {
    return normalizeActorId(getActorContext().actorId);
  } catch {
    // An actor authority that cannot answer is never treated as "any actor":
    // falling back to the ownerless partition is the fail-closed direction,
    // because that partition is invisible to every authenticated reader.
    return null;
  }
}

/**
 * The physical AsyncStorage key for `key` in the current actor's partition.
 *
 * Exported for the sign-out/deletion sweep and for tests; call sites never
 * build a key themselves.
 */
export function resolveFreeTierStorageKey(
  key: FreeTierStorageKey,
  actorId: string | null = currentActorId(),
): string {
  const actor = normalizeActorId(actorId);
  return actor ? `${key}${ACTOR_KEY_PREFIX}${actor}` : key;
}

interface Envelope<T> {
  version: number;
  userId?: string;
  updatedAt: string;
  data: T;
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Envelope<unknown>).version === 'number' &&
    'data' in (value as Record<string, unknown>)
  );
}

/** Read a store. Returns `fallback` on missing, corrupt, or version-mismatched data. */
export async function readStore<T>(
  key: FreeTierStorageKey,
  fallback: T
): Promise<T> {
  const storageKey = resolveFreeTierStorageKey(key);
  try {
    const raw = await AsyncStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!isEnvelope(parsed) || parsed.version !== ENVELOPE_VERSION) {
      // Corrupt or future/older schema — reset safely rather than crash.
      await AsyncStorage.removeItem(storageKey).catch(() => undefined);
      return fallback;
    }
    return (parsed.data as T) ?? fallback;
  } catch {
    // JSON.parse failure or storage error — clear the bad key, fail silently.
    await AsyncStorage.removeItem(storageKey).catch(() => undefined);
    return fallback;
  }
}

/** Write a store. Returns true on success; never throws. */
export async function writeStore<T>(
  key: FreeTierStorageKey,
  data: T,
  userId?: string
): Promise<boolean> {
  // The PARTITION is the actor authority's answer, never `userId`. The
  // parameter is kept because the backend-sync layer passes the id it just
  // synced for, and it is still recorded on the envelope — but a caller that
  // passes the wrong id, or none, cannot move data out of its partition.
  const actorId = currentActorId();
  try {
    const envelope: Envelope<T> = {
      version: ENVELOPE_VERSION,
      userId: actorId ?? userId ?? undefined,
      updatedAt: new Date().toISOString(),
      data,
    };
    await AsyncStorage.setItem(resolveFreeTierStorageKey(key, actorId), JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

/** Read-modify-write helper. Updater must be pure; failures resolve to fallback. */
export async function updateStore<T>(
  key: FreeTierStorageKey,
  fallback: T,
  updater: (current: T) => T,
  userId?: string
): Promise<T> {
  const current = await readStore(key, fallback);
  let next: T;
  try {
    next = updater(current);
  } catch {
    return current;
  }
  await writeStore(key, next, userId);
  return next;
}

/**
 * Remove every free-tier utility store belonging to ONE actor.
 *
 * Defaults to the live actor. Pass `null` explicitly to sweep the signed-out
 * device-local partition. Never touches another actor's partition, so this
 * cannot be used — by accident or otherwise — to delete data the caller does
 * not own.
 *
 * Isolation does NOT depend on this being called: partitioned keys already
 * make one actor's data unreadable by another. This exists for the cases where
 * erasure, not invisibility, is what is wanted.
 */
export async function clearAllFreeTierStores(
  actorId: string | null = currentActorId(),
): Promise<void> {
  try {
    await AsyncStorage.multiRemove(
      Object.values(FREE_TIER_STORAGE_KEYS).map((key) =>
        resolveFreeTierStorageKey(key, actorId),
      ),
    );
  } catch {
    // best-effort
  }
}
