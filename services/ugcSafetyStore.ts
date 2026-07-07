import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * No-DB UGC safety local store.
 *
 * Stores only content ids the user has chosen to hide after reporting.
 * Device-local only; no backend sync, no schema, no migrations.
 */
const HIDDEN_CONTENT_IDS_KEY = 'kscan.hidden_content_ids.v1';

export async function readHiddenContentIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(HIDDEN_CONTENT_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      await AsyncStorage.removeItem(HIDDEN_CONTENT_IDS_KEY).catch(() => undefined);
      return [];
    }
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export async function addHiddenContentId(id: string): Promise<boolean> {
  try {
    const current = await readHiddenContentIds();
    if (current.includes(id)) return true;
    await AsyncStorage.setItem(
      HIDDEN_CONTENT_IDS_KEY,
      JSON.stringify([...current, id])
    );
    return true;
  } catch {
    return false;
  }
}
