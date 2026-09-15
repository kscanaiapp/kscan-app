/**
 * K Scan AI -- K+ entitlement read contract, client side (K+ Paywall Program,
 * Phase 1).
 *
 * Types and pure policy only. Nothing imports this yet: the Build 34 client
 * still reads its own user_entitlements row through services/kplus. A later
 * phase moves every K+ surface (Voice Scan, still-image Virtual Try-On,
 * Wardrobe Concierge, Packing Intelligence, onboarding, Account -> K+) onto
 * get_my_kplus_entitlement_summary() and this module.
 *
 * The server is the authority. This module only decides what the client may
 * PRESENT while it cannot reach the server:
 *   - resolving is not locked: only a positively resolved 'free' shows a paywall
 *   - an unreachable server is 'unavailable', never 'free'
 *   - a cached snapshot is presentation only; it never grants a server-side
 *     operation, never outlives the entitlement it describes, and can never
 *     turn a free user into K+
 *
 * The literal sets below mirror supabase/functions/_shared/kplus/
 * kplusEntitlementContract.ts and the migration's CHECK constraints;
 * __tests__/kplusEntitlementAuthority.test.js keeps all three identical.
 */

export const KPLUS_SUMMARY_CONTRACT_VERSION = 1 as const;
export const KPLUS_CLIENT_SUMMARY_RPC = 'get_my_kplus_entitlement_summary' as const;

export const KPLUS_DISPLAY_SOURCES = ['subscription', 'trial', 'complimentary', 'unknown'] as const;
export type KPlusDisplaySource = (typeof KPLUS_DISPLAY_SOURCES)[number];

export const KPLUS_STORES = ['apple', 'google'] as const;
export type KPlusStore = (typeof KPLUS_STORES)[number];

export const KPLUS_BILLING_STATES = [
  'normal',
  'grace_period',
  'billing_retry',
  'account_hold',
  'paused',
] as const;
export type KPlusBillingState = (typeof KPLUS_BILLING_STATES)[number];

export interface KPlusAccountManagement {
  storeManagementRelevant: boolean;
  managementStore: KPlusStore | null;
}

export interface KPlusEntitlementSummary {
  contractVersion: typeof KPLUS_SUMMARY_CONTRACT_VERSION;
  entitlementKey: 'k_plus';
  access: 'free' | 'k_plus';
  displaySource: KPlusDisplaySource | null;
  effectiveExpiresAt: string | null;
  isOpenEnded: boolean;
  trialEndsAt: string | null;
  willRenew: boolean | null;
  store: KPlusStore | null;
  billingState: KPlusBillingState | null;
  accountManagement: KPlusAccountManagement;
  snapshotIssuedAt: string;
}

/** The four states a K+ surface may be in. There is no fifth "assume free". */
export type KPlusEntitlementClientState =
  | { status: 'resolved'; summary: KPlusEntitlementSummary; origin: 'server' | 'presentation_snapshot' }
  | { status: 'resolving' }
  | {
    status: 'unavailable';
    reason: 'network' | 'server_error' | 'malformed_response' | 'snapshot_expired' | 'clock_untrusted';
  }
  | { status: 'signed_out' };

/**
 * Client presentation policy -- configurable in the mobile phase, never
 * database authority.
 */
export const KPLUS_PRESENTATION_SNAPSHOT_POLICY = Object.freeze({
  /** A snapshot may be presented for at most this long after snapshotIssuedAt. */
  maxAgeMs: 15 * 60 * 1000,
  /** A device clock this far BEHIND snapshotIssuedAt is not trusted to age it. */
  clockSkewAllowanceMs: 5 * 60 * 1000,
});

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function isIsoUtc(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function isOneOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value);
}

/**
 * Strict parse of the RPC response. Anything malformed, from another contract
 * version, or internally inconsistent returns null -- which the caller must
 * treat as 'unavailable', never as 'free'. The result is rebuilt from known
 * keys only, so an unexpected server field is never carried forward.
 */
