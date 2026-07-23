import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const DEVICE_KEY_STORAGE_KEY = 'kscan.device.installKey.v1';

function randomDeviceKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // RN/Hermes fallback: no crypto.randomUUID available on older runtimes.
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/**
 * Stable per-install identifier used as register_user_device_session's
 * p_device_key. Not a hardware ID -- generated once and persisted, so a
 * fresh app install (or cleared storage) is correctly treated as a new
 * device slot rather than colliding with a prior install.
 */
export async function getOrCreateDeviceKey(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_KEY_STORAGE_KEY);
  if (existing && existing.length >= 4) return existing;
  const key = randomDeviceKey();
  await AsyncStorage.setItem(DEVICE_KEY_STORAGE_KEY, key);
  return key;
}

/** Maps to the platform check constraint on public.user_device_sessions. */
export function currentDevicePlatform(): 'phone' | 'desktop' | 'other' {
  if (Platform.OS === 'ios' || Platform.OS === 'android') return 'phone';
  if (Platform.OS === 'web') return 'desktop';
  return 'other';
}
