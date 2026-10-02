/**
 * RevenueCat webhook event -> K+ provider transition (Build 35 Phase C).
 *
 * Pure: no network, no database, no environment reads. It takes an
 * already-authenticated raw body and turns it into EITHER a fully-formed
 * KPlusProviderTransitionInput / KPlusLifetimeTransitionInput (the typed inputs
 * of the existing Phase 1 / Phase A RPCs) OR a bounded refusal that mutates
 * nothing.
 *
 * Event vocabulary: RevenueCat's documented webhook schema
 * (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields,
 * api_version "1.0"): TEST, INITIAL_PURCHASE, RENEWAL, CANCELLATION,
 * UNCANCELLATION, NON_RENEWING_PURCHASE, SUBSCRIPTION_PAUSED, EXPIRATION,
 * BILLING_ISSUE, PRODUCT_CHANGE, SUBSCRIPTION_EXTENDED, REFUND_REVERSED,
 * INVOICE_ISSUANCE, TRANSFER, TEMPORARY_ENTITLEMENT_GRANT,
 * VIRTUAL_CURRENCY_TRANSACTION, EXPERIMENT_ENROLLMENT, PURCHASE_REDEEMED,
 * SUBSCRIBER_ALIAS, PRICE_INCREASE_CONSENT_REQUIRED/APPROVED. A type not in
 * that list is "unknown" and mutates nothing.
 *
 * Facts about the provider this mapping depends on (from that documentation):
 *   - A refund is a CANCELLATION with cancel_reason = CUSTOMER_SUPPORT.
 *   - A plain CANCELLATION means auto-renew was turned off: the customer is paid
 *     THROUGH expiration_at_ms. It is not an access loss.
 *   - A scheduled pause (SUBSCRIPTION_PAUSED) does not revoke access; access
 *     ends on the later EXPIRATION with expiration_reason = SUBSCRIPTION_PAUSED.
 *   - BILLING_ISSUE carries grace_period_expiration_at_ms (null = no grace).
 *   - NON_RENEWING_PURCHASE is a one-time purchase and also describes
 *     consumables, so it is a lifetime signal ONLY for a product the server
 *     classification maps to LIFETIME.
 *
 * Doctrine:
 *   - The only actor identity is `app_user_id` and it must be a K Scan AI user
 *     UUID. Email, alias text, device ids and RevenueCat anonymous ids never map
 *     to an actor. `aliases` is never read.
 *   - Time comes from the provider (event_timestamp_ms), never the server clock.
 *   - Nothing here decides access. It produces facts for the transition RPCs,
 *     which own ordering, idempotency, ownership and environment checks.
 *   - Nothing raw is returned: no body, no receipt, no transaction id (the
 *     original transaction id only ever becomes a one-way digest).
 */
import {
  REVENUECAT_ENVIRONMENT_TO_KPLUS,
  REVENUECAT_PERIOD_TYPE_TO_KPLUS,
  REVENUECAT_STORE_TO_KPLUS_STORE,
  deriveKPlusLifetimePurchaseRefDigest,
  deriveKPlusSubscriptionRefDigest,
  type KPlusLifetimeProviderEventType,
  type KPlusLifetimeTransitionInput,
  type KPlusLifecycleState,
  type KPlusPeriodType,
  type KPlusProviderEnvironment,
  type KPlusProviderEventType,
  type KPlusProviderTransitionInput,
} from '../kplus/kplusEntitlementContract.ts';
import {
  classifyKPlusProduct,
  type KPlusProductClass,
  type KPlusProductClassificationConfig,
} from './revenueCatProductClassification.ts';

// ── The bounded subset of the webhook body this code reads ───────────────────

export interface RevenueCatWebhookEvent {
  id: string;
  type: string;
  eventTimestampMs: number;
  appUserId: string | null;
  originalAppUserId: string | null;
  productId: string | null;
  newProductId: string | null;
  periodType: string | null;
  purchasedAtMs: number | null;
  expirationAtMs: number | null;
  environment: string | null;
  store: string | null;
  originalTransactionId: string | null;
  cancelReason: string | null;
  expirationReason: string | null;
  gracePeriodExpirationAtMs: number | null;
  autoResumeAtMs: number | null;
}

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EVENT_TYPE = /^[A-Z][A-Z_]{0,63}$/;
const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);
/** Mirrors the transition RPCs' c_max_future_skew. */
const SKEW_MS = 15 * 60 * 1000;

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return undefined;
  return value;
}

