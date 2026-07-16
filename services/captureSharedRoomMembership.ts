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
  previewStatus: SharedRoomPreviewCaptureStatus;
  sessionState: SharedRoomMembershipSessionState;
  platform: string;
  attemptKey?: string | null;
  hasAttempted?: (attemptKey: string) => boolean;
  markAttempted?: (attemptKey: string) => void;
};

const VALID_PREVIEW_STATUSES = new Set<SharedRoomPreviewCaptureStatus>(['available', 'empty']);

export function buildMembershipCaptureAttemptKey(actorId: string, normalizedToken: string): string {
  return `${actorId}:${normalizedToken}`;
}

export function createMembershipCaptureAttemptTracker() {
  const attempted = new Set<string>();
  return {
    hasAttempted(key: string) {
      return attempted.has(key);
    },
    markAttempted(key: string) {
      attempted.add(key);
    },
    reset() {
      attempted.clear();
    },
  };
}

export function isEligibleForSharedRoomMembershipCapture(input: {
  shareToken: string;
  previewStatus: SharedRoomPreviewCaptureStatus;
  sessionState: SharedRoomMembershipSessionState;
  platform: string;
}): boolean {
  const normalizedToken = normalizeRoomShareToken(input.shareToken);
  if (!normalizedToken) return false;
  if (!VALID_PREVIEW_STATUSES.has(input.previewStatus)) return false;
  if (input.sessionState.phase !== 'authenticated') return false;
  if (input.platform === 'web') return false;
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

  const attemptKey =
    input.attemptKey ??
    buildMembershipCaptureAttemptKey(input.sessionState.actorId, normalizedToken);

  if (input.hasAttempted?.(attemptKey)) {
    return null;
  }

  input.markAttempted?.(attemptKey);

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
