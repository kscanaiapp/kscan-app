/**
 * RevenueCat current-state -> governed K+ provider transitions.
 *
 * This module never returns an entitlement decision. Its successful response
 * instructs the caller to reread the canonical Supabase summary.
 */
import {
  KPLUS_RECONCILE_PROVIDER_LIFETIME_TRANSITION_RPC,
  KPLUS_RECONCILE_PROVIDER_TRANSITION_RPC,
  deriveKPlusLifetimePurchaseRefDigest,
  deriveKPlusSubscriptionRefDigest,
  toApplyKPlusProviderLifetimeTransitionArgs,
  toApplyKPlusProviderTransitionArgs,
  type KPlusLifetimeLifecycleState,
  type KPlusLifecycleState,
  type KPlusPeriodType,
  type KPlusStore,
} from '../kplus/kplusEntitlementContract.ts';
import {
  classifyKPlusProduct,
  type KPlusProductClassificationConfig,
} from './revenueCatProductClassification.ts';
import {
  fetchRevenueCatCurrentState,
  fetchRevenueCatEvents,
  resolveRevenueCatProduct,
  type ProviderClientConfig,
  type ProviderClientDeps,
  type RevenueCatEventResource,
  type RevenueCatPurchaseResource,
  type RevenueCatSubscriptionResource,
} from './revenueCatProviderStateClient.ts';

export const KPLUS_LIST_PROVIDER_GRANTS_RPC = 'list_kplus_provider_grants_for_reconciliation' as const;

export interface LocalProviderGrant {
  grant_id: string;
  source: 'store_subscription' | 'store_lifetime';
  grant_key: string;
  store: KPlusStore;
  product_id: string;
  current_period_type: KPlusPeriodType | null;
  current_period_starts_at: string | null;
  expires_at: string | null;
  will_renew: boolean | null;
  billing_state: string | null;
  grace_period_expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  provider_state_occurred_at: string;
  provider_state_rank: number;
  provider_state_event_id: string;
  last_provider_verified_at: string | null;
}

export interface ReconciliationRpcResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface ReconciliationDeps extends ProviderClientDeps {
  callRpc: (fn: string, args: Record<string, unknown>) => Promise<ReconciliationRpcResult>;
  listLocalGrants: (actorId: string, environment: 'production' | 'sandbox') => Promise<LocalProviderGrant[]>;
  log: (event: string, fields: Record<string, unknown>) => void;
}

export type ReconciliationOutcome =
  | {
    status: 'reconciled';
    transitions: { applied: number; duplicate: number; stale: number; rejected: number };
    unresolvedDrift: number;
    canonicalRefreshRequired: true;
  }
  | { status: 'ownership_conflict'; canonicalRefreshRequired: true }
  | { status: 'provider_unavailable'; retryable: true }
  | { status: 'provider_throttled'; retryAfterSeconds: number }
  | { status: 'provider_malformed'; retryable: false }
  | { status: 'canonical_transition_failed'; retryable: true };

export interface ReconciliationConfig {
  provider: ProviderClientConfig;
  classification: KPlusProductClassificationConfig;
}

interface SubscriptionObservation {
  family: 'subscription';
  resource: RevenueCatSubscriptionResource;
  store: KPlusStore;
  productId: string;
  refDigest: string;
  lifecycleState: KPlusLifecycleState;
  periodType: KPlusPeriodType;
  periodStartsAt: string;
  expiresAt: string;
  willRenew: boolean;
  trialEndsAt: string | null;
  gracePeriodExpiresAt: string | null;
  currentStateTimestamp: string;
  accessBearing: boolean;
  requiresTerminalEvidence: boolean;
}

interface LifetimeObservation {
  family: 'lifetime';
  resource: RevenueCatPurchaseResource;
  store: KPlusStore;
  productId: string;
  refDigest: string;
  lifecycleState: KPlusLifetimeLifecycleState;
  purchasedAt: string;
  currentStateTimestamp: string;
  accessBearing: boolean;
  requiresTerminalEvidence: boolean;
}

type Observation = SubscriptionObservation | LifetimeObservation;

