/**
 * Free Tier Utility Expansion — local-first storage helper.
 *
 * Wraps AsyncStorage with a versioned envelope. Defensive by design:
 * - never throws (all failures resolve to fallbacks / false)
 * - demonstrably corrupt payloads are cleared and reset safely
 * - a transient I/O fault NEVER destroys valid data (see READ FAULTS below)
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
 * CONVERGENCE NOTE (Build 34 cross-platform). The Android and iOS repair
 * candidates fixed this defect independently and did NOT agree. iOS partitioned
 * on `<base>::u:<actorId>` and left the BARE key as the signed-out partition;
 * Android partitioned on `<base>::<actorId>` with a dedicated `anonymous`
 * partition. This module is the converged implementation and takes, from each,
 * the property the other lacked:
 *
 *   - from Android: a DEDICATED anonymous partition (a signed-out reader must
 *     not be handed pre-upgrade data it cannot be shown to own), legacy
 *     adoption so an upgrading user keeps their own wardrobe notes, the
 *     envelope-stamp cross-check, and an owner pinned across a read-modify-write
 *     so an actor switch mid-update cannot commit A's data into B's partition;
 *   - from iOS: an actor authority that FAILS CLOSED when it cannot answer,
 *     rather than being assumed to have answered "signed out".
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
 *
 * ── READ FAULTS (P5-C2, promoted to P2) ──────────────────────────────────────
 *
 * The previous `readStore` wrapped the WHOLE read in one `try`, and its `catch`
 * removed the key before returning the fallback. That conflated two unrelated
 * conditions:
 *
 *   A. the payload is corrupt — unparseable JSON, not an envelope, or a
 *      version this build cannot read. The data is unusable; resetting it is
 *      the only way forward, and nothing of value is lost.
 *   B. `AsyncStorage.getItem` itself failed — the native layer threw. On
 *      Android that store is SQLite-backed and a read can fail transiently
 *      (database locked under concurrent access, disk pressure, or a
 *      CursorWindow too small for a large row). The payload is untouched and
 *      perfectly valid; only this one read did not complete.
 *
 * In case B the old code DELETED the user's valid data. Silently, permanently,
 * and — because the CursorWindow failure mode is size-correlated — preferentially
 * for the users with the most of it. Three of the ten stores (saved outfits,
 * utility meta, the pending-write sync queue) have no Supabase mirror at all, so
 * for those there is no recovery; erasing the sync queue additionally discards
 * writes that had not yet reached the server, so data that WOULD have become
 * recoverable never does. The audit recorded this as P5 on the reasoning that it
 * is pre-existing and needs a fault to trigger. Impact-based severity does not
 * work that way: this is unrecoverable destruction of user-authored content on
 * an ordinary recoverable condition, so it is P2 and it is repaired here.
 *
 * The read is therefore split. A failed `getItem` returns the fallback and
 * REMOVES NOTHING — the next read succeeds and the data is still there. Only a
 * blob that was read successfully and then proved unusable is cleared. A blob
 * stamped for a DIFFERENT actor is refused without being deleted: making it
 * invisible is the whole requirement, and it is not this actor's to destroy.
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
 * An actor id this module is willing to build a partition boundary from.
 *
 * Rejects, rather than repairs, anything that could blur that boundary:
 * a non-string, a blank string, the literal anonymous partition name, and any
 * id containing the separator (which could otherwise address a namespace it
 * does not own). `null` means "not a usable actor", never "signed out" — the
 * two are distinguished by the caller.
 */
function normalizeActorId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === ANONYMOUS_OWNER) return null;
  if (trimmed.includes(OWNER_SEPARATOR)) return null;
  return trimmed;
}

/**
 * The live actor, or null when there is none — or when the authority cannot
 * answer.
 *
 * Collapsing "cannot answer" onto the anonymous partition is the fail-closed
 * direction: the anonymous partition is invisible to every authenticated
 * reader and holds no account's data, so a broken authority degrades to
 * "this actor sees nothing", never to "this actor sees someone else's".
 */
function liveActorId(): string | null {
  try {
    return normalizeActorId(currentActorId());
  } catch {
    return null;
  }
}

type OwnerOutcome = { ok: true; owner: string } | { ok: false };

/**
 * The actor a call belongs to.
 *
 * An explicit id wins — freeTierSupabaseSync captures the id of the account
 * whose response it is applying, and that account may no longer be the live
 * actor by the time the response lands. Filing it under that account's
 * namespace is correct AND invisible to whoever is signed in now.
 *
 * An explicit id that is PRESENT BUT UNUSABLE refuses the operation outright
 * instead of falling through to the live actor. Falling through would be a
 * guess, and the thing it would guess is exactly the actor whose partition
 * must not receive another account's rows.
 */
function resolveOwner(explicitUserId?: string | null): OwnerOutcome {
  const supplied = typeof explicitUserId === 'string' ? explicitUserId.trim() : '';
  if (supplied) {
    const explicit = normalizeActorId(supplied);
    return explicit ? { ok: true, owner: explicit } : { ok: false };
  }
  return { ok: true, owner: liveActorId() ?? ANONYMOUS_OWNER };
}

