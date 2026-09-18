/**
 * Free Tier Utility Expansion — local-first storage helper.
 *
 * Wraps AsyncStorage with a versioned envelope. Defensive by design:
 * - never throws (all failures resolve to fallbacks / false)
 * - corrupt or wrong-version payloads are cleared and reset safely
 * - no raw images, auth tokens, precise location, or sensitive data
 * - no backend sync; device-local only
 *
 * ── ACTOR ISOLATION (B34-FE-FT-001) ──────────────────────────────────────────
 *
 * THE DEFECT THIS CLOSES. Every store used to live at ONE device-wide key
 * (`kscan.freeTier.wishlistIntent.v1`, …). `writeStore` stamped the envelope
 * with a `userId` "for future per-user isolation" and `readStore` never looked
 * at it, and nothing ever called `clearAllFreeTierStores()` — its own comment
 * said "safe to call on sign-out if wired later", and it was never wired. So on
 * a device where one account signed out and another signed in, the arriving
 * account read the departing account's wishlist, saved outfits, collections,
 * care notes, wear log, brand sizing, outfit ratings and activity log. The
 * master switch and the wishlist and outfit-generator surfaces are all true on
 * the production EAS profile, so this was live, not latent. Deleting the
 * account did not help either: the rows are local and nothing removed them.
 *
 * THE FIX. The physical key is namespaced by the owning actor, resolved from
 * the project's existing actor authority (services/actorScope -> actorContext,
 * the same epoch AuthSessionContext advances on every auth transition). No call
 * site changes: the namespace is applied here, under the logical key every
 * consumer already passes.
 *
 * WHY NOT "CLEAR ON SIGN-OUT". resetActorScopedRuntimeState() runs on every
 * actor BOUNDARY, and a cold start with a restored session is a boundary — the
 * guard's first noteActor() call returns true. Clearing there would erase the
 * user's own wardrobe notes on every launch, which is a worse defect than the
 * one being fixed. Namespacing makes the previous actor's data unreadable
 * without destroying anybody's.
 *
 * TWO INDEPENDENT CHECKS. The namespace decides which blob is read; the
 * envelope's own `userId` is then verified against the same owner. Either one
 * alone would close the reported leak — together, a blob that somehow lands
 * under the wrong namespace is still refused.
 *
 * THE UPGRADE PATH, AND ITS ONE HONEST LIMIT. Data written before this change
 * carries no namespace. On an actor's first read of a given store, a legacy
 * blob is ADOPTED into that actor's namespace and the legacy key is removed, so
 * an existing user keeps their data across the upgrade and no SECOND actor can
 * ever adopt it. The unavoidable residue: on a device already shared by two
 * accounts before this build, whichever account opens the app first inherits
 * the legacy blob. That is one bounded window on already-shared devices,
 * against today's permanent leak in both directions. Discarding legacy data
 * outright would close it, at the cost of silently deleting the wardrobe notes
 * of every single-account user on upgrade.
 *
 * SIGNED OUT is its own partition ('anonymous'), never the legacy key: a
 * signed-out reader must not be able to adopt or read an account's data.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { currentActorId } from '../actorScope';
import {
  FREE_TIER_STORAGE_KEYS,
  type FreeTierStorageKey,
} from './wardrobeUtilityTypes';

const ENVELOPE_VERSION = 1;

/** Separator for the actor namespace. Not a character any logical key uses. */
const OWNER_SEPARATOR = '::';

/** The signed-out partition. Deliberately not a real user id. */
const ANONYMOUS_OWNER = 'anonymous';

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

/**
 * The actor a call belongs to.
 *
 * An explicit id wins — freeTierSupabaseSync passes the id of the account whose
 * response it is applying, which may no longer be the live actor by the time it
 * lands. Writing it under that account's namespace is correct AND invisible to
 * whoever is signed in now.
 */
function resolveOwner(explicitUserId?: string): string {
  const explicit = typeof explicitUserId === 'string' ? explicitUserId.trim() : '';
  if (explicit) return explicit;
  const live = currentActorId();
  return typeof live === 'string' && live.trim() ? live.trim() : ANONYMOUS_OWNER;
}

function namespacedKey(key: FreeTierStorageKey, owner: string): string {
  return `${key}${OWNER_SEPARATOR}${owner}`;
}