export function parseKPlusEntitlementSummary(value: unknown): KPlusEntitlementSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const management = raw.accountManagement as Record<string, unknown> | null | undefined;

  if (raw.contractVersion !== KPLUS_SUMMARY_CONTRACT_VERSION) return null;
  if (raw.entitlementKey !== 'k_plus') return null;
  if (raw.access !== 'free' && raw.access !== 'k_plus') return null;
  if (raw.displaySource !== null && !isOneOf(KPLUS_DISPLAY_SOURCES, raw.displaySource)) return null;
  if (raw.effectiveExpiresAt !== null && !isIsoUtc(raw.effectiveExpiresAt)) return null;
  if (typeof raw.isOpenEnded !== 'boolean') return null;
  if (raw.trialEndsAt !== null && !isIsoUtc(raw.trialEndsAt)) return null;
  if (raw.willRenew !== null && typeof raw.willRenew !== 'boolean') return null;
  if (raw.store !== null && !isOneOf(KPLUS_STORES, raw.store)) return null;
  if (raw.billingState !== null && !isOneOf(KPLUS_BILLING_STATES, raw.billingState)) return null;
  if (!management || typeof management !== 'object') return null;
  if (typeof management.storeManagementRelevant !== 'boolean') return null;
  if (management.managementStore !== null && !isOneOf(KPLUS_STORES, management.managementStore)) return null;
  if (!isIsoUtc(raw.snapshotIssuedAt)) return null;

  // Internal consistency: a K+ answer names its source and either an expiry
  // or open-endedness; a free answer claims neither.
  if (raw.access === 'k_plus') {
    if (raw.displaySource === null) return null;
    if (raw.isOpenEnded === (raw.effectiveExpiresAt !== null)) return null;
  } else if (raw.displaySource !== null || raw.effectiveExpiresAt !== null || raw.isOpenEnded) {
    return null;
  }

  return {
    contractVersion: KPLUS_SUMMARY_CONTRACT_VERSION,
    entitlementKey: 'k_plus',
    access: raw.access,
    displaySource: raw.displaySource as KPlusDisplaySource | null,
    effectiveExpiresAt: raw.effectiveExpiresAt as string | null,
    isOpenEnded: raw.isOpenEnded,
    trialEndsAt: raw.trialEndsAt as string | null,
    willRenew: raw.willRenew as boolean | null,
    store: raw.store as KPlusStore | null,
    billingState: raw.billingState as KPlusBillingState | null,
    accountManagement: {
      storeManagementRelevant: management.storeManagementRelevant,
      managementStore: management.managementStore as KPlusStore | null,
    },
    snapshotIssuedAt: raw.snapshotIssuedAt,
  };
}

/**
 * The last instant a cached snapshot may still be presented: snapshotIssuedAt
 * plus maxAgeMs, and never past the entitlement's own effectiveExpiresAt.
 */
export function kplusPresentationSnapshotValidUntilMs(
  summary: KPlusEntitlementSummary,
  policy = KPLUS_PRESENTATION_SNAPSHOT_POLICY,
): number {
  const issuedMs = Date.parse(summary.snapshotIssuedAt);
  let validUntil = issuedMs + policy.maxAgeMs;
  if (summary.access === 'k_plus' && !summary.isOpenEnded && summary.effectiveExpiresAt) {
    validUntil = Math.min(validUntil, Date.parse(summary.effectiveExpiresAt));
  }
  return validUntil;
}

/**
 * What a surface may present from a cached snapshot while the server is
 * unreachable. Past its validity the answer is 'unavailable' -- unverified,
 * not free. A device clock set back beyond the skew allowance cannot keep a
 * snapshot alive.
 */
export function evaluateKPlusPresentationSnapshot(
  summary: KPlusEntitlementSummary,
  nowMs: number,
  policy = KPLUS_PRESENTATION_SNAPSHOT_POLICY,
): KPlusEntitlementClientState {
  const issuedMs = Date.parse(summary.snapshotIssuedAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(nowMs)) {
    return { status: 'unavailable', reason: 'malformed_response' };
  }
  if (nowMs < issuedMs - policy.clockSkewAllowanceMs) {
    return { status: 'unavailable', reason: 'clock_untrusted' };
  }
  if (nowMs >= kplusPresentationSnapshotValidUntilMs(summary, policy)) {
    return { status: 'unavailable', reason: 'snapshot_expired' };
  }
  return { status: 'resolved', summary, origin: 'presentation_snapshot' };
}

/** A paywall is shown only for a positively resolved free answer. */
export function shouldPresentKPlusPaywall(state: KPlusEntitlementClientState): boolean {
  return state.status === 'resolved' && state.summary.access === 'free';
}

/** K+ is presented only for a resolved K+ answer (server or valid snapshot). */
export function presentsKPlusAccess(state: KPlusEntitlementClientState): boolean {
  return state.status === 'resolved' && state.summary.access === 'k_plus';
}
