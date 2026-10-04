/**
 * Feature-awareness history: what a customer has already been shown, dismissed
 * or used, so a feature is introduced once instead of being advertised forever.
 *
 * WHAT THIS RECORDS. One small record per (feature, account), on this device:
 * whether the Home introduction was dismissed, whether the feature was opened,
 * whether it produced a result, and how the first-use tip was answered. It is
 * education state and nothing else -- it carries no content, no photo, no
 * product, and it authorizes nothing. A feature's real gates (entitlement,
 * consent, availability) never read it.
 *
 * WHY THIS IS A SHARED SERVICE AND NOT PART OF services/vto/. The same reason
 * services/thirdPartyAiConsent.ts is one: VTO-NC-010 bans device storage in
 * every VTO file, so the one thing that has to outlive a session lives here,
 * in a service with no network client and no knowledge of any feature's UI.
 * Features name themselves through the closed union below.
 *
 * ACCOUNT ISOLATION. The record is keyed by feature AND account, in device
 * storage and in the in-memory cache, and every read answers for whichever
 * actor is current at the moment of the call. Account B on a device where
 * account A dismissed a tip sees account B's own history. Signing out removes
 * nothing: the record stays under the account that made it, and that account
 * finds it again on its next sign-in. A signed-out reader gets `null`.
 *
 * DEVICE-LOCAL, DELIBERATELY. Nothing is written to the server, so a second
 * device starts from an empty history and may introduce the feature once more,
 * and reinstalling the app resets it. Synchronizing a tip's dismissal is not
 * worth a table.
 *
 * UNKNOWN IS NOT "NEVER SEEN". `null` -- nobody signed in, not read yet,
 * unreadable storage, a corrupt value -- means the history is unknown, and
 * callers show nothing on it. Only a record that was read back (or a missing
 * key, which is a genuine first run) lets an introduction appear.
 *
 * MONOTONIC. Every field only ever moves one way (false -> true, a count
 * upward), and reads and writes are merged rather than overwritten. A slow
 * read that lands after a dismissal therefore cannot undo it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getActorContext } from './actorContext';

/** Closed on purpose: adding a feature is a deliberate edit to this file. */
export const FEATURE_AWARENESS_FEATURES = ['virtual_try_on'] as const;
export type FeatureAwarenessFeature = (typeof FEATURE_AWARENESS_FEATURES)[number];

export interface FeatureAwarenessRecord {
  homeCardDismissed: boolean;
  initiated: boolean;
  completed: boolean;
  cueDismissed: boolean;
  cuePresentations: number;
}

export type FeatureAwarenessPatch = Partial<FeatureAwarenessRecord>;

export const EMPTY_FEATURE_AWARENESS: FeatureAwarenessRecord = Object.freeze({
  homeCardDismissed: false,
  initiated: false,
  completed: false,
  cueDismissed: false,
  cuePresentations: 0,
});

const KEY_PREFIX = 'kscan.featureAwareness.v1';
const MAX_PRESENTATIONS = 99;

/** Device-storage key for one account's history with one feature. */
export function featureAwarenessKey(feature: FeatureAwarenessFeature, actorId: string): string {
  return `${KEY_PREFIX}:${feature}:${actorId}`;
}

function cacheKey(feature: FeatureAwarenessFeature, actorId: string): string {
  return `${feature}:${actorId}`;
}

const cache = new Map<string, FeatureAwarenessRecord>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* a listener never breaks the store */
    }
  }
}

function currentActorId(): string | null {
  const actorId = getActorContext().actorId;
  return typeof actorId === 'string' && actorId ? actorId : null;
}

function isKnownFeature(value: unknown): value is FeatureAwarenessFeature {
  return typeof value === 'string' && (FEATURE_AWARENESS_FEATURES as readonly string[]).includes(value);
}

function boundedCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_PRESENTATIONS);
}

