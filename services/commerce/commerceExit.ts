/**
 * Commerce V2 commerce-exit contract (Build 35 §28-31).
 *
 * The one governed path a Shop tap routes through, instead of every card
 * hand-rolling `Linking.openURL`/`openExternalUrl`/`openPersistedCommerceUrl`
 * itself. Responsibilities, per §28:
 *   1. validate the destination is safe to open (reuses `isSafeCommerceUrl`
 *      -- no new safety logic);
 *   2. preserve any legitimate attribution already on the URL -- there is
 *      none to preserve today (Build 35 Decision Memo 2:
 *      docs/audits/commerce-v2-decision-memos.md), so this step is a no-op
 *      by construction: the URL is opened byte-identical, nothing stripped,
 *      nothing added;
 *   3. record an allowed commerce-exit event -- deferred pending an owner
 *      decision on sink/schema (Decision Memo 1); `recordCommerceExitEvent`
 *      below is the seam that decision fills in, not a fabricated call to
 *      an unproven analytics pipeline;
 *   4. open the exact offer URL.
 */

import { isSafeCommerceUrl } from '../commerceDestination.ts';
import { resolveRetailerIdentity, type RetailerIdentityInput } from './retailerIdentity.ts';

export type CommerceExitAction = 'shop' | 'watch_created';

export interface CommerceExitEvent {
  action: CommerceExitAction;
  retailerKey: string | null;
  commerceType: 'retail' | 'resale' | null;
  sourceAuthority: 'declared' | 'domain' | 'unknown';
  surface: string;
}

/**
 * Decision Memo 1 (docs/audits/commerce-v2-decision-memos.md): no sink is
 * wired yet -- the consent-authority question PostHog's own client already
 * flags is unresolved, and the one existing commerce table
 * (`scan_commerce_events`) is structurally request-level, not per-tap, and
 * is forbidden from carrying a purchase URL. This stays a documented no-op
 * until that's decided; it exists so the decision doesn't require touching
 * every call site again.
 */
export function recordCommerceExitEvent(_event: CommerceExitEvent): void {
  // Intentionally inert. See Decision Memo 1.
}

export interface OpenCommerceOfferInput extends RetailerIdentityInput {
  productUrl?: unknown;
}

export interface OpenCommerceOfferOptions {
  /** Which action this exit represents, for the (currently inert) event. */
  action?: CommerceExitAction;
  /**
   * The destination-safety gate to apply. Defaults to `isSafeCommerceUrl`
   * (commerceDestination.ts) for a live/just-fetched URL. A surface opening
   * a URL that was PERSISTED (Dressing Room snapshot, Watch canonicalUrl)
   * must pass `normalizePersistedCommerceUrl`
   * (services/dressingRoomCommerce.ts) instead -- it additionally rejects
   * signed-storage paths and credential-shaped query params that could have
   * been written to storage before this gate existed. This is a real
   * difference in what each data source can contain, not something to
   * flatten into one check (§28: one PATH, not one CHECK).
   */
  validate?: (value: unknown) => string | null;
}

/**
 * Validates, records, and opens one commerce offer's destination.
 *
 * Returns false -- without touching `openUrl` -- for an offer with no safe
 * destination, so the caller can show its own "link unavailable" state
 * rather than silently doing nothing (matches the existing
 * `openExternalUrl`/`openPersistedCommerceUrl` contract).
 */
export async function openCommerceOffer(
  offer: OpenCommerceOfferInput,
  surface: string,
  openUrl: (url: string) => Promise<unknown>,
  options: OpenCommerceOfferOptions = {},
): Promise<boolean> {
  const { action = 'shop', validate = isSafeCommerceUrl } = options;
  const safeUrl = validate(offer?.productUrl);
  if (!safeUrl || typeof openUrl !== 'function') return false;

  const identity = resolveRetailerIdentity(offer);
  recordCommerceExitEvent({
    action,
    retailerKey: identity.retailerKey,
    commerceType: identity.commerceType,
    sourceAuthority: identity.sourceAuthority,
    surface,
  });

  try {
    await openUrl(safeUrl);
    return true;
  } catch {
    return false;
  }
}
