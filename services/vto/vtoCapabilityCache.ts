/**
 * Bounded cache for the native Live-VTO capability self-check.
 *
 * WHY. `describeLiveVtoNativeCapability()` crosses the Expo bridge into the
 * native module on every call. The module HANDLE is already memoized
 * (services/vto/liveVtoNativeModule.ts), but `getCapability()` itself is not,
 * so a shelf of ten product cards -- each mounting its own Try On action and
 * each asking the mode authority -- performed ten native calls, and did so
 * again on every remount. A capability answer does not change between two
 * product cards rendered in the same frame, and mission section 10 forbids
 * invoking native capability discovery on every render.
 *
 * WHAT IS CACHED, AND WHAT IS NOT. Only the module's own self-check answer
 * (present / capable / runtimeReady / runtimeVersion / provenance). Nothing
 * about the device, the person, the camera, or the session. Nothing is
 * written to disk: this is a module-scoped value that dies with the JS
 * context, so an app restart is already a full invalidation and there is NO
 * PERSISTENT DEVICE FINGERPRINT of any kind -- by construction, not by
 * policy.
 *
 * INVALIDATION. Three triggers, all explicit:
 *   - app restart (the JS context, and therefore this module, is new)
 *   - `resetLiveVtoCapabilityCache()`, called from the same actor-boundary
 *     and native-module-reset seams the existing caches already use
 *   - a bounded TTL, so a runtime that finishes initializing after the first
 *     (correctly conservative) "no" is not locked out until relaunch
 *
 * FAIL-CLOSED IS PRESERVED. This module never turns a "no" into a "yes"; it
 * only avoids asking the same question twice inside the TTL, and a negative
 * answer is cached for a SHORTER window than a positive one for exactly that
 * reason.
 */

import {
  describeLiveVtoNativeCapability,
  resetLiveVtoNativeModuleCache,
  type LiveVtoNativeCapability,
} from './liveVtoNativeModule';

/** A capable runtime does not spontaneously become incapable; re-asking often
 *  buys nothing. */
export const LIVE_CAPABILITY_POSITIVE_TTL_MS = 300_000;
/** A runtime that is still initializing WILL become capable, so an unready
 *  answer is held only briefly. */
export const LIVE_CAPABILITY_NEGATIVE_TTL_MS = 15_000;

interface CacheEntry {
  value: LiveVtoNativeCapability;
  expiresAt: number;
}

let entry: CacheEntry | null = null;

/** Clears the memo AND the underlying optional-module lookup, so a genuine
 *  native state change re-discovers from scratch rather than re-reading a
 *  stale handle. */
export function resetLiveVtoCapabilityCache(): void {
  entry = null;
  resetLiveVtoNativeModuleCache();
}

/** Test/diagnostic read. Never used to make a decision. */
export function peekLiveVtoCapabilityCache(): LiveVtoNativeCapability | null {
  return entry?.value ?? null;
}

function ttlFor(value: LiveVtoNativeCapability): number {
  return value.present === true && value.capable === true && value.runtimeReady === true
    ? LIVE_CAPABILITY_POSITIVE_TTL_MS
    : LIVE_CAPABILITY_NEGATIVE_TTL_MS;
}

/**
 * The cached self-check. Synchronous and total, exactly like the uncached
 * call it wraps -- a capability question that can hang is a VTO surface that
 * can hang.
 */
export function getLiveVtoCapability(deps?: {
  nowMs?: number;
  describe?: typeof describeLiveVtoNativeCapability;
}): LiveVtoNativeCapability {
  const now = deps?.nowMs ?? Date.now();
  if (entry && entry.expiresAt > now) return entry.value;
  const describe = deps?.describe ?? describeLiveVtoNativeCapability;
  const value = describe();
  entry = { value, expiresAt: now + ttlFor(value) };
  return value;
}
