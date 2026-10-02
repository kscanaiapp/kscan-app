/**
 * K+ native commerce service (Build 35 Phase B).
 *
 * The native purchase / restore machinery that will sit under the future paid
 * paywall. It owns the commerce state machine and nothing else.
 *
 *   APPLE / GOOGLE STORE -> REVENUECAT -> (Phase C: verified lifecycle)
 *     -> SUPABASE CANONICAL K+ AUTHORITY -> useKPlusEntitlement()
 *
 * DOCTRINE (each is pinned by __tests__/kplusRevenueCatNativeCommerce.test.js
 * with a negative control):
 *
 *   1. This service NEVER decides K+ access. A completed purchase, a completed
 *      restore and a CustomerInfo update are provider facts; the only thing
 *      they do is trigger a canonical re-read (refreshKPlusEntitlement). The
 *      status 'ENTITLEMENT_CONFIRMED' is derived from what the canonical store
 *      then reports, never from the provider result.
 *   2. Until canonical authority says K+, a completed purchase / restore reads
 *      *_ENTITLEMENT_RESOLVING: not free, not active.
 *   3. Identity is the authenticated Supabase user UUID -- never an email, a
 *      phone, a device or advertising id. The SDK is configured already
 *      identified as that actor, and every purchase re-verifies the SDK's
 *      current customer IS the actor, so no anonymous customer can buy.
 *   4. An actor change (sign-out included) bumps a generation. Everything this
 *      service remembers is dropped synchronously, an in-flight purchase /
 *      restore completion is DISCARDED, and the next actor can observe none of
 *      the previous actor's offerings or provider state.
 *   5. Nothing provider-shaped is persisted or logged: no CustomerInfo, no
 *      receipt, no purchase token. Errors are reduced to their RevenueCat code.
 *   6. Prices, currencies, trial lengths and store product ids all come from
 *      the store through RevenueCat. Nothing here names one.
 *
 * It does not read EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: that flag controls
 * only legacy complimentary acquisition, never paid commerce.
 *
 * Phase C (server-side verified lifecycle ingestion) is what makes a store
 * purchase become a canonical grant. Until then a real purchase legitimately
 * stays in the RESOLVING state.
 */
import { getKPlusEntitlementClientState, refreshKPlusEntitlement } from './kplusEntitlementStore';
import { KPLUS_ALLOW_REVENUECAT_TEST_STORE_KEY, readRevenueCatPublicKeysFromEnv } from './revenueCatConfig';
import { revenueCatNativePort } from './revenueCatNative';
import { supabase } from '../supabaseClient';
import {
  INITIAL_KPLUS_COMMERCE_SNAPSHOT,
  normalizeKPlusOfferings,
  resolveKPlusRevenueCatConfig,
  type KPlusCommerceSnapshot,
  type KPlusIntroEligibility,
  type KPlusNativeCommercePort,
  type KPlusProductCatalog,
  type KPlusProductKind,
  type KPlusProductMappingConfig,
  type KPlusPurchaseOutcome,
  type KPlusRestoreOutcome,
  type KPlusRevenueCatPublicKeys,
  type KPlusUnavailableReason,
} from '../../types/kplusCommerceContract';

export interface KPlusCommerceDeps {
  port: KPlusNativeCommercePort;
  /** The authenticated K Scan actor (Supabase user UUID), or null when signed out. */
  getActorId: () => Promise<string | null>;
  publicKeys: () => KPlusRevenueCatPublicKeys;
  allowTestStoreKey: boolean;
  /** Optional future explicit package mapping. This repository supplies none. */
  mapping?: KPlusProductMappingConfig;
  /** Re-reads the CANONICAL entitlement (Supabase). */
  refreshEntitlement: () => Promise<void>;
  /** Does the canonical store currently say K+? */
  isCanonicalKPlusActive: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Bounded delays between canonical re-checks while a purchase is resolving. */
  recheckDelaysMs: readonly number[];
}

export const KPLUS_COMMERCE_RECHECK_DELAYS_MS: readonly number[] = Object.freeze([2_000, 5_000, 10_000, 20_000]);

type Listener = () => void;
type IdentityResult = { state: 'ok' } | { state: 'actor_changed' } | { state: 'failed'; reason: KPlusUnavailableReason };

