import type { AppleCredentialLinkOutcome } from './appleCredentialLink';

type AuthLifecycleDetails = {
  /**
   * Outcome of handing the Apple authorization grant to the backend. A closed
   * set of status words — deliberately typed as the union rather than `string`
   * so the authorization code itself can never be passed here. Type-only
   * import, so this adds no runtime dependency to the trace module.
   */
  appleCredentialLink?: AppleCredentialLinkOutcome;
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