function namespacedKey(key: FreeTierStorageKey, owner: string): string {
  return `${key}${OWNER_SEPARATOR}${owner}`;
}

async function removeQuietly(key: string): Promise<void> {
  await AsyncStorage.removeItem(key).catch(() => undefined);
}

/**
 * A read of the native layer, with "it failed" kept distinct from "it is empty".
 * This distinction is the whole of the P5-C2 repair: only the caller can know
 * that `{ ok: false }` must not lead to a delete.
 */
async function loadRaw(physicalKey: string): Promise<{ ok: true; raw: string | null } | { ok: false }> {
  try {
    return { ok: true, raw: await AsyncStorage.getItem(physicalKey) };
  } catch {
    return { ok: false };
  }
}

type EnvelopeOutcome<T> =
  /** Readable and owned by this actor. */
  | { status: 'ok'; data: T }
  /** Read fine, but unusable: not JSON, not an envelope, or a foreign version. */
  | { status: 'corrupt' }
  /** Readable and well-formed, but stamped for a different actor. */
  | { status: 'foreign' };

/** Classifies a blob that was READ SUCCESSFULLY. Never throws. */
function classifyEnvelope<T>(raw: string, owner: string): EnvelopeOutcome<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt' };
  }
  if (!isEnvelope(parsed) || parsed.version !== ENVELOPE_VERSION) return { status: 'corrupt' };
  // Defense in depth: the namespace already decided whose blob this is, but a
  // stamped envelope that disagrees is refused rather than trusted. An UNSTAMPED
  // envelope is accepted only because adoption (below) is what writes the stamp.
  const stamped = typeof parsed.userId === 'string' ? parsed.userId.trim() : '';
  if (stamped && owner !== ANONYMOUS_OWNER && stamped !== owner) return { status: 'foreign' };
  return { status: 'ok', data: parsed.data as T };
}

/**
 * One-time migration of a pre-namespace blob into this actor's namespace.
 *
 * Ordering is deliberate: the adoption write happens FIRST, and the legacy key
 * is dropped afterwards. If the write fails the legacy key still goes, because
 * leaving it readable is the cross-account leak this whole module exists to
 * close, and a device whose writes are failing has already lost that store.
 * The adopted value is still returned to the caller either way.
 *
 * A legacy key that could not be READ leaves everything exactly as it was:
 * that is the transient case, and it must be retried, not resolved by deletion.
 */
async function adoptLegacyBlob<T>(key: FreeTierStorageKey, owner: string): Promise<T | undefined> {
  if (owner === ANONYMOUS_OWNER) return undefined;

  const loaded = await loadRaw(key);
  if (!loaded.ok || !loaded.raw) return undefined;

  const envelope = classifyEnvelope<T>(loaded.raw, owner);
  if (envelope.status !== 'ok') {
    // A blob nobody can parse is not adoptable and must not stay readable.
    await removeQuietly(key);
    return undefined;
  }

  await writeOwned(key, envelope.data, owner);
  // Removing the legacy key IS the "at most once" guarantee: there is nothing
  // left for a second actor to adopt, on this launch or any later one.
  await removeQuietly(key);
  return envelope.data;
}

/** Read for an ALREADY-RESOLVED owner. */
async function readOwned<T>(key: FreeTierStorageKey, fallback: T, owner: string): Promise<T> {
  const physicalKey = namespacedKey(key, owner);

  const loaded = await loadRaw(physicalKey);
  // P5-C2: the read failed, the payload did not. Removing the key here is what
  // destroyed valid user data; the fallback alone is the correct answer, and
  // the next read finds everything still in place.
  if (!loaded.ok) return fallback;

  if (loaded.raw === null) {
    const adopted = await adoptLegacyBlob<T>(key, owner);
    return adopted ?? fallback;
  }

  const envelope = classifyEnvelope<T>(loaded.raw, owner);
  if (envelope.status === 'corrupt') {
    // Established corruption — reset this actor's copy safely rather than crash.
    await removeQuietly(physicalKey);
    return fallback;
  }
  if (envelope.status === 'foreign') {
    // Invisible is the requirement; destroying another actor's misfiled row is
    // not, and would be the same class of mistake as the leak itself.
    return fallback;
  }
  return envelope.data ?? fallback;
}

