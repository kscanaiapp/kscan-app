/**
 * Free Tier Utility Expansion — local-first storage helper.
 *
 * Wraps AsyncStorage with a versioned envelope. Defensive by design:
 * - never throws (all failures resolve to fallbacks / false)
 * - corrupt or wrong-version payloads are cleared and reset safely
 * - no raw images, auth tokens, precise location, or sensitive data
 * - no backend sync; device-local only
 *
 * If a user id is available at the call site it is stored on the envelope
 * for future per-user isolation. If not, data is device-scoped (documented
 * limitation in docs/FREE_TIER_UTILITY_EXPANSION_MAP.md).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  FREE_TIER_STORAGE_KEYS,
  type FreeTierStorageKey,
} from './wardrobeUtilityTypes';

const ENVELOPE_VERSION = 1;

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
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!isEnvelope(parsed) || parsed.version !== ENVELOPE_VERSION) {
      // Corrupt or future/older schema — reset safely rather than crash.
      await AsyncStorage.removeItem(key).catch(() => undefined);
      return fallback;
    }
    return (parsed.data as T) ?? fallback;
  } catch {
    // JSON.parse failure or storage error — clear the bad key, fail silently.
    await AsyncStorage.removeItem(key).catch(() => undefined);
    return fallback;
  }
}

/** Write a store. Returns true on success; never throws. */
export async function writeStore<T>(
  key: FreeTierStorageKey,
  data: T,
  userId?: string
): Promise<boolean> {
  try {
    const envelope: Envelope<T> = {
      version: ENVELOPE_VERSION,
      userId: userId || undefined,
      updatedAt: new Date().toISOString(),
      data,
    };
    await AsyncStorage.setItem(key, JSON.stringify(envelope));
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

/** Remove every free-tier utility store (safe to call on sign-out if wired later). */
export async function clearAllFreeTierStores(): Promise<void> {
  try {
    await AsyncStorage.multiRemove(Object.values(FREE_TIER_STORAGE_KEYS));
  } catch {
    // best-effort
  }
}