const STORE: Readonly<Record<string, KPlusStore | undefined>> = Object.freeze({
  app_store: 'apple',
  mac_app_store: 'apple',
  APP_STORE: 'apple',
  MAC_APP_STORE: 'apple',
  play_store: 'google',
  PLAY_STORE: 'google',
});

function timestamp(value: string | null | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

function matchingLocal(
  grants: LocalProviderGrant[],
  family: Observation['family'],
  store: KPlusStore,
  productId: string,
): LocalProviderGrant[] {
  const source = family === 'subscription' ? 'store_subscription' : 'store_lifetime';
  return grants.filter((g) => g.source === source && g.store === store && g.product_id === productId);
}

function localIsTerminal(grant: LocalProviderGrant | undefined, nowMs: number): boolean {
  if (!grant) return false;
  return grant.revoked_at !== null ||
    (grant.source === 'store_subscription' && grant.expires_at !== null && timestamp(grant.expires_at) <= nowMs);
}

/** Exported so the two conflict matrices are directly unit-testable. */
export function subscriptionEvidenceDecision(
  providerState: 'trialing' | 'active' | 'cancelled_paid_through' | 'grace' | 'retry_pending' | 'expired' | 'absent' | 'ambiguous',
  localState: 'absent' | 'live' | 'terminal',
): 'current_state' | 'event_required' | 'unresolved' | 'no_op' {
  if (providerState === 'absent' || providerState === 'ambiguous') return 'unresolved';
  if (providerState === 'retry_pending' || providerState === 'expired') {
    return localState === 'live' ? 'event_required' : 'no_op';
  }
  if (localState === 'terminal') return 'event_required';
  return 'current_state';
}

/** Exported so lifetime never accidentally shares subscription rules. */
export function lifetimeEvidenceDecision(
  providerState: 'owned' | 'refunded_revoked' | 'absent' | 'ambiguous',
  localState: 'absent' | 'live' | 'terminal',
): 'current_state' | 'event_required' | 'unresolved' | 'no_op' {
  if (providerState === 'absent' || providerState === 'ambiguous') return 'unresolved';
  if (providerState === 'refunded_revoked') return localState === 'live' ? 'event_required' : 'no_op';
  if (localState === 'terminal') return 'event_required';
  return 'current_state';
}

function normalizeSubscription(
  resource: RevenueCatSubscriptionResource,
  store: KPlusStore,
  productId: string,
  refDigest: string,
): SubscriptionObservation | null {
  const end = resource.endsAt ?? resource.currentPeriodEndsAt;
  if (!end) return null;
  const willRenew = resource.autoRenewalStatus === 'will_renew' ||
    resource.autoRenewalStatus === 'has_already_renewed';
  let lifecycleState: KPlusLifecycleState;
  let periodType: KPlusPeriodType = 'paid';
  let accessBearing = resource.givesAccess;
  let requiresTerminalEvidence = false;
  switch (resource.status) {
    case 'trialing':
      if (!resource.givesAccess || resource.pendingPayment) return null;
      lifecycleState = 'trial';
      periodType = 'trial';
      break;
    case 'active':
      if (!resource.givesAccess || resource.pendingPayment) {
        lifecycleState = 'billing_retry';
        accessBearing = false;
        requiresTerminalEvidence = true;
      } else lifecycleState = 'active';
      break;
    case 'in_grace_period':
      if (!resource.givesAccess) return null;
      lifecycleState = 'grace_period';
      break;
    case 'in_billing_retry':
    case 'incomplete':
      lifecycleState = 'billing_retry';
      accessBearing = false;
      requiresTerminalEvidence = true;
      break;
    case 'expired':
      lifecycleState = 'expired';
      accessBearing = false;
      requiresTerminalEvidence = true;
      break;
    default:
      return null;
  }
  return {
    family: 'subscription', resource, store, productId, refDigest,
    lifecycleState, periodType, periodStartsAt: resource.currentPeriodStartsAt,
    expiresAt: end, willRenew, trialEndsAt: periodType === 'trial' ? end : null,
    gracePeriodExpiresAt: lifecycleState === 'grace_period' ? end : null,
    currentStateTimestamp: resource.currentPeriodStartsAt,
    accessBearing, requiresTerminalEvidence,
  };
}

function normalizeLifetime(
  resource: RevenueCatPurchaseResource,
  store: KPlusStore,
  productId: string,
  refDigest: string,
): LifetimeObservation | null {
  if (!['owned', 'refunded', 'revoked'].includes(resource.status)) return null;
  const lifecycleState: KPlusLifetimeLifecycleState = resource.status === 'owned'
    ? 'active'
    : resource.status as 'refunded' | 'revoked';
  return {
    family: 'lifetime', resource, store, productId, refDigest,
    lifecycleState, purchasedAt: resource.purchasedAt,
    currentStateTimestamp: resource.purchasedAt, accessBearing: lifecycleState === 'active',
    requiresTerminalEvidence: lifecycleState !== 'active',
  };
}

function eventMatches(
  event: RevenueCatEventResource,
  actorId: string,
  observation: Observation,
): boolean {
  const resource = observation.resource;
  const rawReference = observation.family === 'subscription'
    ? observation.resource.storeSubscriptionIdentifier
    : observation.resource.storePurchaseIdentifier;
  return event.appUserId === actorId && event.originalAppUserId === actorId &&
    event.environment === resource.environment &&
    (event.store === null || STORE[event.store] === observation.store) &&
    (event.productId === null || event.productId === observation.productId || event.productId === resource.productResourceId) &&
    (event.transactionId === rawReference || event.originalTransactionId === rawReference);
}

const TERMINAL_EVENT_TYPES = new Set(['EXPIRATION', 'CANCELLATION', 'BILLING_ISSUE', 'REFUND', 'TRANSFER']);
const RESTORING_EVENT_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'REFUND_REVERSED', 'NON_RENEWING_PURCHASE']);

