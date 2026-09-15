/**
 * K Scan AI -- K+ entitlement authority contract (K+ Paywall Program, Phase 1).
 *
 * The typed server-side contract every later K+ phase implements against:
 * store purchase, restore, access codes, reconciliation, Welcome to K+
 * delivery and Account -> K+. The authority itself is SQL, in migration
 * `*_kplus_entitlement_authority.sql`:
 *
 *   read        get_my_kplus_entitlement_summary()   (authenticated, auth.uid())
 *               kplus_entitlement_summary(uuid,text)  (service_role)
 *   transition  apply_kplus_provider_transition(...)  (service_role)
 *   grant       grant_kplus_complimentary(...)        (service_role)
 *   revoke      revoke_kplus_grant(uuid, uuid)        (service_role)
 *
 * Invariants this file encodes and __tests__/kplusEntitlementAuthority.test.js
 * pins against the SQL:
 *   - K Scan AI / Supabase is the K+ authority. RevenueCat is a store signal,
 *     a reconciliation source and a mirror -- never authority on its own.
 *   - The RevenueCat App User ID is the Supabase auth user UUID. Nothing here
 *     accepts an email, an alias or an anonymous RevenueCat id as identity.
 *   - A client never supplies entitlement state. It may only ask the server to
 *     read, or (later) to reconcile.
 *   - No price, currency, receipt, purchase token, provider payload or email
 *     address crosses this contract. Current Build 34 K+ is complimentary.
 *
 * Nothing in this module performs I/O.
 */

export const KPLUS_ENTITLEMENT_KEY = 'k_plus' as const;
export const KPLUS_SUMMARY_CONTRACT_VERSION = 1 as const;

// ── Closed vocabularies (each mirrors a CHECK constraint in the migration) ────

export const KPLUS_GRANT_SOURCES = [
  'store_subscription',
  'complimentary',
  'complimentary_code',
  'employee',
  'friends_family',
  'manual_support',
  'promotional',
] as const;
export type KPlusGrantSource = (typeof KPLUS_GRANT_SOURCES)[number];

/** Sources grant_kplus_complimentary accepts. A store trial is NOT one of
 *  them: a trial is a store subscription lifecycle state. */
export const KPLUS_COMPLIMENTARY_SOURCES = [
  'complimentary',
  'complimentary_code',
  'employee',
  'friends_family',
  'manual_support',
  'promotional',
] as const;
export type KPlusComplimentarySource = (typeof KPLUS_COMPLIMENTARY_SOURCES)[number];

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

/** Provider lifecycle states a transition may carry. Cancellation is not a
 *  state: it is `willRenew: false` on an active or trial state. */
export const KPLUS_LIFECYCLE_STATES = [
  'trial',
  'active',
  'grace_period',
  'billing_retry',
  'account_hold',
  'paused',
  'expired',
  'refunded',
  'revoked',
] as const;
export type KPlusLifecycleState = (typeof KPLUS_LIFECYCLE_STATES)[number];

export const KPLUS_PERIOD_TYPES = ['trial', 'paid'] as const;
export type KPlusPeriodType = (typeof KPLUS_PERIOD_TYPES)[number];

export const KPLUS_PROVIDERS = ['revenuecat'] as const;
export type KPlusProvider = (typeof KPLUS_PROVIDERS)[number];

export const KPLUS_PROVIDER_ENVIRONMENTS = ['production', 'sandbox'] as const;
export type KPlusProviderEnvironment = (typeof KPLUS_PROVIDER_ENVIRONMENTS)[number];

export const KPLUS_PROVIDER_TRANSITION_CAUSES = ['provider_event', 'provider_reconciliation'] as const;
export type KPlusProviderTransitionCause = (typeof KPLUS_PROVIDER_TRANSITION_CAUSES)[number];