function optionalMs(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_MS || value > MAX_MS) return undefined;
  return value;
}

export type RevenueCatParseResult = { ok: true; event: RevenueCatWebhookEvent } | { ok: false; reason: 'malformed' };

/** Strict, bounded parse. Unknown fields are dropped; a known field of the
 *  wrong type is a malformed payload, never silently null. */
export function parseRevenueCatWebhook(rawBody: string): RevenueCatParseResult {
  const bad: RevenueCatParseResult = { ok: false, reason: 'malformed' };
  let doc: unknown;
  try {
    doc = JSON.parse(rawBody);
  } catch {
    return bad;
  }
  const event = (doc as { event?: unknown } | null)?.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return bad;
  const e = event as Record<string, unknown>;

  if (typeof e.id !== 'string' || !EVENT_ID.test(e.id)) return bad;
  if (typeof e.type !== 'string' || !EVENT_TYPE.test(e.type)) return bad;
  const ts = optionalMs(e.event_timestamp_ms);
  if (ts === undefined || ts === null) return bad;

  const strings = {
    appUserId: optionalString(e.app_user_id),
    originalAppUserId: optionalString(e.original_app_user_id),
    productId: optionalString(e.product_id),
    newProductId: optionalString(e.new_product_id),
    periodType: optionalString(e.period_type),
    environment: optionalString(e.environment),
    store: optionalString(e.store),
    originalTransactionId: optionalString(e.original_transaction_id),
    cancelReason: optionalString(e.cancel_reason),
    expirationReason: optionalString(e.expiration_reason),
  };
  const numbers = {
    purchasedAtMs: optionalMs(e.purchased_at_ms),
    expirationAtMs: optionalMs(e.expiration_at_ms),
    gracePeriodExpirationAtMs: optionalMs(e.grace_period_expiration_at_ms),
    autoResumeAtMs: optionalMs(e.auto_resume_at_ms),
  };
  if (Object.values(strings).includes(undefined) || Object.values(numbers).includes(undefined)) return bad;

  return {
    ok: true,
    event: { id: e.id, type: e.type, eventTimestampMs: ts, ...(strings as Record<string, string | null>), ...(numbers as Record<string, number | null>) } as unknown as RevenueCatWebhookEvent,
  };
}

// ── Actor mapping ────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export type KScanActorResolution =
  | { ok: true; userId: string }
  | { ok: false; reason: 'missing' | 'not_a_k_scan_user_id' | 'alias_conflict' };

/**
 * The K Scan actor of an event, or why there is none.
 *
 * Only `app_user_id` can name the actor, and only when it is a UUID (Phase B
 * logs RevenueCat in as the Supabase user UUID). RevenueCat anonymous ids
 * ("$RCAnonymousID:..."), emails and any other text are refused.
 *
 * `original_app_user_id` is the customer record's first id. If it is ALSO a K
 * Scan UUID and DIFFERENT, ownership of this subscription / purchase has moved
 * between two K Scan accounts (a RevenueCat transfer or alias merge). No owner
 * policy exists for that yet, so it is refused rather than guessed -- the
 * original owner keeps whatever they already had.
 */
export function resolveKScanActor(event: Pick<RevenueCatWebhookEvent, 'appUserId' | 'originalAppUserId'>): KScanActorResolution {
  const id = event.appUserId;
  if (!id) return { ok: false, reason: 'missing' };
  if (!UUID.test(id) || id.toLowerCase() === NIL_UUID) return { ok: false, reason: 'not_a_k_scan_user_id' };
  const original = event.originalAppUserId;
  if (original && UUID.test(original) && original.toLowerCase() !== id.toLowerCase()) {
    return { ok: false, reason: 'alias_conflict' };
  }
  return { ok: true, userId: id.toLowerCase() };
}

// ── Normalization ────────────────────────────────────────────────────────────

export type RevenueCatIgnoreCategory =
  | 'test_event'
  | 'non_lifecycle_event_type'
  | 'unknown_event_type'
  | 'unsupported_store'
  | 'environment_not_accepted'
  | 'unsupported_period_type'
  | 'transfer_policy_required'
  | 'unmappable_actor'
  | 'lifetime_event_not_applicable';

