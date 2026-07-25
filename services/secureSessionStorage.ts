import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Session storage seam for the Supabase auth adapter.
 *
 * A native Supabase session carries a refresh token, which is the durable
 * credential for the account. The accepted iOS implementation
 * (integration/ios-v17-prelaunch-complete, services/secureSessionStorage.ts)
 * backs this seam with the platform keychain via expo-secure-store, migrating
 * any legacy AsyncStorage copy on first read.
 *
 * This Android build cannot yet do the same: expo-secure-store is a native
 * module, it is absent from both package.json and the linked Android project,
 * and adding it requires a native rebuild that is not authorized in this batch.
 * Calling into it from the already-installed runtime would throw and break
 * authentication outright, which is strictly worse than the current posture.
 *
 * So the backend stays AsyncStorage and the gap is declared rather than
 * assumed away — see SESSION_STORAGE_POSTURE. Once a development client that
 * includes expo-secure-store is authorized and installed, this module is the
 * single place that changes, and the iOS donor drops in unmodified.
 */
export type SessionStoragePosture = {
  backend: 'async-storage' | 'platform-keystore';
  /** True only when values are encrypted at rest by the platform keystore. */
  encryptedAtRest: boolean;
  /** Set when the platform-keystore backend is unavailable in this build. */
  degradedReason: string | null;
};

export const SESSION_STORAGE_POSTURE: SessionStoragePosture = {
  backend: 'async-storage',
  encryptedAtRest: false,
  degradedReason:
    'expo-secure-store is not installed or natively linked in this Android build; '
    + 'keystore-backed session storage requires an owner-authorized development client.',
};

export function getSessionStoragePosture(): SessionStoragePosture {
  return SESSION_STORAGE_POSTURE;
}

export const secureSessionStorage = {
  getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  },
  setItem(key: string, value: string): Promise<void> {
    return AsyncStorage.setItem(key, value);
  },
  removeItem(key: string): Promise<void> {
    return AsyncStorage.removeItem(key);
  },
};
