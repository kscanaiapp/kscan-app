/**
 * What the Account screen's K+ row says for each entitlement state.
 *
 * Presentation only -- it never grants, checks, or extends access.
 *
 * RESOLVING != FREE (POLISH-002). The row used to show the eligible offer
 * ("Complimentary for 6 months. No payment required.") for every state that
 * was not 'active' or 'expired', so a K+ member saw the signup offer while
 * their status loaded, and again, with no way to re-check, whenever the read
 * failed. 'loading' and 'error' now say exactly that the answer is unknown,
 * and 'error' offers a retry.
 */
import type { KPlusResolvedState } from '../../types/entitlements';

export type KPlusAccountAction = 'activate' | 'retry';

export interface KPlusAccountStatus {
  subtitle: string;
  pillLabel: string | null;
  pillVariant: 'neutral' | 'gold';
  action: KPlusAccountAction | null;
}

export function describeKPlusAccountStatus(
  state: KPlusResolvedState,
  expiryLabel: string | null,
): KPlusAccountStatus {
  switch (state) {
    case 'active':
      return {
        subtitle: expiryLabel ? `Active through ${expiryLabel}.` : 'Your K+ Early Access is active.',
        pillLabel: 'Early Access Active',
        pillVariant: 'gold',
        action: null,
      };
    case 'expired':
      return {
        // POLISH-008: the pill already says the access ended; the subtitle
        // answers the question that raises (is anything owed or renewing?).
        subtitle: 'There is no charge and nothing to cancel.',
        pillLabel: 'Complimentary access ended',
        pillVariant: 'neutral',
        action: null,
      };
    case 'eligible':
      return {
        subtitle: 'Complimentary for 6 months. No payment required.',
        pillLabel: 'Early Access available',
        pillVariant: 'neutral',
        action: 'activate',
      };
    case 'loading':
      return {
        subtitle: 'Checking your K+ access…',
        pillLabel: null,
        pillVariant: 'neutral',
        action: null,
      };
    case 'error':
      return {
        subtitle: 'We could not check your K+ access. Nothing on your account has changed.',
        pillLabel: null,
        pillVariant: 'neutral',
        action: 'retry',
      };
    case 'unavailable':
    default:
      return {
        subtitle: 'K+ status is not available right now.',
        pillLabel: null,
        pillVariant: 'neutral',
        action: null,
      };
  }
}