/** Field-wise union. Order of arguments never matters. */
function merge(left: FeatureAwarenessPatch, right: FeatureAwarenessPatch): FeatureAwarenessRecord {
  return {
    homeCardDismissed: left.homeCardDismissed === true || right.homeCardDismissed === true,
    initiated: left.initiated === true || right.initiated === true,
    completed: left.completed === true || right.completed === true,
    cueDismissed: left.cueDismissed === true || right.cueDismissed === true,
    cuePresentations: Math.max(boundedCount(left.cuePresentations), boundedCount(right.cuePresentations)),
  };
}

/**
 * A stored value, parsed. A missing key is a genuine first run and reads as
 * the empty record; anything present but malformed reads as `null` (unknown).
 */
function parseStored(raw: string | null): FeatureAwarenessRecord | null {
  if (raw === null) return EMPTY_FEATURE_AWARENESS;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return merge(parsed as FeatureAwarenessPatch, {});
  } catch {
    return null;
  }
}

/**
 * Synchronous: the CURRENT account's history, from memory only. `null` until a
 * load has put it there, and whenever nobody is signed in.
 */
export function getFeatureAwarenessNow(feature: FeatureAwarenessFeature): FeatureAwarenessRecord | null {
  if (!isKnownFeature(feature)) return null;
  const actorId = currentActorId();
  if (!actorId) return null;
  return cache.get(cacheKey(feature, actorId)) ?? null;
}

/**
 * Reads the current account's history from device storage into memory.
 *
 * The result is filed under the account that was current when the read
 * STARTED, so an account switch during the read cannot hand one account the
 * other's history. It is merged with anything already in memory, so a
 * dismissal recorded while the read was in flight survives it.
 */
export async function loadFeatureAwareness(
  feature: FeatureAwarenessFeature,
): Promise<FeatureAwarenessRecord | null> {
  if (!isKnownFeature(feature)) return null;
  const actorId = currentActorId();
  if (!actorId) return null;

  let stored: FeatureAwarenessRecord | null = null;
  try {
    stored = parseStored(await AsyncStorage.getItem(featureAwarenessKey(feature, actorId)));
  } catch {
    stored = null;
  }

  const key = cacheKey(feature, actorId);
  const inMemory = cache.get(key);
  if (stored) {
    cache.set(key, inMemory ? merge(stored, inMemory) : stored);
    notify();
  }
  // Unknown history: memory is left as it was. If this session already
  // recorded something for the actor it stays visible; otherwise the answer
  // remains `null` and nothing is introduced.
  return currentActorId() === actorId ? cache.get(key) ?? null : null;
}

/**
 * Records a change for the current account. Memory is updated first and
 * synchronously, so a dismissal is honoured on the very next render even if
 * the write is slow or fails; the write then merges with whatever storage
 * already holds. Resolves false when nobody is signed in or the write failed.
 */
export async function patchFeatureAwareness(
  feature: FeatureAwarenessFeature,
  patch: FeatureAwarenessPatch,
): Promise<boolean> {
  if (!isKnownFeature(feature)) return false;
  const actorId = currentActorId();
  if (!actorId) return false;

  const key = cacheKey(feature, actorId);
  cache.set(key, merge(cache.get(key) ?? {}, patch));
  notify();

  const storageKey = featureAwarenessKey(feature, actorId);
  try {
    let stored: FeatureAwarenessRecord | null = null;
    try {
      stored = parseStored(await AsyncStorage.getItem(storageKey));
    } catch {
      stored = null;
    }
    // Re-read memory after the await: a second change may have landed.
    const next = merge(stored ?? {}, cache.get(key) ?? patch);
    await AsyncStorage.setItem(storageKey, JSON.stringify(next));
    cache.set(key, merge(cache.get(key) ?? {}, next));
    return true;
  } catch {
    return false;
  }
}

/** Notified after any load or change, for any account. */
export function subscribeFeatureAwareness(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetFeatureAwarenessForTests(): void {
  cache.clear();
  listeners.clear();
}