export const KPLUS_PROVIDER_EVENT_TYPES = [
  'initial_purchase',
  'renewal',
  'product_change',
  'cancellation',
  'uncancellation',
  'billing_issue',
  'subscription_paused',
  'subscription_extended',
  'expiration',
  'refund',
  'refund_reversed',
  'transfer',
  'reconciliation_snapshot',
] as const;
export type KPlusProviderEventType = (typeof KPLUS_PROVIDER_EVENT_TYPES)[number];

export const KPLUS_ACTIVATION_CLASSES = ['subscription_or_trial', 'complimentary'] as const;
export type KPlusActivationClass = (typeof KPLUS_ACTIVATION_CLASSES)[number];

export const KPLUS_PROVIDER_REJECTION_REASONS = [
  'unknown_user',
  'anonymous_identity',
  'subscription_owned_by_other_user',
  'environment_mismatch',
  'provider_time_in_future',
  'event_identity_conflict',
] as const;
export type KPlusProviderRejectionReason = (typeof KPLUS_PROVIDER_REJECTION_REASONS)[number];

// ── A. Entitlement read ────────────────────────────────────────────────────────

/** RPC names. The client only ever calls the first; identity is auth.uid(). */
export const KPLUS_CLIENT_SUMMARY_RPC = 'get_my_kplus_entitlement_summary' as const;
export const KPLUS_SERVICE_SUMMARY_RPC = 'kplus_entitlement_summary' as const;

/**
 * G. Account-management metadata. Tells a future Account -> K+ (and a future
 * account-deletion warning) whether the customer has a store subscription
 * they can act on, and in which store. It never carries a URL: the
 * manage-subscription destination is a client/platform concern.
 */
export interface KPlusAccountManagement {
  storeManagementRelevant: boolean;
  managementStore: KPlusStore | null;
}

/** Exactly the JSON get_my_kplus_entitlement_summary() returns. */
export interface KPlusEntitlementSummary {
  contractVersion: typeof KPLUS_SUMMARY_CONTRACT_VERSION;
  entitlementKey: typeof KPLUS_ENTITLEMENT_KEY;
  access: 'free' | 'k_plus';
  /** null when access is 'free'. */
  displaySource: KPlusDisplaySource | null;
  /** UTC ISO-8601. null when free, or when access is open-ended. */
  effectiveExpiresAt: string | null;
  isOpenEnded: boolean;
  trialEndsAt: string | null;
  willRenew: boolean | null;
  store: KPlusStore | null;
  billingState: KPlusBillingState | null;
  accountManagement: KPlusAccountManagement;
  /** Server time the snapshot was computed (UTC ISO-8601). */
  snapshotIssuedAt: string;
}

/**
 * Deleting a K Scan AI account does not cancel an Apple or Google
 * subscription. A future deletion flow must warn, and offer the store's own
 * management route, whenever this is true.
 */
export function kplusDeletionRequiresSubscriptionNotice(summary: KPlusEntitlementSummary): boolean {
  return summary.accountManagement.storeManagementRelevant === true;
}

// ── B. Trusted provider transition ─────────────────────────────────────────────

/**
 * Normalized, verified provider state for one subscription. Built only by
 * trusted server code (a future RevenueCat webhook or reconciliation pull),
 * after it has authenticated the provider and resolved userId from the
 * provider App User ID.
 */
export interface KPlusProviderTransitionInput {
  userId: string;
  provider: KPlusProvider;
  cause: KPlusProviderTransitionCause;
  /** Provider event id (retries reuse it); for a reconciliation pull, a fresh
   *  server-generated id prefixed `reconcile:`. */
  externalEventId: string;
  providerEventType: KPlusProviderEventType;
  /** Provider clock: the event timestamp, or the provider response time for a
   *  reconciliation pull. Never server receipt time. */
  providerOccurredAt: string;
  environment: KPlusProviderEnvironment;
  store: KPlusStore;
  productId: string;
  /** deriveKPlusSubscriptionRefDigest(...). Never the raw reference. */
  subscriptionRefDigest: string;
  lifecycleState: KPlusLifecycleState;
  periodType: KPlusPeriodType;
  periodStartsAt: string;
  /** Paid-through (or trial-end) instant of the current period. */
  expiresAt: string;
  willRenew: boolean;
  trialEndsAt?: string | null;
  gracePeriodExpiresAt?: string | null;
  pauseResumesAt?: string | null;
}

