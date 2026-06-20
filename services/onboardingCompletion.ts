import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_COMPLETE_KEY = '@kscan_onboarding_complete';

// Historical builds wrote completion under a fallback key when the user id was
// unavailable during hydration. This shared key leaked onboarding state across
// users and caused false skips, so it must never be read, written, or trusted.
const LEGACY_INVALID_KEY = `${ONBOARDING_COMPLETE_KEY}:unknown`;

function isValidUserId(userId: string | null | undefined): userId is string {
  return (
    typeof userId === 'string' &&
    userId.length > 0 &&
    userId !== 'unknown' &&
    userId !== 'null' &&
    userId !== 'undefined'
  );
}

function getKey(userId: string): string {
  return `${ONBOARDING_COMPLETE_KEY}:${userId}`;
}

export async function isOnboardingComplete(
  userId: string | null | undefined
): Promise<boolean> {
  if (!isValidUserId(userId)) {
    return false;
  }
  try {
    const value = await AsyncStorage.getItem(getKey(userId));
    return value === 'true';
  } catch {
    return false;
  }
}

export async function markOnboardingComplete(
  userId: string | null | undefined
): Promise<void> {
  if (!isValidUserId(userId)) {
    return;
  }
  try {
    await AsyncStorage.setItem(getKey(userId), 'true');
  } catch {
    // Non-fatal
  }
}

export async function clearOnboardingComplete(
  userId: string | null | undefined
): Promise<void> {
  if (!isValidUserId(userId)) {
    return;
  }
  try {
    await AsyncStorage.removeItem(getKey(userId));
  } catch {
    // Non-fatal
  }
}

// Best-effort cleanup of the stale shared "unknown" key left by earlier builds.
// Safe to call on app init; failures are non-fatal.
export async function clearLegacyInvalidOnboardingKey(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LEGACY_INVALID_KEY);
  } catch {
    // Non-fatal
  }
}
