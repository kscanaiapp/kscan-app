/**
 * K+ product-tier / entitlement contract (client-side types only).
 *
 * The client never decides tier or capability access -- it only renders
 * whatever the server (user_entitlements, via kplus-activate / a direct
 * RLS-scoped select) already decided. See docs/kplus-foundation.md.
 */

export type ProductTier = 'free' | 'k_plus';

/** Capability keys future K+ features gate on. Only 'k_plus' is meaningful
 *  in this build -- the rest are reserved names, not yet enabled anywhere. */
export type KPlusCapability =
  | 'voice_scan'
  | 'style_dna'
  | 'premium_rooms'
  | 'advanced_wardrobe'
  | 'higher_elise_limits';

export type KPlusGrantReason =
  | 'complimentary_early_access'
  | 'staff'
  | 'admin'
  | 'promo'
  | 'trial'
  | 'paid_ios'
  | 'paid_android';

export type KPlusExternalSyncStatus =
  | 'not_required'
  | 'pending'
  | 'synced'
  | 'failed_retryable'
  | 'failed_terminal';

/** Raw shape of a row the client can read from public.user_entitlements
 *  (RLS restricts this to the caller's own row). */
export interface KPlusEntitlementRow {
  entitlementKey: string;
  status: 'active' | 'expired' | 'revoked';
  grantReason: KPlusGrantReason;
  campaignKey: string | null;
  grantedAt: string;
  expiresAt: string | null;
  /** Set when the grant was revoked. Part of the canonical K+ predicate:
   *  a non-null value means NOT active, whatever `status` still says. */
  revokedAt: string | null;
  externalSyncStatus: KPlusExternalSyncStatus;
}

/**
 * Resolved, UI-facing K+ state. 'active' requires both status === 'active'
 * AND expiresAt in the future -- the client re-derives this locally so a
 * stale cached row past its expiry never renders as active, but it never
 * invents an active state the server didn't grant.
 */
export type KPlusResolvedState =
  | 'loading'
  | 'eligible' // authenticated, no grant yet -- can activate
  | 'active'
  | 'expired' // campaign consumed, not active
  | 'unavailable' // not authenticated, or KPLUS_EARLY_ACCESS_ENABLED is off
  | 'error'; // transient read failure -- fails closed to "no premium access"

export interface KPlusEntitlementSnapshot {
  state: KPlusResolvedState;
  expiresAt: string | null;
  campaignKey: string | null;
  externalSyncStatus: KPlusExternalSyncStatus | null;
}

export const KPLUS_ENTITLEMENT_KEY = 'k_plus' as const;
export const KPLUS_CAMPAIGN_KEY = 'kplus_early_access_2026' as const;
export const KPLUS_TERMS_VERSION = 'kplus_early_access_v1' as const;
