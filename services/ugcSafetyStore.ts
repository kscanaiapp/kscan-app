import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * No-DB UGC safety local store.
 *
 * Stores content ids and user ids the user has chosen to hide after reporting.
 * Device-local only; no backend sync, no block enforcement, no cross-device filtering.
 */
const HIDDEN_CONTENT_IDS_KEY = 'kscan.hidden_content_ids.v1';
const HIDDEN_USER_IDS_KEY = 'kscan.hidden_user_ids.v1';

async function readStringArray(key: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      await AsyncStorage.removeItem(key).catch(() => undefined);
      return [];
    }
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

async function addToStringArray(key: string, id: string): Promise<boolean> {
  try {
    const current = await readStringArray(key);
    if (current.includes(id)) return true;
    await AsyncStorage.setItem(key, JSON.stringify([...current, id]));
    return true;
  } catch {
    return false;
  }
}

export async function readHiddenContentIds(): Promise<string[]> {
  return readStringArray(HIDDEN_CONTENT_IDS_KEY);
}

export async function addHiddenContentId(id: string): Promise<boolean> {
  return addToStringArray(HIDDEN_CONTENT_IDS_KEY, id);
}

/**
 * Read the device-local list of hidden/reported user ids.
 * These ids are added when a user reports content and the sender/author id is known.
 */
export async function readHiddenUserIds(): Promise<string[]> {
  return readStringArray(HIDDEN_USER_IDS_KEY);
}

/**
 * Persist a user id to the device-local hidden-user list.
 * Returns true if the id is already present or was successfully persisted.
 */
export async function addHiddenUserId(id: string): Promise<boolean> {
  return addToStringArray(HIDDEN_USER_IDS_KEY, id);
}

/**
 * Validate that a value is a non-empty string that looks like a UUID.
 * Used for app-level validation of optional room_id references before submitting reports.
 */
export function isValidUuid(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}