export type KPlusProviderTransitionResult =
  | {
    classification: 'applied';
    transitionId: string;
    grantId: string;
    activationId: string | null;
    accessBefore: boolean;
    accessAfter: boolean;
  }
  | {
    classification: 'duplicate';
    originalOutcome: 'applied' | 'stale';
    transitionId: string;
    grantId: string | null;
  }
  | {
    classification: 'stale';
    transitionId: string;
    grantId: string;
    accessBefore: boolean;
    accessAfter: boolean;
  }
  | { classification: 'rejected'; reason: KPlusProviderRejectionReason };

export const KPLUS_APPLY_PROVIDER_TRANSITION_RPC = 'apply_kplus_provider_transition' as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Maps the typed input onto the RPC's named arguments, refusing a raw
 *  subscription reference before it can reach the database. */
export function toApplyKPlusProviderTransitionArgs(input: KPlusProviderTransitionInput): Record<string, unknown> {
  if (!SHA256_HEX.test(input.subscriptionRefDigest)) {
    throw new Error('subscriptionRefDigest must be a lowercase hex SHA-256 digest');
  }
  return {
    p_user_id: input.userId,
    p_provider: input.provider,
    p_cause: input.cause,
    p_external_event_id: input.externalEventId,
    p_provider_event_type: input.providerEventType,
    p_provider_occurred_at: input.providerOccurredAt,
    p_environment: input.environment,
    p_store: input.store,
    p_product_id: input.productId,
    p_subscription_ref_digest: input.subscriptionRefDigest,
    p_lifecycle_state: input.lifecycleState,
    p_period_type: input.periodType,
    p_period_starts_at: input.periodStartsAt,
    p_expires_at: input.expiresAt,
    p_will_renew: input.willRenew,
    p_trial_ends_at: input.trialEndsAt ?? null,
    p_grace_period_expires_at: input.gracePeriodExpiresAt ?? null,
    p_pause_resumes_at: input.pauseResumesAt ?? null,
    p_entitlement_key: KPLUS_ENTITLEMENT_KEY,
  };
}

/**
 * The only form a store subscription reference takes inside K Scan AI:
 * SHA-256 over provider, store, environment and the provider's stable
 * subscription reference (for RevenueCat, `original_transaction_id`).
 * Deterministic, so the same subscription always maps to the same grant, and
 * one-way, so the ledger never holds a raw transaction id or purchase token.
 */
