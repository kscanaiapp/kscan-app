// Deep-link membership capture for authenticated native viewers of public rooms.
//
// The public route owns preview fetching; this helper only decides eligibility
// and invokes the account-anchored save RPC as a non-blocking side effect.

import {
  saveSharedRoomForCurrentUser,
  type SaveSharedRoomResult,
  type SaveSharedRoomStatus,
} from './sharedRoomMemberships';
import { normalizeRoomShareToken } from './roomDeepLinks';

export type SharedRoomPreviewCaptureStatus =
  | 'loading'
  | 'available'
  | 'empty'
  | 'unavailable'
  | 'malformed'
  | 'rate_limited'
  | 'network_error'
  | 'timeout';

export type SharedRoomMembershipSessionState =
  | { phase: 'loading' }
  | { phase: 'authenticated'; actorId: string }
  | { phase: 'unauthenticated' };

export type CaptureSharedRoomMembershipInput = {
  shareToken: string;
  previewShareToken: string;
  previewStatus: SharedRoomPreviewCaptureStatus;
  sessionState: SharedRoomMembershipSessionState;
  platform: string;
  hasAttempted: (attemptKey: string) => boolean;
  markAttempted: (attemptKey: string) => void;
};

const VALID_PREVIEW_STATUSES = new Set<SharedRoomPreviewCaptureStatus>(['available', 'empty']);
const NATIVE_PLATFORMS = new Set(['android', 'ios']);

export function buildMembershipCaptureAttemptKey(actorId: string, normalizedToken: string): string {
  return `${actorId}:${normalizedToken}`;
}

export function createMembershipCaptureAttemptTracker() {
  // One route-open lifecycle can have only one current actor/token attempt.
  // Replacing the key keeps this tracker bounded even if a caller misses a
  // reset during an auth or token transition.
  let attemptedKey: string | null = null;
  return {
    hasAttempted(key: string) {
      return attemptedKey === key;
    },
    markAttempted(key: string) {
      attemptedKey = key;
    },
    reset() {
      attemptedKey = null;
    },
  };
}

export function isEligibleForSharedRoomMembershipCapture(input: {
  shareToken: string;
  previewShareToken: string;
  previewStatus: SharedRoomPreviewCaptureStatus;
  sessionState: SharedRoomMembershipSessionState;
  platform: string;
}): boolean {
  const normalizedToken = normalizeRoomShareToken(input.shareToken);
  if (!normalizedToken) return false;
  const normalizedPreviewToken = normalizeRoomShareToken(input.previewShareToken);
  if (!normalizedPreviewToken || normalizedPreviewToken !== normalizedToken) return false;
  if (!VALID_PREVIEW_STATUSES.has(input.previewStatus)) return false;
  if (input.sessionState.phase !== 'authenticated') return false;
  if (!input.sessionState.actorId.trim()) return false;
  if (!NATIVE_PLATFORMS.has(input.platform)) return false;
  return true;
}

function devLogMembershipCapture(event: string, status?: SaveSharedRoomStatus) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.info('[sharedRoomMembershipCapture]', event, status ? { status } : undefined);
  }
}

export async function captureSharedRoomMembershipAfterPreview(
  input: CaptureSharedRoomMembershipInput,
): Promise<SaveSharedRoomResult | null> {
  if (!isEligibleForSharedRoomMembershipCapture(input)) {
    return null;
  }

  const normalizedToken = normalizeRoomShareToken(input.shareToken);
  if (!normalizedToken || input.sessionState.phase !== 'authenticated') {
    return null;
  }

  const attemptKey = buildMembershipCaptureAttemptKey(
    input.sessionState.actorId,
    normalizedToken,
  );

  if (input.hasAttempted(attemptKey)) {
    return null;
  }

  // One non-blocking attempt per actor/token/open cycle, including temporary
  // failures. A route remount or actor/token change resets the bounded tracker
  // and may retry the backend's idempotent save operation.
  input.markAttempted(attemptKey);

  const result = await saveSharedRoomForCurrentUser(normalizedToken);

  if (result.status === 'temporary_failure') {
    devLogMembershipCapture('save-temporary-failure', result.status);
  } else if (
    result.status === 'saved' ||
    result.status === 'restored' ||
    result.status === 'already_saved' ||
    result.status === 'owner'
  ) {
    devLogMembershipCapture('save-success', result.status);
  }

  return result;
}