export interface KPlusCommerceService {
  getSnapshot(): KPlusCommerceSnapshot;
  subscribe(listener: Listener): () => void;
  /** Reads the store's offerings for the current actor (never for an anonymous one). */
  loadOfferings(): Promise<KPlusCommerceSnapshot>;
  purchase(kind: KPlusProductKind): Promise<KPlusPurchaseOutcome>;
  purchaseMonthly(): Promise<KPlusPurchaseOutcome>;
  purchaseLifetime(): Promise<KPlusPurchaseOutcome>;
  /** Explicit user action only. */
  restorePurchases(): Promise<KPlusRestoreOutcome>;
  /** Synchronous. Called on every actor boundary (sign-out, actor change). */
  reset(): void;
}

export function createKPlusCommerceService(deps: KPlusCommerceDeps): KPlusCommerceService {
  const { port } = deps;

  let snapshot: KPlusCommerceSnapshot = INITIAL_KPLUS_COMMERCE_SNAPSHOT;
  const listeners = new Set<Listener>();

  /** Bumped only by reset(). Anything that awaited across it belongs to a previous actor. */
  let generation = 0;
  /** The actor the SDK has been confirmed to be acting as. Null = nobody. */
  let boundActorId: string | null = null;
  let catalogActorId: string | null = null;
  let inFlight: 'purchase' | 'restore' | null = null;
  let unsubscribeProvider: (() => void) | null = null;
  let identityQueue: Promise<unknown> = Promise.resolve();
  let recheckRun = 0;

  function emit() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener must never corrupt the service.
      }
    }
  }

  function setSnapshot(patch: Partial<KPlusCommerceSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    emit();
  }

  function setUnavailable(reason: KPlusUnavailableReason) {
    setSnapshot({ status: 'UNAVAILABLE', unavailableReason: reason, pendingKind: null });
  }

  /** Serialises SDK identity changes so a login can never interleave with a logout. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = identityQueue.then(task, task);
    identityQueue = run.catch(() => undefined);
    return run;
  }

  async function isStillCurrent(gen: number, actorId: string): Promise<boolean> {
    if (gen !== generation) return false;
    let now: string | null;
    try {
      now = await deps.getActorId();
    } catch {
      return false;
    }
    return gen === generation && now === actorId;
  }

  function canonicalIsActive(): boolean {
    try {
      return deps.isCanonicalKPlusActive();
    } catch {
      return false;
    }
  }

  /** The ONLY place a CONFIRMED status is produced: from canonical state. */
  function confirmIfCanonicalActive(gen: number): boolean {
    if (gen !== generation || !canonicalIsActive()) return false;
    setSnapshot({ status: 'ENTITLEMENT_CONFIRMED', unavailableReason: null });
    return true;
  }

  function isResolvingStatus(): boolean {
    return snapshot.status === 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING'
      || snapshot.status === 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING';
  }

  /** CustomerInfo updates may only ever cause a canonical re-read. */
  function ensureProviderListener(gen: number) {
    if (unsubscribeProvider) return;
    unsubscribeProvider = port.subscribeToProviderUpdates((update) => {
      if (gen !== generation || update.appUserId !== boundActorId) return;
      void (async () => {
        try {
          await deps.refreshEntitlement();
        } catch {
          return;
        }
        if (isResolvingStatus()) confirmIfCanonicalActive(gen);
      })();
    });
  }

  function ensureIdentity(actorId: string, apiKey: string, gen: number): Promise<IdentityResult> {
    return enqueue<IdentityResult>(async () => {
      if (gen !== generation) return { state: 'actor_changed' };
      try {
        if (!port.isConfigured()) {
          port.configure(apiKey, actorId);
        } else if (boundActorId !== actorId) {
          await port.logIn(actorId);
        }
        const sdkActor = await port.getAppUserId();
        if (gen !== generation) return { state: 'actor_changed' };
        // The SDK must be acting as exactly this actor. Anything else -- an
        // anonymous id included -- is not a customer this app may sell to.
        if (sdkActor !== actorId) return { state: 'failed', reason: 'IDENTITY_FAILED' };
        boundActorId = actorId;
        ensureProviderListener(gen);
        return { state: 'ok' };
      } catch {
        return gen !== generation ? { state: 'actor_changed' } : { state: 'failed', reason: 'IDENTITY_FAILED' };
      }
    });
  }

  type Prepared =
    | { state: 'ok'; gen: number; actorId: string }
    | { state: 'discarded' }
    | { state: 'unavailable'; reason: KPlusUnavailableReason };

  async function prepare(): Promise<Prepared> {
    const gen = generation;
    let actorId: string | null;
    try {
      actorId = await deps.getActorId();
    } catch {
      actorId = null;
    }
    if (gen !== generation) return { state: 'discarded' };
    if (!actorId) return { state: 'unavailable', reason: 'NOT_AUTHENTICATED' };

    if (!port.runtimeStatus().supported) return { state: 'unavailable', reason: 'UNSUPPORTED_RUNTIME' };
    const config = resolveKPlusRevenueCatConfig(port.platform(), deps.publicKeys(), {
      allowTestStoreKey: deps.allowTestStoreKey,
    });
    if (config.status !== 'configured') return { state: 'unavailable', reason: 'NOT_CONFIGURED' };

    if (boundActorId !== actorId) setSnapshot({ status: 'CONFIGURING', unavailableReason: null });
    const identity = await ensureIdentity(actorId, config.apiKey, gen);
    if (identity.state === 'actor_changed') return { state: 'discarded' };
    if (identity.state === 'failed') return { state: 'unavailable', reason: identity.reason };
    return { state: 'ok', gen, actorId };
  }

  /** The store's answer for the Monthly intro offer. Anything short of a clean
   *  answer is 'UNKNOWN', which never produces trial copy. */
  async function readMonthlyIntroEligibility(catalog: KPlusProductCatalog): Promise<KPlusIntroEligibility> {
    const monthly = catalog.monthly;
    if (monthly.status !== 'available' || !monthly.product.introOffer) return 'NO_INTRO_OFFER';
    if (typeof port.checkIntroEligibility !== 'function') return 'UNKNOWN';
    try {
      const answer = await port.checkIntroEligibility(monthly.product.storeProductIdentifier);
      return answer === 'ELIGIBLE' || answer === 'INELIGIBLE' || answer === 'NO_INTRO_OFFER' ? answer : 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }

  async function fetchCatalog(prepared: { gen: number; actorId: string }): Promise<
    | { state: 'ok'; catalog: KPlusProductCatalog; eligibility: KPlusIntroEligibility }
    | { state: 'discarded' }
    | { state: 'unavailable'; reason: KPlusUnavailableReason }
  > {
    let raw;
    try {
      raw = await port.getOfferings();
    } catch {
      return prepared.gen !== generation
        ? { state: 'discarded' }
        : { state: 'unavailable', reason: 'OFFERINGS_FAILED' };
    }
    if (!(await isStillCurrent(prepared.gen, prepared.actorId))) return { state: 'discarded' };
    const catalog = normalizeKPlusOfferings(raw, deps.mapping);
    const eligibility = await readMonthlyIntroEligibility(catalog);
    if (!(await isStillCurrent(prepared.gen, prepared.actorId))) return { state: 'discarded' };
    catalogActorId = prepared.actorId;
    return { state: 'ok', catalog, eligibility };
  }

  async function loadOfferings(): Promise<KPlusCommerceSnapshot> {
    const prepared = await prepare();
    if (prepared.state === 'discarded') return snapshot;
    if (prepared.state === 'unavailable') {
      setUnavailable(prepared.reason);
      return snapshot;
    }
    const result = await fetchCatalog(prepared);
    if (result.state === 'discarded') return snapshot;
    if (result.state === 'unavailable') {
      setUnavailable(result.reason);
      return snapshot;
    }
    // Do not clobber a purchase / restore that is mid-flight or resolving.
    if (inFlight === null && !isResolvingStatus() && snapshot.status !== 'ENTITLEMENT_CONFIRMED') {
      setSnapshot({
        status: 'READY',
        unavailableReason: null,
        catalog: result.catalog,
        pendingKind: null,
        monthlyIntroEligibility: result.eligibility,
      });
    } else {
      setSnapshot({ catalog: result.catalog, monthlyIntroEligibility: result.eligibility });
    }
    return snapshot;
  }

  /** Bounded canonical re-checks while a store result is still resolving. */
  async function recheckCanonical(gen: number): Promise<void> {
    const run = ++recheckRun;
    for (const delay of deps.recheckDelaysMs) {
      await deps.sleep(delay);
      if (gen !== generation || run !== recheckRun || !isResolvingStatus()) return;
      try {
        await deps.refreshEntitlement();
      } catch {
        continue;
      }
      if (gen !== generation || run !== recheckRun) return;
      if (confirmIfCanonicalActive(gen)) return;
    }
  }

  async function settleAfterProviderSuccess(
    gen: number,
    actorId: string,
    resolvingStatus: 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING' | 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' | 'NOTHING_RESTORED',
  ): Promise<'DISCARDED' | 'CONFIRMED' | 'RESOLVING'> {
    // The provider said yes. That is NOT access: record "resolving", then ask
    // the canonical authority.
    setSnapshot({ status: resolvingStatus, unavailableReason: null });
    try {
      await deps.refreshEntitlement();
    } catch {
      // The re-read failing leaves the answer unresolved, never free.
    }
    if (!(await isStillCurrent(gen, actorId))) return 'DISCARDED';
    if (resolvingStatus === 'NOTHING_RESTORED') return 'RESOLVING';
    if (confirmIfCanonicalActive(gen)) return 'CONFIRMED';
    void recheckCanonical(gen);
    return 'RESOLVING';
  }

  async function purchase(kind: KPlusProductKind): Promise<KPlusPurchaseOutcome> {
    if (inFlight !== null) return { outcome: 'BUSY' };
    inFlight = 'purchase';
    const startGen = generation;
    try {
      const prepared = await prepare();
      if (prepared.state === 'discarded') return { outcome: 'DISCARDED_ACTOR_CHANGED' };
      if (prepared.state === 'unavailable') {
        setUnavailable(prepared.reason);
        return { outcome: 'UNAVAILABLE', reason: prepared.reason };
      }
      const { gen, actorId } = prepared;

      let catalog = catalogActorId === actorId ? snapshot.catalog : null;
      if (!catalog) {
        const fetched = await fetchCatalog(prepared);
        if (fetched.state === 'discarded') return { outcome: 'DISCARDED_ACTOR_CHANGED' };
        if (fetched.state === 'unavailable') {
          setUnavailable(fetched.reason);
          return { outcome: 'UNAVAILABLE', reason: fetched.reason };
        }
        catalog = fetched.catalog;
        setSnapshot({
          status: 'READY',
          unavailableReason: null,
          catalog,
          pendingKind: null,
          monthlyIntroEligibility: fetched.eligibility,
        });
      }

      const entry = kind === 'MONTHLY' ? catalog.monthly : catalog.lifetime;
      if (entry.status !== 'available') {
        return { outcome: 'PRODUCT_UNAVAILABLE', kind, availability: entry };
      }

      // Last gate before money moves: the SDK's current customer must BE the actor.
      const sdkActor = await port.getAppUserId();
      if (gen !== generation) return { outcome: 'DISCARDED_ACTOR_CHANGED' };
      if (sdkActor !== actorId || boundActorId !== actorId) {
        setUnavailable('IDENTITY_FAILED');
        return { outcome: 'UNAVAILABLE', reason: 'IDENTITY_FAILED' };
      }

      setSnapshot({ status: 'PURCHASING', unavailableReason: null, pendingKind: kind });
      const result = await port.purchasePackage(entry.product.packageIdentifier);
      if (!(await isStillCurrent(gen, actorId))) return { outcome: 'DISCARDED_ACTOR_CHANGED' };

      if (result.status !== 'ok') {
        if (result.status === 'cancelled') {
          setSnapshot({ status: 'USER_CANCELLED', pendingKind: kind });
          return { outcome: 'USER_CANCELLED' };
        }
        // A store failure says nothing about entitlement: canonical state is untouched.
        setSnapshot({ status: 'STORE_ERROR', pendingKind: kind });
        return { outcome: 'STORE_ERROR', code: result.code, pending: result.status === 'pending' };
      }

      setSnapshot({ pendingKind: kind });
      const settled = await settleAfterProviderSuccess(gen, actorId, 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING');
      if (settled === 'DISCARDED') return { outcome: 'DISCARDED_ACTOR_CHANGED' };
      return settled === 'CONFIRMED' ? { outcome: 'ENTITLEMENT_CONFIRMED' } : { outcome: 'ENTITLEMENT_RESOLVING' };
    } finally {
      if (startGen === generation) inFlight = null;
    }
  }

  async function restorePurchases(): Promise<KPlusRestoreOutcome> {
    if (inFlight !== null) return { outcome: 'BUSY' };
    inFlight = 'restore';
    const startGen = generation;
    try {
      const prepared = await prepare();
      if (prepared.state === 'discarded') return { outcome: 'DISCARDED_ACTOR_CHANGED' };
      if (prepared.state === 'unavailable') {
        setUnavailable(prepared.reason);
        return { outcome: 'UNAVAILABLE', reason: prepared.reason };
      }
      const { gen, actorId } = prepared;

      const sdkActor = await port.getAppUserId();
      if (gen !== generation) return { outcome: 'DISCARDED_ACTOR_CHANGED' };
      if (sdkActor !== actorId || boundActorId !== actorId) {
        setUnavailable('IDENTITY_FAILED');
        return { outcome: 'UNAVAILABLE', reason: 'IDENTITY_FAILED' };
      }

      setSnapshot({ status: 'RESTORING', unavailableReason: null, pendingKind: null });
      const result = await port.restorePurchases();
      if (!(await isStillCurrent(gen, actorId))) return { outcome: 'DISCARDED_ACTOR_CHANGED' };

      if (result.status !== 'ok') {
        setSnapshot({ status: 'STORE_ERROR' });
        return { outcome: 'STORE_ERROR', code: result.code };
      }

      // Provider ownership only decides which MESSAGE is honest. Either way the
      // canonical authority is re-read, and nothing is granted here.
      const settled = await settleAfterProviderSuccess(
        gen,
        actorId,
        result.providerOwnership ? 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' : 'NOTHING_RESTORED',
      );
      if (settled === 'DISCARDED') return { outcome: 'DISCARDED_ACTOR_CHANGED' };
      if (!result.providerOwnership) return { outcome: 'NOTHING_RESTORED' };
      return settled === 'CONFIRMED' ? { outcome: 'ENTITLEMENT_CONFIRMED' } : { outcome: 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' };
    } finally {
      if (startGen === generation) inFlight = null;
    }
  }

  function reset(): void {
    generation += 1;
    recheckRun += 1;
    boundActorId = null;
    catalogActorId = null;
    inFlight = null;
    if (unsubscribeProvider) {
      try {
        unsubscribeProvider();
      } catch {
        // Removing a listener must never block an auth transition.
      }
      unsubscribeProvider = null;
    }
    snapshot = INITIAL_KPLUS_COMMERCE_SNAPSHOT;
    // Detach the SDK from the previous actor, serialised behind any login in flight.
    if (port.isConfigured()) {
      void enqueue(() => port.logOut()).catch(() => undefined);
    }
    emit();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadOfferings,
    purchase,
    purchaseMonthly: () => purchase('MONTHLY'),
    purchaseLifetime: () => purchase('LIFETIME'),
    restorePurchases,
    reset,
  };
}

// ── Production wiring ────────────────────────────────────────────────────────

async function readAuthenticatedActorId(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

function canonicalStoreSaysKPlus(): boolean {
  const state = getKPlusEntitlementClientState();
  return state.status === 'resolved' && state.summary.access === 'k_plus';
}

const kplusCommerce = createKPlusCommerceService({
  port: revenueCatNativePort,
  getActorId: readAuthenticatedActorId,
  publicKeys: readRevenueCatPublicKeysFromEnv,
  allowTestStoreKey: KPLUS_ALLOW_REVENUECAT_TEST_STORE_KEY,
  refreshEntitlement: refreshKPlusEntitlement,
  isCanonicalKPlusActive: canonicalStoreSaysKPlus,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  recheckDelaysMs: KPLUS_COMMERCE_RECHECK_DELAYS_MS,
});

export const getKPlusCommerceSnapshot = kplusCommerce.getSnapshot;
export const subscribeToKPlusCommerce = kplusCommerce.subscribe;
export const loadKPlusOfferings = kplusCommerce.loadOfferings;
export const purchaseKPlusMonthly = kplusCommerce.purchaseMonthly;
export const purchaseKPlusLifetime = kplusCommerce.purchaseLifetime;
export const restoreKPlusPurchases = kplusCommerce.restorePurchases;
/** Wired into resetActorScopedRuntimeState (contexts/AuthSessionContext.tsx). */
export const resetKPlusCommerce = kplusCommerce.reset;