export async function deriveKPlusSubscriptionRefDigest(params: {
  provider: KPlusProvider;
  store: KPlusStore;
  environment: KPlusProviderEnvironment;
  storeSubscriptionReference: string;
}): Promise<string> {
  const reference = params.storeSubscriptionReference.trim();
  if (!reference) throw new Error('storeSubscriptionReference is required');
  const material = `${params.provider}|${params.store}|${params.environment}|${reference}`;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ── C. Complimentary grant ─────────────────────────────────────────────────────

/** Future access-code redemption calls this boundary; it never writes grants. */
export interface KPlusComplimentaryGrantInput {
  userId: string;
  source: KPlusComplimentarySource;
  /** Caller idempotency key, e.g. `access_code_redemption:<redemption id>`. */
  grantKey: string;
  campaignId?: string | null;
  /** Defaults to server now(). Future-dated grants are refused. */
  startsAt?: string | null;
  /** null = deliberately open-ended. */
  expiresAt?: string | null;
}

export type KPlusComplimentaryGrantResult =
  | {
    outcome: 'granted';
    grantId: string;
    transitionId: string;
    activationId: string | null;
    accessBefore: boolean;
    accessAfter: boolean;
  }
  | { outcome: 'already_granted'; grantId: string }
  | { outcome: 'grant_key_conflict'; grantId: string }
  | { outcome: 'rejected'; reason: 'unknown_user' | 'anonymous_identity' | 'account_not_active' };

export const KPLUS_GRANT_COMPLIMENTARY_RPC = 'grant_kplus_complimentary' as const;

export function toGrantKPlusComplimentaryArgs(input: KPlusComplimentaryGrantInput): Record<string, unknown> {
  return {
    p_user_id: input.userId,
    p_source: input.source,
    p_grant_key: input.grantKey,
    p_campaign_id: input.campaignId ?? null,
    p_starts_at: input.startsAt ?? null,
    p_expires_at: input.expiresAt ?? null,
    p_entitlement_key: KPLUS_ENTITLEMENT_KEY,
  };
}

export type KPlusGrantRevocationResult =
  | { outcome: 'revoked'; grantId: string; transitionId: string; accessBefore: boolean; accessAfter: boolean }
  | { outcome: 'already_revoked'; grantId: string }
  | { outcome: 'rejected'; reason: 'grant_not_found' | 'store_grant_requires_provider_transition' };

export const KPLUS_REVOKE_GRANT_RPC = 'revoke_kplus_grant' as const;

// ── D. Provider reconciliation (defined here, implemented in a later phase) ────

/**
 * `POST` to a future authenticated Edge Function. The body is deliberately
 * empty: identity comes from the verified JWT and the server pulls provider
 * state itself. A client can never tell the server what it purchased.
 */
export type KPlusReconciliationRequest = Record<string, never>;

export type KPlusReconciliationResponse =
  | {
    status: 'reconciled';
    transitions: { applied: number; duplicate: number; stale: number; rejected: number };
    summary: KPlusEntitlementSummary;
  }
  /** Provider unreachable: authority is unchanged and still returned. */
  | { status: 'provider_unavailable'; summary: KPlusEntitlementSummary }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'not_eligible'; reason: 'anonymous_identity' | 'account_not_active' };

export const KPLUS_RECONCILIATION_POLICY = Object.freeze({
  method: 'POST',
  identity: 'verified_jwt',
  providerAppUserId: 'supabase_auth_user_uuid',
  /** The pull applies each subscription as cause 'provider_reconciliation'. */
  transitionCause: 'provider_reconciliation',
  /** providerOccurredAt for a pull is the provider response time. */
  observedAt: 'provider_response_time',
  /** Rate limited per user; a burst never becomes provider traffic. */
  rateLimited: true,
} as const);

// ── E. RevenueCat normalization table (for the future adapter) ────────────────

/** RevenueCat `store` -> K+ store. `PROMOTIONAL` is RevenueCat's own granted
 *  entitlement -- i.e. the mirror of a K Scan AI complimentary grant -- and
 *  must never flow back in as authority. Everything else is unsupported. */
export const REVENUECAT_STORE_TO_KPLUS_STORE: Readonly<Record<string, KPlusStore>> = Object.freeze({
  APP_STORE: 'apple',
  PLAY_STORE: 'google',
});
export const REVENUECAT_STORES_NEVER_AUTHORITATIVE = Object.freeze(['PROMOTIONAL'] as const);

export const REVENUECAT_ENVIRONMENT_TO_KPLUS: Readonly<Record<string, KPlusProviderEnvironment>> = Object.freeze({
  PRODUCTION: 'production',
  SANDBOX: 'sandbox',
});

/** RevenueCat `period_type` -> K+ period. PROMOTIONAL is the mirror again. */
export const REVENUECAT_PERIOD_TYPE_TO_KPLUS: Readonly<Record<string, KPlusPeriodType>> = Object.freeze({
  TRIAL: 'trial',
  INTRO: 'paid',
  NORMAL: 'paid',
});

/**
 * RevenueCat webhook `type` -> normalized event type. `null` = not a K+
 * subscription lifecycle signal. RevenueCat reports a refund as CANCELLATION
 * with `cancel_reason = CUSTOMER_SUPPORT`; the adapter maps that to 'refund'.
 * A pause takes effect as EXPIRATION with `expiration_reason =
 * SUBSCRIPTION_PAUSED`, which carries lifecycle state 'paused'.
 */