/** Write for an ALREADY-RESOLVED owner. */
async function writeOwned<T>(key: FreeTierStorageKey, data: T, owner: string): Promise<boolean> {
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

/**
 * Read a store.
 *
 * Returns `fallback` on missing data, on corrupt data, on a blob belonging to
 * another actor, on an unusable explicit owner, and on a transient read fault.
 * Only the corrupt case deletes anything.
 */
export async function readStore<T>(
  key: FreeTierStorageKey,
  fallback: T,
  userId?: string,
): Promise<T> {
  const resolved = resolveOwner(userId);
  if (!resolved.ok) return fallback;
  try {
    return await readOwned(key, fallback, resolved.owner);
  } catch {
    // Nothing above is expected to throw; if it somehow does, the safe answer
    // is the fallback — never a delete.
    return fallback;
  }
}

/** Write a store. Returns true on success; never throws. */
export async function writeStore<T>(
  key: FreeTierStorageKey,
  data: T,
  userId?: string
): Promise<boolean> {
  const resolved = resolveOwner(userId);
  if (!resolved.ok) return false;
  return writeOwned(key, data, resolved.owner);
}

/** Read-modify-write helper. Updater must be pure; failures resolve to fallback. */
export async function updateStore<T>(
  key: FreeTierStorageKey,
  fallback: T,
  updater: (current: T) => T,
  userId?: string
): Promise<T> {
  // The owner is resolved ONCE and pinned across both halves. An actor switch
  // that lands between the read and the write therefore cannot commit the
  // first actor's rows into the second actor's partition, and an explicit
  // userId can never read one actor's copy and write it into another's.
  const resolved = resolveOwner(userId);
  if (!resolved.ok) return fallback;
  const owner = resolved.owner;

  let current: T;
  try {
    current = await readOwned(key, fallback, owner);
  } catch {
    current = fallback;
  }
  let next: T;
  try {
    next = updater(current);
  } catch {
    return current;
  }
  await writeOwned(key, next, owner);
  return next;
}

export type FreeTierActorPurgeResult = {
  /** True only when every store for this actor is known to be gone. */
  ok: boolean;
  /** The actor actually purged; '' when the call was refused. */
  actorId: string;
  /** The physical keys this call targeted. Empty when refused. */
  targetedKeys: string[];
  reason?: 'missing_actor' | 'storage_error';
};

/**
 * Remove every free-tier utility store belonging to ONE named actor.
 *
 * CPR-FT-001. Before B34-FE-FT-001 these stores were device-global, and
 * services/deletion/ownerTerminalPurge.ts classified them — correctly, at the
 * time — as device state that no account deletion may take. B34-FE-FT-001 made
 * them owner-filed and did not revisit that classification, so terminal
 * deletion left the deleted actor's wishlist, saved outfits, collections, care
 * notes, wear log, brand sizing, outfit ratings and activity log sitting on the
 * device under their namespace. Invisible to the next account, but not erased,
 * and a deletion that does not erase is not a deletion. This is the primitive
 * that closes it.
 *
 * THE TARGET IS SUPPLIED AND NEVER INFERRED. Terminal cleanup runs after the
 * departed actor's session is gone and frequently while a DIFFERENT actor is
 * signed in, so this function deliberately does not consult the actor
 * authority at all. There is no default argument: an absent, blank or
 * otherwise unusable id refuses the call and removes nothing, because a blank
 * owner would address the anonymous partition — device-local history that no
 * account deletion may take.
 *
 * IT CANNOT OVER-REACH. It names `<logical key>::<actorId>` for the ten known
 * logical keys and nothing else: no `getAllKeys()` listing, no prefix sweep, no
 * `AsyncStorage.clear()`, no wildcard. Another actor's partition, the anonymous
 * partition and the pre-namespace legacy key are all unreachable from here by
 * construction — the legacy key included, because an unstamped blob cannot be
 * shown to belong to the account being deleted.
 *
 * IT IS IDEMPOTENT. Removing a key that is already absent is a no-op, so a
 * partially completed earlier run, a store this actor never wrote, and a
 * second full run are all indistinguishable and all succeed.
 */
export async function clearFreeTierStoresForActor(
  actorId: string,
): Promise<FreeTierActorPurgeResult> {
  const owner = normalizeActorId(actorId);
  if (!owner) {
    return { ok: false, actorId: '', targetedKeys: [], reason: 'missing_actor' };
  }

  const targetedKeys = (Object.values(FREE_TIER_STORAGE_KEYS) as FreeTierStorageKey[]).map((key) =>
    namespacedKey(key, owner),
  );

  try {
    await AsyncStorage.multiRemove(targetedKeys);
    return { ok: true, actorId: owner, targetedKeys };
  } catch {
    // A failed batch is retried key by key so one bad row cannot strand the
    // other nine. The caller retries the whole purge later either way.
    let allRemoved = true;
    for (const physicalKey of targetedKeys) {
      try {
        await AsyncStorage.removeItem(physicalKey);
      } catch {
        allRemoved = false;
      }
    }
    return allRemoved
      ? { ok: true, actorId: owner, targetedKeys }
      : { ok: false, actorId: owner, targetedKeys, reason: 'storage_error' };
  }
}

/**
 * Remove every free-tier utility store for EVERY actor on this device, plus any
 * pre-namespace legacy key.
 *
 * Deliberately still not called from the auth transition — see ACTOR ISOLATION
 * above for why clearing there would erase a user's own data on every cold
 * start — and deliberately NOT the primitive terminal deletion uses: it would
 * take a still-signed-in actor's data with it. Terminal deletion calls
 * `clearFreeTierStoresForActor`. This is the explicit "wipe this device" helper.
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
  normalizeActorId,
  resolveOwner,
};