export type RevenueCatConfigurationErrorReason =
  | 'unknown_product'
  | 'product_classification_not_configured'
  | 'product_classification_unparseable'
  | 'product_classification_malformed'
  | 'product_classification_ambiguous'
  | 'class_event_mismatch';

export type RevenueCatNormalization =
  | { kind: 'ignored'; category: RevenueCatIgnoreCategory; detail?: string }
  | { kind: 'malformed'; reason: string }
  | { kind: 'configuration_error'; reason: RevenueCatConfigurationErrorReason }
  | { kind: 'subscription'; input: KPlusProviderTransitionInput }
  | { kind: 'lifetime'; input: KPlusLifetimeTransitionInput };

export interface RevenueCatNormalizationContext {
  classification: KPlusProductClassificationConfig;
  /** Environments this deployment will mutate entitlement state from. */
  acceptedEnvironments: readonly KPlusProviderEnvironment[];
}

const NON_LIFECYCLE_TYPES = new Set([
  'TEMPORARY_ENTITLEMENT_GRANT',
  'INVOICE_ISSUANCE',
  'VIRTUAL_CURRENCY_TRANSACTION',
  'EXPERIMENT_ENROLLMENT',
  'PURCHASE_REDEEMED',
  'SUBSCRIBER_ALIAS',
  'PRICE_INCREASE_CONSENT_REQUIRED',
  'PRICE_INCREASE_CONSENT_APPROVED',
]);

const HANDLED_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'CANCELLATION',
  'UNCANCELLATION',
  'BILLING_ISSUE',
  'SUBSCRIPTION_PAUSED',
  'SUBSCRIPTION_EXTENDED',
  'EXPIRATION',
  'REFUND_REVERSED',
  'NON_RENEWING_PURCHASE',
]);

const iso = (ms: number) => new Date(ms).toISOString();

function configurationErrorFor(reason: string): RevenueCatConfigurationErrorReason {
  switch (reason) {
    case 'not_configured': return 'product_classification_not_configured';
    case 'unparseable': return 'product_classification_unparseable';
    case 'ambiguous': return 'product_classification_ambiguous';
    default: return 'product_classification_malformed';
  }
}

export async function normalizeRevenueCatEvent(
  event: RevenueCatWebhookEvent,
  context: RevenueCatNormalizationContext,
): Promise<RevenueCatNormalization> {
  const type = event.type;

  if (type === 'TEST') return { kind: 'ignored', category: 'test_event' };
  // Ownership moving between two K Scan accounts needs an owner policy that does
  // not exist yet. Nothing is moved, granted or revoked on a TRANSFER.
  if (type === 'TRANSFER') return { kind: 'ignored', category: 'transfer_policy_required' };
  if (NON_LIFECYCLE_TYPES.has(type)) return { kind: 'ignored', category: 'non_lifecycle_event_type' };
  if (!HANDLED_TYPES.has(type)) return { kind: 'ignored', category: 'unknown_event_type' };

  // Store: only the two real stores are authoritative. PROMOTIONAL is
  // RevenueCat's own mirror of a K Scan AI complimentary grant and must never
  // flow back in as authority; Stripe/Amazon/Test Store etc. are unsupported.
  const store = event.store ? REVENUECAT_STORE_TO_KPLUS_STORE[event.store] : undefined;
  if (!store) return { kind: 'ignored', category: 'unsupported_store' };

  const environment = event.environment ? REVENUECAT_ENVIRONMENT_TO_KPLUS[event.environment] : undefined;
  if (!environment) return { kind: 'malformed', reason: 'environment' };
  if (!context.acceptedEnvironments.includes(environment)) {
    return { kind: 'ignored', category: 'environment_not_accepted', detail: environment };
  }

  const actor = resolveKScanActor(event);
  if (!actor.ok) return { kind: 'ignored', category: 'unmappable_actor', detail: actor.reason };

  if (!event.productId) return { kind: 'malformed', reason: 'product_id' };
  const classified = classifyKPlusProduct(context.classification, store, event.productId);
  if (classified.status === 'configuration_error') {
    return { kind: 'configuration_error', reason: configurationErrorFor(classified.reason) };
  }
  if (classified.status === 'unknown_product') return { kind: 'configuration_error', reason: 'unknown_product' };
  const productClass: KPlusProductClass = classified.productClass;

  if (!event.originalTransactionId) return { kind: 'malformed', reason: 'original_transaction_id' };

  if (productClass === 'LIFETIME') {
    return normalizeLifetime(event, actor.userId, store, environment);
  }
  return normalizeSubscription(event, actor.userId, store, environment, context);
}