/** Parses a stored blob, rejecting anything that is not this actor's. */
function readEnvelope<T>(raw: string | null, owner: string): { ok: true; data: T } | { ok: false } {
  if (!raw) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!isEnvelope(parsed) || parsed.version !== ENVELOPE_VERSION) return { ok: false };
  // Defense in depth: the namespace already decided whose blob this is, but a
  // stamped envelope that disagrees is refused rather than trusted. An UNSTAMPED
  // envelope is accepted only because adoption (below) is what writes the stamp.
  const stamped = typeof parsed.userId === 'string' ? parsed.userId.trim() : '';
  if (stamped && owner !== ANONYMOUS_OWNER && stamped !== owner) return { ok: false };
  return { ok: true, data: parsed.data as T };
}

async function removeQuietly(key: string): Promise<void> {
  await AsyncStorage.removeItem(key).catch(() => undefined);
}

/**
 * One-time migration of a pre-namespace blob into this actor's namespace.
 *
 * The legacy key is removed whether or not the adoption write succeeds: leaving
 * it readable is the leak, and a failed write costs one store's local data
 * rather than reopening cross-account reads.
 */
async function adoptLegacyBlob<T>(key: FreeTierStorageKey, owner: string): Promise<T | undefined> {
  if (owner === ANONYMOUS_OWNER) return undefined;

  let legacyRaw: string | null;
  try {
    legacyRaw = await AsyncStorage.getItem(key);
  } catch {
    return undefined;
  }
  if (!legacyRaw) return undefined;

  await removeQuietly(key);

  const envelope = readEnvelope<T>(legacyRaw, owner);
  if (!envelope.ok) return undefined;

  await writeStore(key, envelope.data, owner);
  return envelope.data;
}

/** Read a store. Returns `fallback` on missing, corrupt, or version-mismatched data. */
export async function readStore<T>(
  key: FreeTierStorageKey,
  fallback: T,
  userId?: string,
): Promise<T> {
  const owner = resolveOwner(userId);
  const physicalKey = namespacedKey(key, owner);
  try {
    const raw = await AsyncStorage.getItem(physicalKey);
    if (!raw) {
      const adopted = await adoptLegacyBlob<T>(key, owner);
      return adopted ?? fallback;
    }
    const envelope = readEnvelope<T>(raw, owner);
    if (!envelope.ok) {
      // Corrupt, future/older schema, or stamped for a different actor — reset
      // this actor's copy safely rather than crash or leak.
      await removeQuietly(physicalKey);
      return fallback;
    }
    return envelope.data ?? fallback;
  } catch {
    // Storage error — clear the bad key, fail silently.
    await removeQuietly(physicalKey);
    return fallback;
  }
}

/** Write a store. Returns true on success; never throws. */
export async function writeStore<T>(
  key: FreeTierStorageKey,
  data: T,
  userId?: string
): Promise<boolean> {
  const owner = resolveOwner(userId);
  try {
    const envelope: Envelope<T> = {
      version: ENVELOPE_VERSION,
      userId: owner === ANONYMOUS_OWNER ? undefined : owner,
      updatedAt: new Date().toISOString(),
      data,
    };
    await AsyncStorage.setItem(namespacedKey(key, owner), JSON.stringify(envelope));
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
  // The SAME owner resolves the read and the write, so an explicit userId can
  // never read one actor's copy and write it into another's.
  const owner = resolveOwner(userId);
  const current = await readStore(key, fallback, owner);
  let next: T;
  try {
    next = updater(current);
  } catch {
    return current;
  }
  await writeStore(key, next, owner);
  return next;
}

/**
 * Remove every free-tier utility store for EVERY actor on this device, plus any
 * pre-namespace legacy key.
 *
 * Deliberately still not called from the auth transition — see ACTOR ISOLATION
 * above for why clearing there would erase a user's own data on every cold
 * start. This is the explicit "wipe this device" helper.
 */
export async function clearAllFreeTierStores(): Promise<void> {
  const logicalKeys = Object.values(FREE_TIER_STORAGE_KEYS) as string[];
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const doomed = allKeys.filter((candidate) =>
      logicalKeys.some(
        (logical) => candidate === logical || candidate.startsWith(`${logical}${OWNER_SEPARATOR}`),
      ),
    );
    if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);
  } catch {
    // best-effort; fall back to the legacy keys we can name without a listing.
    await AsyncStorage.multiRemove(logicalKeys).catch(() => undefined);
  }
}

/** Test seam only. Not used by production code. */
export const __freeTierStorageInternals = {
  ANONYMOUS_OWNER,
  OWNER_SEPARATOR,
  namespacedKey,
  resolveOwner,
};
