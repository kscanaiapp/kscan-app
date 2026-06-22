import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY_PREFIX = 'onboardingComplete';

function getKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}:${userId}`;
}

/**
 * Mark onboarding as complete for a specific user.
 *
 * Guard: silently no-ops if userId is empty to prevent writing
 * onboardingComplete:undefined keys.
 */
export async function markOnboardingComplete(userId: string): Promise<void> {
  if (!userId) {
    console.warn('[onboardingCompletion] markOnboardingComplete called with empty userId');
    return;
  }
  await AsyncStorage.setItem(getKey(userId), 'true');
}

/**
 * Check whether onboarding is complete for a specific user.
 *
 * Returns false if userId is empty or the key is not found.
 */
export async function isOnboardingComplete(userId: string): Promise<boolean> {
  if (!userId) return false;
  const value = await AsyncStorage.getItem(getKey(userId));
  return value === 'true';
}

/**
 * Clear the onboarding completion flag for a specific user.
 *
 * Guard: silently no-ops if userId is empty.
 */
export async function clearOnboardingComplete(userId: string): Promise<void> {
  if (!userId) return;
  await AsyncStorage.removeItem(getKey(userId));
}