// ── Lifetime ─────────────────────────────────────────────────────────────────

async function normalizeLifetime(
  event: RevenueCatWebhookEvent,
  userId: string,
  store: 'apple' | 'google',
  environment: KPlusProviderEnvironment,
): Promise<RevenueCatNormalization> {
  let providerEventType: KPlusLifetimeProviderEventType;
  let lifecycleState: 'active' | 'refunded';

  switch (event.type) {
    case 'NON_RENEWING_PURCHASE':
      providerEventType = 'lifetime_purchase';
      lifecycleState = 'active';
      break;
    case 'REFUND_REVERSED':
      providerEventType = 'refund_reversed';
      lifecycleState = 'active';
      break;
    case 'CANCELLATION':
    case 'EXPIRATION':
      // A lifetime purchase has no renewal to cancel and no period to expire:
      // the only cancellation that means anything is a refund / revocation.
      if (
        (event.type === 'CANCELLATION' && event.cancelReason === 'CUSTOMER_SUPPORT')
        || (event.type === 'EXPIRATION' && event.expirationReason === 'CUSTOMER_SUPPORT')
      ) {
        providerEventType = 'refund';
        lifecycleState = 'refunded';
        break;
      }
      return { kind: 'ignored', category: 'lifetime_event_not_applicable', detail: event.type };
    default:
      // A subscription lifecycle event for a product classified LIFETIME means
      // the classification and the store product disagree. Loud, not ignored.
      return { kind: 'configuration_error', reason: 'class_event_mismatch' };
  }

  if (event.purchasedAtMs === null) return { kind: 'malformed', reason: 'purchased_at_ms' };
  if (event.purchasedAtMs > event.eventTimestampMs + SKEW_MS) return { kind: 'malformed', reason: 'purchase_after_event' };

  const purchaseRefDigest = await deriveKPlusLifetimePurchaseRefDigest({
    provider: 'revenuecat',
    store,
    environment,
    storePurchaseReference: event.originalTransactionId as string,
  });

  return {
    kind: 'lifetime',
    input: {
      userId,
      provider: 'revenuecat',
      cause: 'provider_event',
      externalEventId: event.id,
      providerEventType,
      providerOccurredAt: iso(event.eventTimestampMs),
      environment,
      store,
      productId: event.productId as string,
      purchaseRefDigest,
      lifecycleState,
      purchasedAt: iso(event.purchasedAtMs),
    },
  };
}

// ── Subscription ─────────────────────────────────────────────────────────────

