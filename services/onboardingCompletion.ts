import AsyncStorage from '@react-native-async-storage/async-storage';
import { hasCurrentLegalAcceptances } from './legalAcceptance';
import {
  AGE_VERSION,
  AI_PROCESSING_VERSION,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from '../constants/legal';

const STORAGE_KEY_PREFIX = 'onboardingComplete';
export const CURRENT_ONBOARDING_COMPLETION_MARKER = [
  `terms:${TERMS_VERSION}`,
  `privacy:${PRIVACY_VERSION}`,
  `minimum_age:${AGE_VERSION}`,
  `ai_processing:${AI_PROCESSING_VERSION}`,
].join('|');
type CompletionListener = (userId: string) => void;

const completionListeners = new Set<CompletionListener>();

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
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[onboardingCompletion] markOnboardingComplete called with empty userId');
    }
    return;
  }
  await AsyncStorage.setItem(getKey(userId), CURRENT_ONBOARDING_COMPLETION_MARKER);
  completionListeners.forEach((listener) => listener(userId));
}

export function subscribeOnboardingCompletion(listener: CompletionListener): () => void {
  completionListeners.add(listener);
  return () => {
    completionListeners.delete(listener);
  };
}

/**
 * Check whether onboarding is complete for a specific user.
 *
 * Returns false if userId is empty or the key is not found.
 */
export async function isOnboardingComplete(userId: string): Promise<boolean> {
  if (!userId) return false;
  const value = await AsyncStorage.getItem(getKey(userId));
  return value === CURRENT_ONBOARDING_COMPLETION_MARKER;
}

/**
 * Uses a version-bound local fast path, then restores it from the owner-scoped
 * immutable legal ledger after a reinstall/app-data clear or when a legacy
 * boolean marker is found. This does not infer completion for a brand-new OAuth
 * identity and cannot let a prior policy version bypass a newer acknowledgment.
 */
export async function resolveOnboardingCompletion(userId: string): Promise<boolean> {
  if (!userId) return false;
  if (await isOnboardingComplete(userId)) return true;

  const remotelyComplete = await hasCurrentLegalAcceptances(userId);
  if (remotelyComplete) {
    await markOnboardingComplete(userId);
  }
  return remotelyComplete;
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