function corroboratingEvent(
  events: RevenueCatEventResource[],
  actorId: string,
  observation: Observation,
  local: LocalProviderGrant,
): RevenueCatEventResource | null {
  const needed = observation.accessBearing ? RESTORING_EVENT_TYPES : TERMINAL_EVENT_TYPES;
  const watermark = timestamp(local.provider_state_occurred_at);
  const matches = events.filter((event) =>
    eventMatches(event, actorId, observation) && needed.has(event.type.toUpperCase()) &&
    timestamp(event.occurredAt) > watermark
  );
  matches.sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt));
  return matches[0] ?? null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function stateIdentity(actorId: string, observation: Observation, occurredAt: string): Promise<string> {
  const stable = observation.family === 'subscription'
    ? {
      actorId, family: observation.family, store: observation.store,
      environment: observation.resource.environment, productId: observation.productId,
      referenceDigest: observation.refDigest, lifecycleState: observation.lifecycleState,
      periodType: observation.periodType, periodStartsAt: observation.periodStartsAt,
      expiresAt: observation.expiresAt, willRenew: observation.willRenew,
      materialTimestamp: occurredAt,
    }
    : {
      actorId, family: observation.family, store: observation.store,
      environment: observation.resource.environment, productId: observation.productId,
      referenceDigest: observation.refDigest, lifecycleState: observation.lifecycleState,
      purchasedAt: observation.purchasedAt, materialTimestamp: occurredAt,
    };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(stable)));
  return `rcpull_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function providerFailure(result: { kind: string; retryAfterSeconds?: number }): ReconciliationOutcome {
  if (result.kind === 'throttled') return { status: 'provider_throttled', retryAfterSeconds: result.retryAfterSeconds ?? 30 };
  if (result.kind === 'unavailable') return { status: 'provider_unavailable', retryable: true };
  return { status: 'provider_malformed', retryable: false };
}

export async function reconcileRevenueCatProviderState(
  actorId: string,
  config: ReconciliationConfig,
  deps: ReconciliationDeps,
): Promise<ReconciliationOutcome> {
  const current = await fetchRevenueCatCurrentState(deps, config.provider, actorId);
  if (!current.ok) return providerFailure(current);
  deps.log('kplus_rc_pull_provider_query_success', {
    subscription_count: current.value.subscriptions.length,
    purchase_count: current.value.purchases.length,
  });

  let local: LocalProviderGrant[];
  try {
    local = await deps.listLocalGrants(actorId, config.provider.environment);
  } catch {
    return { status: 'canonical_transition_failed', retryable: true };
  }

  const observations: Observation[] = [];
  let rejected = 0;
  let ownershipConflict = false;
  const resources = [...current.value.subscriptions, ...current.value.purchases];
  for (const resource of resources) {
    if (resource.customerId !== actorId || resource.originalCustomerId !== actorId) {
      ownershipConflict = true;
      deps.log('kplus_rc_pull_ownership_conflict', { family: 'status' in resource ? 'lifetime' : 'subscription' });
      continue;
    }
    if (resource.environment !== config.provider.environment) {
      rejected += 1;
      deps.log('kplus_rc_pull_environment_refusal', {});
      continue;
    }
    const store = STORE[resource.store];
    if (!store) continue; // promotional and unsupported stores are never inbound authority.
    const productResult = await resolveRevenueCatProduct(deps, config.provider, resource.productResourceId, resource.embeddedProduct);
    if (!productResult.ok) {
      if (productResult.kind === 'unavailable' || productResult.kind === 'throttled') return providerFailure(productResult);
      rejected += 1;
      deps.log('kplus_rc_pull_unknown_product', { reason: 'product_lookup_failed' });
      continue;
    }
    deps.log('kplus_rc_pull_product_resolved', { source: productResult.value.source });
    const product = productResult.value.product;
    const classified = classifyKPlusProduct(config.classification, store, product.storeIdentifier);
    if (classified.status !== 'classified') {
      rejected += 1;
      deps.log('kplus_rc_pull_unknown_product', { reason: classified.status });
      continue;
    }
    if ((classified.productClass === 'MONTHLY_SUBSCRIPTION' && product.type !== 'subscription') ||
        (classified.productClass === 'LIFETIME' && !['one_time', 'non_consumable'].includes(product.type))) {
      rejected += 1;
      deps.log('kplus_rc_pull_unknown_product', { reason: 'product_type_mismatch' });
      continue;
    }
    if ('storeSubscriptionIdentifier' in resource) {
      if (classified.productClass !== 'MONTHLY_SUBSCRIPTION') { rejected += 1; continue; }
      const refDigest = await deriveKPlusSubscriptionRefDigest({
        provider: 'revenuecat', store, environment: resource.environment,
        storeSubscriptionReference: resource.storeSubscriptionIdentifier,
      });
      const normalized = normalizeSubscription(resource, store, product.storeIdentifier, refDigest);
      if (normalized) observations.push(normalized);
      else {
        rejected += 1;
        deps.log('kplus_rc_pull_unresolved_drift', { family: 'subscription', reason: 'ambiguous_provider_state' });
      }
    } else {
      if (classified.productClass !== 'LIFETIME') { rejected += 1; continue; }
      const refDigest = await deriveKPlusLifetimePurchaseRefDigest({
        provider: 'revenuecat', store, environment: resource.environment,
        storePurchaseReference: resource.storePurchaseIdentifier,
      });
      const normalized = normalizeLifetime(resource, store, product.storeIdentifier, refDigest);
      if (normalized) observations.push(normalized);
      else {
        rejected += 1;
        deps.log('kplus_rc_pull_unresolved_drift', { family: 'lifetime', reason: 'ambiguous_provider_state' });
      }
    }
  }

  if (ownershipConflict) return { status: 'ownership_conflict', canonicalRefreshRequired: true };

  let events: RevenueCatEventResource[] | null = null;
  const counters = { applied: 0, duplicate: 0, stale: 0, rejected };
  let unresolvedDrift = 0;
  const seenLocal = new Set<string>();

  for (const observation of observations) {
    const matches = matchingLocal(local, observation.family, observation.store, observation.productId);
    if (matches.length > 1) return { status: 'ownership_conflict', canonicalRefreshRequired: true };
    const grant = matches[0];
    if (grant) seenLocal.add(grant.grant_id);
    const terminal = localIsTerminal(grant, deps.now());
    const decision = observation.family === 'subscription'
      ? subscriptionEvidenceDecision(
        observation.lifecycleState === 'trial' ? 'trialing'
          : observation.lifecycleState === 'active' && !observation.willRenew ? 'cancelled_paid_through'
          : observation.lifecycleState === 'active' ? 'active'
          : observation.lifecycleState === 'grace_period' ? 'grace'
          : observation.lifecycleState === 'billing_retry' ? 'retry_pending' : 'expired',
        !grant ? 'absent' : terminal ? 'terminal' : 'live',
      )
      : lifetimeEvidenceDecision(
        observation.lifecycleState === 'active' ? 'owned' : 'refunded_revoked',
        !grant ? 'absent' : terminal ? 'terminal' : 'live',
      );

    let occurredAt = observation.currentStateTimestamp;
    if (decision === 'event_required' || observation.requiresTerminalEvidence) {
      if (!grant) continue;
      if (!events) {
        const eventResult = await fetchRevenueCatEvents(deps, config.provider, actorId);
        if (!eventResult.ok) return providerFailure(eventResult);
        events = eventResult.value;
      }
      const event = corroboratingEvent(events, actorId, observation, grant);
      if (!event) {
        unresolvedDrift += 1;
        deps.log('kplus_rc_pull_unresolved_drift', { family: observation.family, reason: 'chronology_unproved' });
        continue;
      }
      occurredAt = event.occurredAt;
    }
    if (decision === 'no_op' || decision === 'unresolved') {
      if (decision === 'unresolved') unresolvedDrift += 1;
      continue;
    }

    const externalEventId = await stateIdentity(actorId, observation, occurredAt);
    const args = observation.family === 'subscription'
      ? toApplyKPlusProviderTransitionArgs({
        userId: actorId, provider: 'revenuecat', cause: 'provider_reconciliation', externalEventId,
        providerEventType: 'reconciliation_snapshot', providerOccurredAt: occurredAt,
        environment: observation.resource.environment, store: observation.store,
        productId: observation.productId, subscriptionRefDigest: observation.refDigest,
        lifecycleState: observation.lifecycleState, periodType: observation.periodType,
        periodStartsAt: observation.periodStartsAt, expiresAt: observation.expiresAt,
        willRenew: observation.willRenew, trialEndsAt: observation.trialEndsAt,
        gracePeriodExpiresAt: observation.gracePeriodExpiresAt,
      })
      : toApplyKPlusProviderLifetimeTransitionArgs({
        userId: actorId, provider: 'revenuecat', cause: 'provider_reconciliation', externalEventId,
        providerEventType: 'reconciliation_snapshot', providerOccurredAt: occurredAt,
        environment: observation.resource.environment, store: observation.store,
        productId: observation.productId, purchaseRefDigest: observation.refDigest,
        lifecycleState: observation.lifecycleState, purchasedAt: observation.purchasedAt,
      });
    const fn = observation.family === 'subscription'
      ? KPLUS_RECONCILE_PROVIDER_TRANSITION_RPC
      : KPLUS_RECONCILE_PROVIDER_LIFETIME_TRANSITION_RPC;
    let result: ReconciliationRpcResult;
    try {
      result = await deps.callRpc(fn, args);
    } catch {
      return { status: 'canonical_transition_failed', retryable: true };
    }
    if (!result.ok || !result.body || typeof result.body !== 'object') {
      return { status: 'canonical_transition_failed', retryable: true };
    }
    const classification = (result.body as { classification?: unknown }).classification;
    if (classification === 'applied' || classification === 'duplicate' || classification === 'stale' || classification === 'rejected') {
      counters[classification] += 1;
      const drift = (result.body as { driftDetected?: unknown }).driftDetected === true;
      deps.log('kplus_rc_pull_transition', { family: observation.family, outcome: classification, drift });
    } else return { status: 'canonical_transition_failed', retryable: true };
  }

  // Absence is not revocation. It is bounded unresolved drift. Event resources
  // are deliberately not converted into a grant mutation without a current
  // resource to establish product identity and grant family.
  for (const grant of local) {
    if (!seenLocal.has(grant.grant_id) && !localIsTerminal(grant, deps.now())) {
      unresolvedDrift += 1;
      deps.log('kplus_rc_pull_unresolved_drift', { family: grant.source, reason: 'provider_absent' });
    }
  }

  deps.log('kplus_rc_pull_complete', { ...counters, unresolved_drift: unresolvedDrift });
  return { status: 'reconciled', transitions: counters, unresolvedDrift, canonicalRefreshRequired: true };
}