async function normalizeSubscription(
  event: RevenueCatWebhookEvent,
  userId: string,
  store: 'apple' | 'google',
  environment: KPlusProviderEnvironment,
  context: RevenueCatNormalizationContext,
): Promise<RevenueCatNormalization> {
  if (event.type === 'NON_RENEWING_PURCHASE') return { kind: 'configuration_error', reason: 'class_event_mismatch' };

  // PRODUCT_CHANGE: the product the customer is moving to must be a classified
  // monthly subscription too, or the change is not one we can represent.
  let productId = event.productId as string;
  if (event.type === 'PRODUCT_CHANGE' && event.newProductId) {
    const next = classifyKPlusProduct(context.classification, store, event.newProductId);
    if (next.status === 'configuration_error') return { kind: 'configuration_error', reason: configurationErrorFor(next.reason) };
    if (next.status === 'unknown_product') return { kind: 'configuration_error', reason: 'unknown_product' };
    if (next.productClass !== 'MONTHLY_SUBSCRIPTION') return { kind: 'configuration_error', reason: 'class_event_mismatch' };
    productId = event.newProductId;
  }

  const periodType: KPlusPeriodType | undefined = event.periodType ? REVENUECAT_PERIOD_TYPE_TO_KPLUS[event.periodType] : undefined;
  if (!event.periodType) return { kind: 'malformed', reason: 'period_type' };
  // PROMOTIONAL / PREPAID periods are not store subscription periods K+ models.
  if (!periodType) return { kind: 'ignored', category: 'unsupported_period_type', detail: event.periodType };
  if (event.purchasedAtMs === null) return { kind: 'malformed', reason: 'purchased_at_ms' };
  if (event.expirationAtMs === null) return { kind: 'malformed', reason: 'expiration_at_ms' };
  if (event.expirationAtMs <= event.purchasedAtMs) return { kind: 'malformed', reason: 'expiration_not_after_period_start' };

  const ts = event.eventTimestampMs;
  const elapsed = event.expirationAtMs <= ts + SKEW_MS;
  /** A live period: trial while the provider says trial, otherwise paid. */
  const liveState: KPlusLifecycleState = periodType === 'trial' ? 'trial' : 'active';

  let providerEventType: KPlusProviderEventType;
  let lifecycleState: KPlusLifecycleState;
  let willRenew: boolean;
  let gracePeriodExpiresAt: string | null = null;
  let pauseResumesAt: string | null = null;

  switch (event.type) {
    case 'INITIAL_PURCHASE':
      providerEventType = 'initial_purchase'; lifecycleState = liveState; willRenew = true; break;
    case 'RENEWAL':
      providerEventType = 'renewal'; lifecycleState = liveState; willRenew = true; break;
    case 'PRODUCT_CHANGE':
      providerEventType = 'product_change'; lifecycleState = liveState; willRenew = true; break;
    case 'UNCANCELLATION':
      providerEventType = 'uncancellation'; lifecycleState = liveState; willRenew = true; break;
    case 'SUBSCRIPTION_EXTENDED':
      providerEventType = 'subscription_extended'; lifecycleState = liveState; willRenew = true; break;
    case 'REFUND_REVERSED':
      providerEventType = 'refund_reversed'; lifecycleState = liveState; willRenew = false; break;
    case 'SUBSCRIPTION_PAUSED':
      // Scheduled pause: access is NOT revoked here; it ends on EXPIRATION.
      providerEventType = 'subscription_paused'; lifecycleState = liveState; willRenew = false; break;
    case 'CANCELLATION':
      willRenew = false;
      if (event.cancelReason === 'CUSTOMER_SUPPORT') {
        // A refund: the one cancellation that DOES end access immediately.
        providerEventType = 'refund'; lifecycleState = 'refunded';
      } else {
        // Auto-renew turned off. Paid-through access is preserved until the
        // provider's expiration; only an already-elapsed period reads expired.
        providerEventType = 'cancellation'; lifecycleState = elapsed ? 'expired' : liveState;
      }
      break;
    case 'BILLING_ISSUE':
      providerEventType = 'billing_issue'; willRenew = false;
      if (event.gracePeriodExpirationAtMs !== null) {
        lifecycleState = 'grace_period';
        gracePeriodExpiresAt = iso(event.gracePeriodExpirationAtMs);
      } else {
        lifecycleState = 'billing_retry';
      }
      break;
    case 'EXPIRATION':
      willRenew = false;
      providerEventType = 'expiration';
      if (event.expirationReason === 'SUBSCRIPTION_PAUSED') {
        lifecycleState = 'paused';
        if (event.autoResumeAtMs !== null) pauseResumesAt = iso(event.autoResumeAtMs);
      } else if (event.expirationReason === 'CUSTOMER_SUPPORT') {
        providerEventType = 'refund'; lifecycleState = 'refunded';
      } else {
        // An expiration whose end is still in the future is the provider ending
        // access early (e.g. developer-initiated): revoked, not merely expired.
        lifecycleState = elapsed ? 'expired' : 'revoked';
      }
      break;
    default:
      return { kind: 'ignored', category: 'unknown_event_type' };
  }

  const subscriptionRefDigest = await deriveKPlusSubscriptionRefDigest({
    provider: 'revenuecat',
    store,
    environment,
    storeSubscriptionReference: event.originalTransactionId as string,
  });

  return {
    kind: 'subscription',
    input: {
      userId,
      provider: 'revenuecat',
      cause: 'provider_event',
      externalEventId: event.id,
      providerEventType,
      providerOccurredAt: iso(ts),
      environment,
      store,
      productId,
      subscriptionRefDigest,
      lifecycleState,
      periodType,
      periodStartsAt: iso(event.purchasedAtMs),
      expiresAt: iso(event.expirationAtMs),
      willRenew,
      trialEndsAt: periodType === 'trial' ? iso(event.expirationAtMs) : null,
      gracePeriodExpiresAt,
      pauseResumesAt,
    },
  };
}