export const REVENUECAT_EVENT_TYPE_TO_KPLUS: Readonly<Record<string, KPlusProviderEventType | null>> = Object.freeze({
  INITIAL_PURCHASE: 'initial_purchase',
  RENEWAL: 'renewal',
  PRODUCT_CHANGE: 'product_change',
  CANCELLATION: 'cancellation',
  UNCANCELLATION: 'uncancellation',
  BILLING_ISSUE: 'billing_issue',
  SUBSCRIPTION_PAUSED: 'subscription_paused',
  SUBSCRIPTION_EXTENDED: 'subscription_extended',
  EXPIRATION: 'expiration',
  REFUND_REVERSED: 'refund_reversed',
  TRANSFER: 'transfer',
  TEST: null,
  NON_RENEWING_PURCHASE: null,
  TEMPORARY_ENTITLEMENT_GRANT: null,
  INVOICE_ISSUANCE: null,
  VIRTUAL_CURRENCY_TRANSACTION: null,
  EXPERIMENT_ENROLLMENT: null,
  PURCHASE_REDEEMED: null,
  SUBSCRIBER_ALIAS: null,
  PRICE_INCREASE_CONSENT_REQUIRED: null,
  PRICE_INCREASE_CONSENT_APPROVED: null,
});

/** RevenueCat webhook fields that must never be persisted by K Scan AI.
 *  `original_transaction_id` is used only as digest input. */
export const REVENUECAT_EVENT_FIELDS_NEVER_PERSISTED = Object.freeze([
  'aliases',
  'app_user_id',
  'commission_percentage',
  'country_code',
  'currency',
  'offer_code',
  'original_app_user_id',
  'original_transaction_id',
  'presented_offering_id',
  'price',
  'price_in_purchased_currency',
  'subscriber_attributes',
  'takehome_percentage',
  'tax_percentage',
  'transaction_id',
  'transferred_from',
  'transferred_to',
] as const);

// ── F. Lifecycle activation event (Welcome to K+) ─────────────────────────────

export const KPLUS_ENTITLEMENT_ACTIVATED_EVENT = 'kplus.entitlement_activated' as const;

/** A row of public.kplus_entitlement_activations as service_role reads it. */
export interface KPlusEntitlementActivationRow {
  id: string;
  event_id: string;
  user_id: string;
  entitlement_key: string;
  activation_class: KPlusActivationClass;
  grant_id: string | null;
  legacy_entitlement_id: string | null;
  effective_started_at: string;
  effective_expires_at: string | null;
  effective_open_ended: boolean;
  is_reactivation: boolean;
  created_at: string;
}

/**
 * The delivery payload. Emitted once per activation (idempotency key:
 * eventId). No email address -- the sender resolves it at send time -- and no
 * price: a subscription_or_trial Welcome takes price, period and trial terms
 * from verified store/provider product data at send time. A complimentary
 * Welcome never mentions a charge, renewal or trial conversion.
 */
export interface KPlusEntitlementActivatedEvent {
  eventName: typeof KPLUS_ENTITLEMENT_ACTIVATED_EVENT;
  eventId: string;
  userId: string;
  activationId: string;
  activationClass: KPlusActivationClass;
  effectiveStartedAt: string;
  effectiveExpiresAt: string | null;
  effectiveOpenEnded: boolean;
  isReactivation: boolean;
}

export function toKPlusEntitlementActivatedEvent(row: KPlusEntitlementActivationRow): KPlusEntitlementActivatedEvent {
  return {
    eventName: KPLUS_ENTITLEMENT_ACTIVATED_EVENT,
    eventId: row.event_id,
    userId: row.user_id,
    activationId: row.id,
    activationClass: row.activation_class,
    effectiveStartedAt: row.effective_started_at,
    effectiveExpiresAt: row.effective_expires_at,
    effectiveOpenEnded: row.effective_open_ended,
    isReactivation: row.is_reactivation,
  };
}
