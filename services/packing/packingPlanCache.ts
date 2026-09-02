// K+ Packing Intelligence V1 — offline plan cache (UX-4).
//
// WHY THIS EXISTS. People pack on a plane, in a hotel with bad wifi, in a taxi.
// V1 held the plan in memory only, so backgrounding the app far enough, or
// losing the process, lost the plan and the only way back was another K+
// generation the traveller could not make offline.
//
// THIS IS A NEW DURABLE PERSONAL-DATA CLASS, AND THAT IS NOT A SMALL THING.
// packingPlanStore.ts records that V1 deliberately persisted NOTHING, because a
// durable trip record needs its own privacy, export and deletion story. This
// adds the smallest possible version of one, and states its limits plainly:
//
//   - it stores exactly ONE plan per actor, the most recent successful one
//   - it stores nothing the plan did not already contain (garment titles and
//     colours from the actor's own Closet, the destination, the dates) -- no
//     new field, no imagery, no identity beyond the actor key itself
//   - it is device-local; it is never uploaded and never leaves the phone
//   - it is cleared on EVERY actor boundary (sign-in, sign-out, user change)
//
// THE ACTOR BOUNDARY IS ENFORCED BY THE KEY, NOT BY THE DELETE. Clearing is
// async and an app can be killed mid-clear, so correctness may not depend on
// the delete having run. Every entry is stored under a key containing the
// actor id and every read supplies the actor it is reading for, so a record
// left behind by another account is not merely deleted-eventually, it is
// unaddressable. That is the same discipline getPackingSnapshotFor() applies in
// memory, and the delete is the backstop rather than the mechanism.
//
// KNOWN INHERITED GAP, RECORDED NOT HIDDEN: this project has no terminal
// account-deletion local purge yet (services/accountDeletion.js: "Nothing here
// may purge local Recent Scans or unlink media -- that stays gated behind the
// terminal-status endpoint, which is not built yet"). This cache inherits that
// gap exactly as Recent Scans and Style DNA preferences already do. It is
// cleared on sign-out, which is the boundary that actually occurs; a purged
// account's residue on a device is a pre-existing project-wide item and needs
// the same owner decision they do.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PackingPlan } from '../../types/packing';

const CACHE_PREFIX = 'kscan/packing/plan/v1/';

/** One plan, bounded. A cache that can grow is a cache that becomes a database. */
const MAX_SERIALIZED_BYTES = 128 * 1024;

/**
 * How long a cached plan may still be shown. A trip plan is about specific
 * dates; a month-old one is clutter, not a convenience.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CachedPackingPlan {
  plan: PackingPlan;
  message: string | null;
  /** Epoch ms the plan was generated. Shown to the traveller, never invented. */
  cachedAt: number;
  /** Item ids the traveller has ticked off. Local-only; never sent anywhere. */
  packedOff: string[];
}

function cacheKey(actorId: string): string {
  return `${CACHE_PREFIX}${actorId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read this actor's cached plan, or null.
 *
 * Re-validates rather than trusting what came off disk: storage is as untrusted
 * as the wire. A record whose actor does not match the caller is refused even
 * though the key already scopes it -- the same belt-and-braces the retrieval
 * layer applies over RLS.
 */
export async function readCachedPackingPlan(
  actorId: string | null,
  now: () => number = Date.now,
): Promise<CachedPackingPlan | null> {
  if (!actorId) return null;
  try {
    const raw = await AsyncStorage.getItem(cacheKey(actorId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.actorId !== actorId) return null;
    if (!isRecord(parsed.plan)) return null;
    const cachedAt = typeof parsed.cachedAt === 'number' ? parsed.cachedAt : 0;
    if (!cachedAt || now() - cachedAt > MAX_AGE_MS) {
      void clearCachedPackingPlan(actorId);
      return null;
    }
    return {
      plan: parsed.plan as unknown as PackingPlan,
      message: typeof parsed.message === 'string' ? parsed.message : null,
      cachedAt,
      packedOff: Array.isArray(parsed.packedOff)
        ? parsed.packedOff.filter((id): id is string => typeof id === 'string').slice(0, 64)
        : [],
    };
  } catch {
    // A cache that cannot be read is simply an absent cache. It is never an
    // error the traveller has to see, and never a reason to fail a plan.
    return null;
  }
}

/** Persist this actor's most recent plan. Failures are silent and harmless. */
export async function writeCachedPackingPlan(input: {
  actorId: string | null;
  plan: PackingPlan;
  message: string | null;
  packedOff?: string[];
  now?: () => number;
}): Promise<void> {
  if (!input.actorId) return;
  try {
    const payload = JSON.stringify({
      actorId: input.actorId,
      plan: input.plan,
      message: input.message,
      cachedAt: (input.now ?? Date.now)(),
      packedOff: (input.packedOff ?? []).slice(0, 64),
    });
    // An oversized plan is not cached at all rather than truncated: half a plan
    // restored offline would be a plan the server never produced.
    if (payload.length > MAX_SERIALIZED_BYTES) return;
    await AsyncStorage.setItem(cacheKey(input.actorId), payload);
  } catch {
    // Caching is a convenience. It may never turn a successful plan into a
    // failure the traveller sees.
  }
}

/** Update only the ticked-off set, leaving the cached plan itself untouched. */
export async function writeCachedPackedOff(
  actorId: string | null,
  packedOff: string[],
  now: () => number = Date.now,
): Promise<void> {
  if (!actorId) return;
  // Reads through the SAME freshness check as any other read, so ticking a box
  // on a plan that has just aged out quietly does nothing rather than
  // resurrecting an expired record.
  const existing = await readCachedPackingPlan(actorId, now);
  if (!existing) return;
  await writeCachedPackingPlan({
    actorId,
    plan: existing.plan,
    message: existing.message,
    packedOff,
    // Ticking a box is not a new plan, so the generation time must not move.
    now: () => existing.cachedAt,
  });
}

/** Drop this actor's cached plan. */
export async function clearCachedPackingPlan(actorId: string | null): Promise<void> {
  if (!actorId) return;
  try {
    await AsyncStorage.removeItem(cacheKey(actorId));
  } catch {
    /* best effort; the actor-scoped key is what actually enforces isolation */
  }
}

/**
 * Drop EVERY cached plan on this device, for every actor.
 *
 * Called from the one shared actor reset. The departing actor's id is not
 * always knowable at that point (a sign-out may arrive with no session), so
 * this sweeps the namespace rather than guessing which key to remove.
 */
export async function clearAllCachedPackingPlans(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((key) => key.startsWith(CACHE_PREFIX));
    if (mine.length > 0) await AsyncStorage.multiRemove(mine);
  } catch {
    /* best effort; reads are actor-scoped so a survivor is still unreadable */
  }
}
