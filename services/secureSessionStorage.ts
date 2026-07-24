import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Native Supabase sessions contain a refresh token, so they belong in the
 * platform keystore/keychain rather than in AsyncStorage. Existing installs
 * are migrated on their first read without discarding a recoverable session.
 * Web retains AsyncStorage because Expo SecureStore is not a browser keystore.
 */
export const secureSessionStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return AsyncStorage.getItem(key);

    const secureValue = await SecureStore.getItemAsync(key);
    if (secureValue !== null) return secureValue;

    const legacyValue = await AsyncStorage.getItem(key);
    if (legacyValue === null) return null;

    // Write before removing the legacy copy: a storage failure must not cause
    // an otherwise valid user to be signed out during the upgrade.
    await SecureStore.setItemAsync(key, legacyValue);
    await AsyncStorage.removeItem(key);
    return legacyValue;
  },

  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      await AsyncStorage.setItem(key, value);
      return;
    }

    await SecureStore.setItemAsync(key, value);
    // Clear only after the secure write succeeds, so a failed write preserves
    // the migration source instead of silently losing the session.
    await AsyncStorage.removeItem(key);
  },

  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      await AsyncStorage.removeItem(key);
      return;
    }

    await SecureStore.deleteItemAsync(key);
    // Removes the legacy location too, including after a user explicitly signs
    // out before their first post-upgrade session restore.
    await AsyncStorage.removeItem(key);
  },
};
