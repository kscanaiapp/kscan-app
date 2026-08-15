import type { AppleCredentialLinkOutcome } from './appleCredentialLink';
import type { AppleDisplayNameOutcome } from './appleDisplayName';

type AuthLifecycleDetails = {
  /** Status only; the Apple authorization code must never enter tracing. */
  appleCredentialLink?: AppleCredentialLinkOutcome;
  /** Status only; the Apple-provided name must never enter tracing. */
  appleDisplayName?: AppleDisplayNameOutcome;
  authEvent?: string;
  callbackKind?: 'code' | 'tokens' | 'otp' | 'missing';
  guardAction?: string;
  ignoredAsStale?: boolean;
  loading?: boolean;
  onboardingState?: 'complete' | 'incomplete' | 'pending';
  outcome?: string;
  redirectTo?: string | null;
  route?: string;
  sessionPresent?: boolean;
  sessionUsable?: boolean;
};

/**
 * Development-only auth trace. The shape intentionally has no fields for
 * tokens, authorization codes, email addresses, URLs, or private identifiers.
 */
export function traceAuthLifecycle(event: string, details: AuthLifecycleDetails = {}): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;

  console.info('[K-SCAN AuthLifecycle]', {
    timestamp: new Date().toISOString(),
    event,
    ...details,
  });
}
