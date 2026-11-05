/**
 * K Scan AI -- K+ native commerce contract (Build 35 Phase B).
 *
 * Types and PURE policy only: no React Native, no SDK, no network, no env
 * reads. The commerce service (services/kplus/kplusCommerceService.ts) and the
 * RevenueCat adapter (services/kplus/revenueCatNative.ts) are built on it, and
 * the tests exercise it directly.
 *
 * Authority model:
 *
 *   APPLE / GOOGLE STORE -> REVENUECAT -> VERIFIED PROVIDER LIFECYCLE (Phase C)
 *     -> SUPABASE CANONICAL K+ AUTHORITY -> mobile canonical entitlement reader
 *
 * Nothing in this file -- and nothing built on it -- decides whether an actor
 * has K+. A completed purchase, a completed restore and a CustomerInfo update
 * are PROVIDER facts that only ever cause a canonical re-read. The words
 * "active" / "free" appear here only as the canonical store reports them.
 *
 * Nothing here may name a price, a currency, a trial length or a store product
 * identifier. Every one of those is read from the store through RevenueCat at
 * run time. If a product is missing or ambiguous the answer is a truthful
 * "unavailable" / "configuration error", never a substitute.
 */

// ── Commerce state machine ───────────────────────────────────────────────────

export const KPLUS_COMMERCE_STATUSES = [
  'IDLE',
  'CONFIGURING',
  'READY',
  'PURCHASING',
  'RESTORING',
  'USER_CANCELLED',
  'STORE_ERROR',
  /** A store purchase completed. Canonical authority has not (yet) said K+. NOT free, NOT active. */
  'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING',
  /** A restore completed. Canonical authority has not (yet) said K+. NOT free, NOT active. */
  'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING',
  'NOTHING_RESTORED',
  /** Canonical authority (Supabase, via the entitlement store) says K+. Never set from provider state. */
  'ENTITLEMENT_CONFIRMED',
  'UNAVAILABLE',
] as const;
export type KPlusCommerceStatus = (typeof KPLUS_COMMERCE_STATUSES)[number];

export const KPLUS_UNAVAILABLE_REASONS = [
  /** No authenticated K Scan actor. Purchasing is never offered anonymously. */
  'NOT_AUTHENTICATED',
  /** The platform public SDK key is absent, malformed or not a public key. */
  'NOT_CONFIGURED',
  /** Web, Expo Go, or a build without the native purchases module. */
  'UNSUPPORTED_RUNTIME',
  /** The SDK could not be configured / logged in as this actor. */
  'IDENTITY_FAILED',
  /** Offerings could not be fetched from RevenueCat. */
  'OFFERINGS_FAILED',
] as const;
export type KPlusUnavailableReason = (typeof KPLUS_UNAVAILABLE_REASONS)[number];

// ── Failure diagnostics (privacy-safe) ───────────────────────────────────────
//
// The consumer screen deliberately says one thing ("Membership options couldn't
// load") for several different failures. This is the SEPARATE, bounded record that
// tells an operator which one it was, via logcat. Every field is an enum-like token
// or a RevenueCat numeric error code -- never a message, id, email, receipt,
// purchase token or raw provider object, and nothing here reaches the UI.

export const KPLUS_DIAGNOSTIC_STAGES = ['RUNTIME', 'CONFIG', 'IDENTITY', 'OFFERINGS', 'CATALOG', 'RECONCILE'] as const;
export type KPlusDiagnosticStage = (typeof KPLUS_DIAGNOSTIC_STAGES)[number];

export interface KPlusCommerceDiagnostic {
  stage: KPlusDiagnosticStage;
  /** The service's own unavailable reason, CATALOG_EMPTY when offerings loaded but neither
   *  plan is offerable, or RECONCILE_FAILED when server reconciliation did not succeed. */
  reason: KPlusUnavailableReason | 'CATALOG_EMPTY' | 'RECONCILE_FAILED';
  /** RevenueCat PURCHASES_ERROR_CODE as digits (e.g. "23"), or null. */
  sdkCode: string | null;
  /** RevenueCat PURCHASES_ERROR_CODE name (e.g. CONFIGURATION_ERROR), or null. */
  sdkName: string | null;
  /** A bounded UPPER_SNAKE token (e.g. MONTHLY_MISSING_FROM_OFFERING), or null. Never free text. */
  detail: string | null;
}

const DIAGNOSTIC_TOKEN = /^[A-Z][A-Z0-9_]{0,47}$/;
const DIAGNOSTIC_CODE = /^[0-9]{1,4}$/;

function boundedToken(value: unknown): string | null {
  return typeof value === 'string' && DIAGNOSTIC_TOKEN.test(value) ? value : null;
}

function boundedCode(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  return typeof text === 'string' && DIAGNOSTIC_CODE.test(text) ? text : null;
}

/** Reads ONLY the numeric code / enum name from an SDK error. Never its message. */
export function kplusSdkErrorFields(error: unknown): { sdkCode: string | null; sdkName: string | null } {
  const e = (error ?? null) as { kplusSdkCode?: unknown; kplusSdkName?: unknown; code?: unknown } | null;
  if (!e || typeof e !== 'object') return { sdkCode: null, sdkName: null };
  return { sdkCode: boundedCode(e.kplusSdkCode ?? e.code), sdkName: boundedToken(e.kplusSdkName) };
}

/** Returns a copy holding only allowlisted, bounded fields, or null when the stage/reason is not known. */
export function sanitizeKPlusDiagnostic(input: unknown): KPlusCommerceDiagnostic | null {
  const d = (input ?? null) as Partial<Record<keyof KPlusCommerceDiagnostic, unknown>> | null;
  if (!d || typeof d !== 'object') return null;
  if (!(KPLUS_DIAGNOSTIC_STAGES as readonly string[]).includes(d.stage as string)) return null;
  if (d.reason !== 'CATALOG_EMPTY' && d.reason !== 'RECONCILE_FAILED'
    && !(KPLUS_UNAVAILABLE_REASONS as readonly string[]).includes(d.reason as string)) return null;
  return {
    stage: d.stage as KPlusDiagnosticStage,
    reason: d.reason as KPlusCommerceDiagnostic['reason'],
    sdkCode: boundedCode(d.sdkCode),
    sdkName: boundedToken(d.sdkName),
    detail: boundedToken(d.detail),
  };
}

// ── Store-failure cause (consumer copy only) ─────────────────────────────────
//
// A bounded answer to "which kind of store failure was it", derived from the
// RevenueCat error NAME only. It changes which honest sentence the unavailable
// screen shows; it never changes access or retry policy.

export type KPlusUnavailableCause = 'STORE_ACCOUNT_UNAVAILABLE' | 'NETWORK' | 'STORE_CONFIGURATION';

export function kplusUnavailableCauseFromSdkName(name: string | null | undefined): KPlusUnavailableCause | null {
  switch (name) {
    // Play: no signed-in account / billing unavailable (the B41 emulator); App Store: purchases disallowed.
    case 'PURCHASE_NOT_ALLOWED_ERROR':
      return 'STORE_ACCOUNT_UNAVAILABLE';
    case 'NETWORK_ERROR':
    case 'OFFLINE_CONNECTION_ERROR':
      return 'NETWORK';
    case 'CONFIGURATION_ERROR':
      return 'STORE_CONFIGURATION';
    default:
      return null;
  }
}

// ── Server pull-reconciliation outcome ───────────────────────────────────────
//
// kplus-revenuecat-pull-reconcile answers with an HTTP status and a small JSON
// body. supabase.functions.invoke() never throws for a non-2xx answer, so every
// caller must classify the answer explicitly -- otherwise a 503, 429, 401 or 409
// silently reads as success. The outcome is never an access decision.

export type KPlusReconcileOutcome =
  /** The server applied at least one provider transition. */
  | 'RESOLVED'
  /** The server checked the provider and had nothing to apply. */
  | 'NO_CHANGE'
  /** Cooldown or an in-flight reconciliation: try again after retryAfterSeconds. */
  | 'RATE_LIMITED'
  /** The store purchase is bound to a different K Scan account. Never transferred automatically. */
  | 'OWNERSHIP_CONFLICT'
  /** Provider or canonical write temporarily unavailable. */
  | 'PROVIDER_UNAVAILABLE'
  /** The environment has no reconciliation configured. */
  | 'NOT_CONFIGURED'
  /** No usable session; nothing was sent. */
  | 'UNAUTHENTICATED'
  /** Anonymous / inactive account. */
  | 'NOT_ELIGIBLE'
  /** The request never reached the function. */
  | 'NETWORK'
  | 'UNKNOWN';

export interface KPlusReconcileResult {
  outcome: KPlusReconcileOutcome;
  /** Bounded server hint for RATE_LIMITED, else null. */
  retryAfterSeconds: number | null;
}

function boundedRetryAfter(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 86_400 ? value : null;
}

/** Pure classification of one pull-reconcile answer. `httpStatus` null = transport failure. */
export function classifyKPlusReconcileResponse(httpStatus: number | null, body: unknown): KPlusReconcileResult {
  const b = (body && typeof body === 'object' ? body : {}) as {
    status?: unknown; retryAfterSeconds?: unknown; transitions?: { applied?: unknown } | null;
  };
  const status = typeof b.status === 'string' ? b.status : null;
  const result = (outcome: KPlusReconcileOutcome, retryAfterSeconds: number | null = null): KPlusReconcileResult => ({ outcome, retryAfterSeconds });
  if (httpStatus === null) return result('NETWORK');
  if (httpStatus === 200) {
    if (status !== 'reconciled') return result('UNKNOWN');
    const applied = b.transitions && typeof b.transitions.applied === 'number' ? b.transitions.applied : 0;
    return result(applied > 0 ? 'RESOLVED' : 'NO_CHANGE');
  }
  if (httpStatus === 409 || status === 'ownership_conflict') return result('OWNERSHIP_CONFLICT');
  if (httpStatus === 429) {
    return status === 'rate_limited'
      ? result('RATE_LIMITED', boundedRetryAfter(b.retryAfterSeconds))
      : result('PROVIDER_UNAVAILABLE');
  }
  if (httpStatus === 503 && status === 'not_configured') return result('NOT_CONFIGURED');
  if (httpStatus === 502 || httpStatus === 503) return result('PROVIDER_UNAVAILABLE');
  if (httpStatus === 401) return result('UNAUTHENTICATED');
  if (httpStatus === 403) return result('NOT_ELIGIBLE');
  return result('UNKNOWN');
}

export type KPlusProductKind = 'MONTHLY' | 'ANNUAL' | 'LIFETIME';

// ── Normalized store product ─────────────────────────────────────────────────

/**
 * Intro / trial metadata exactly as the store reports it. PRESENCE IS NOT
 * ELIGIBILITY: whether this actor may still redeem it is a store decision this
 * phase does not ask. A future surface must not claim "free trial" from this
 * field alone.
 */
export interface KPlusIntroOffer {
  localizedPrice: string;
  priceAmount: number;
  /** ISO 8601 period of one cycle, as the store reports it. */
  period: string;
  periodUnit: string;
  periodNumberOfUnits: number;
  cycles: number;
  isFreeIntro: boolean;
}

/** Store/provider-derived facts only. No field is ever filled from this repo. */
export interface KPlusStoreProduct {
  kind: KPlusProductKind;
  /** RevenueCat package identifier (from the active offering). */
  packageIdentifier: string;
  /** Store product identifier, as RevenueCat reports it. */
  storeProductIdentifier: string;
  /** Store-localized display price (already formatted by the store). */
  localizedPrice: string;
  priceAmount: number;
  /** ISO 4217 code when the store reports one; null otherwise. */
  currencyCode: string | null;
  /** ISO 8601 billing period. Always null for LIFETIME. */
  subscriptionPeriod: string | null;
  introOffer: KPlusIntroOffer | null;
}

export type KPlusProductAvailability =
  | { status: 'available'; product: KPlusStoreProduct }
  /** The active offering has no package of this kind. Never substituted. */
  | { status: 'unavailable'; reason: 'MISSING_FROM_OFFERING' }
  /** The mapping cannot be decided (two candidates, a malformed product, a
   *  package claimed by both kinds). Fail closed; never guess. */
  | { status: 'configuration_error'; reason: 'AMBIGUOUS_MAPPING' | 'MALFORMED_PRODUCT' };

export interface KPlusProductCatalog {
  offeringIdentifier: string | null;
  monthly: KPlusProductAvailability;
  annual: KPlusProductAvailability;
  lifetime: KPlusProductAvailability;
}

export const EMPTY_KPLUS_CATALOG_NO_OFFERING: KPlusProductCatalog = Object.freeze({
  offeringIdentifier: null,
  monthly: Object.freeze({ status: 'unavailable', reason: 'MISSING_FROM_OFFERING' }) as KPlusProductAvailability,
  annual: Object.freeze({ status: 'unavailable', reason: 'MISSING_FROM_OFFERING' }) as KPlusProductAvailability,
  lifetime: Object.freeze({ status: 'unavailable', reason: 'MISSING_FROM_OFFERING' }) as KPlusProductAvailability,
});

/**
 * OPTIONAL typed boundary for a future explicit mapping. This repository
 * supplies NO values: product identities are derived from the active offering's
 * package types. When an owner pins package identifiers, they are passed in
 * here, never hard-coded in the normalizer.
 */
export interface KPlusProductMappingConfig {
  monthlyPackageIdentifier?: string;
  annualPackageIdentifier?: string;
  lifetimePackageIdentifier?: string;
}

// ── Structural view of the RevenueCat offerings the normalizer reads ─────────
// (react-native-purchases' real types are assignable to these.)

export interface RawIntroPrice {
  price: number;
  priceString: string;
  cycles: number;
  period: string;
  periodUnit: string;
  periodNumberOfUnits: number;
}

export interface RawStoreProduct {
  identifier: string;
  price: number;
  priceString: string;
  currencyCode?: string | null;
  subscriptionPeriod?: string | null;
  introPrice?: RawIntroPrice | null;
  defaultOption?: {
    freePhase?: { billingPeriod: { iso8601: string; unit: string; value: number }; billingCycleCount: number; price: { amountMicros: number; formatted: string } } | null;
    fullPricePhase?: { billingPeriod: { iso8601: string }; price: { amountMicros: number; formatted: string; currencyCode: string } } | null;
  } | null;
}

export interface RawPackage {
  identifier: string;
  packageType: string;
  product: RawStoreProduct;
}

export interface RawOffering {
  identifier: string;
  availablePackages: RawPackage[];
}

export interface RawOfferings {
  current: RawOffering | null;
}

// ── Normalization ────────────────────────────────────────────────────────────

const PACKAGE_TYPE_FOR_KIND: Record<KPlusProductKind, string> = {
  MONTHLY: 'MONTHLY',
  ANNUAL: 'ANNUAL',
  LIFETIME: 'LIFETIME',
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toStoreProduct(kind: KPlusProductKind, pkg: RawPackage): KPlusProductAvailability {
  const p = pkg.product;
  if (
    !nonEmptyString(pkg.identifier)
    || !p
    || !nonEmptyString(p.identifier)
    || !nonEmptyString(p.priceString)
    || typeof p.price !== 'number'
    || !Number.isFinite(p.price)
  ) {
    return { status: 'configuration_error', reason: 'MALFORMED_PRODUCT' };
  }
  const intro = p.introPrice ?? null;
  const introOffer: KPlusIntroOffer | null = intro
    && nonEmptyString(intro.priceString)
    && typeof intro.price === 'number'
    && nonEmptyString(intro.period)
    ? {
        localizedPrice: intro.priceString,
        priceAmount: intro.price,
        period: intro.period,
        periodUnit: intro.periodUnit,
        periodNumberOfUnits: intro.periodNumberOfUnits,
        cycles: intro.cycles,
        isFreeIntro: intro.price === 0,
      }
    : null;
  return {
    status: 'available',
    product: {
      kind,
      packageIdentifier: pkg.identifier,
      storeProductIdentifier: p.identifier,
      localizedPrice: p.priceString,
      priceAmount: p.price,
      currencyCode: nonEmptyString(p.currencyCode) ? p.currencyCode : null,
      // A lifetime purchase has no billing period, whatever the store says.
      subscriptionPeriod: kind !== 'LIFETIME' && nonEmptyString(p.subscriptionPeriod) ? p.subscriptionPeriod : null,
      introOffer: kind !== 'LIFETIME' ? introOffer : null,
    },
  };
}

function resolveKind(
  kind: KPlusProductKind,
  packages: readonly RawPackage[],
  pinnedIdentifier: string | undefined,
): KPlusProductAvailability {
  const candidates = nonEmptyString(pinnedIdentifier)
    ? packages.filter((pkg) => pkg.identifier === pinnedIdentifier)
    : packages.filter((pkg) => pkg.packageType === PACKAGE_TYPE_FOR_KIND[kind]);
  if (candidates.length === 0) return { status: 'unavailable', reason: 'MISSING_FROM_OFFERING' };
  if (candidates.length > 1) return { status: 'configuration_error', reason: 'AMBIGUOUS_MAPPING' };
  return toStoreProduct(kind, candidates[0]);
}

/**
 * Normalizes the ACTIVE (current) RevenueCat offering into the K+ catalog.
 *
 * - Monthly, Annual and dormant Lifetime resolve independently. A missing
 *   product never becomes a different billing cadence.
 * - Two candidates for one kind, or one package claimed by both kinds, is a
 *   configuration error, not a pick.
 * - Every value is copied from the store metadata; nothing is defaulted.
 */
export function normalizeKPlusOfferings(
  offerings: RawOfferings | null | undefined,
  mapping: KPlusProductMappingConfig = {},
): KPlusProductCatalog {
  const offering = offerings?.current ?? null;
  if (!offering || !Array.isArray(offering.availablePackages)) return EMPTY_KPLUS_CATALOG_NO_OFFERING;

  let monthly = resolveKind('MONTHLY', offering.availablePackages, mapping.monthlyPackageIdentifier);
  let annual = resolveKind('ANNUAL', offering.availablePackages, mapping.annualPackageIdentifier);
  let lifetime = resolveKind('LIFETIME', offering.availablePackages, mapping.lifetimePackageIdentifier);

  if (
    monthly.status === 'available'
    && lifetime.status === 'available'
    && monthly.product.packageIdentifier === lifetime.product.packageIdentifier
  ) {
    monthly = { status: 'configuration_error', reason: 'AMBIGUOUS_MAPPING' };
    lifetime = { status: 'configuration_error', reason: 'AMBIGUOUS_MAPPING' };
  }
  if (annual.status === 'available') {
    const annualId = annual.product.packageIdentifier;
    const overlapsMonthly = monthly.status === 'available' && monthly.product.packageIdentifier === annualId;
    const overlapsLifetime = lifetime.status === 'available' && lifetime.product.packageIdentifier === annualId;
    if (overlapsMonthly || overlapsLifetime) {
      annual = { status: 'configuration_error', reason: 'AMBIGUOUS_MAPPING' };
      if (overlapsMonthly) monthly = { status: 'configuration_error', reason: 'AMBIGUOUS_MAPPING' };
      if (overlapsLifetime) lifetime = { status: 'configuration_error', reason: 'AMBIGUOUS_MAPPING' };
    }
  }
  return { offeringIdentifier: offering.identifier ?? null, monthly, annual, lifetime };
}

// ── Public SDK key policy ────────────────────────────────────────────────────

export type KPlusCommercePlatform = 'ios' | 'android' | 'other';

export interface KPlusRevenueCatPublicKeys {
  ios?: string | null;
  android?: string | null;
}

export type KPlusRevenueCatConfigResult =
  | { status: 'configured'; apiKey: string }
  | {
      status: 'not_configured';
      reason: 'UNSUPPORTED_PLATFORM' | 'MISSING_KEY' | 'SECRET_KEY_REJECTED' | 'MALFORMED_KEY' | 'TEST_KEY_IN_RELEASE';
    };

const PUBLIC_KEY_PREFIX: Record<'ios' | 'android', string> = { ios: 'appl_', android: 'goog_' };

/**
 * Resolves the PUBLIC SDK key for this platform.
 *
 * Fails closed to NOT_CONFIGURED -- never a crash, never a fabricated key:
 *   - a RevenueCat SECRET key ("sk_...") is refused outright. It must never be
 *     in a mobile bundle, whatever variable it was put in;
 *   - the key must carry this platform's public prefix (a key for the other
 *     store would make the native SDK fail at launch);
 *   - a Test Store key ("test_...") is accepted only in a development build.
 */
export function resolveKPlusRevenueCatConfig(
  platform: KPlusCommercePlatform,
  keys: KPlusRevenueCatPublicKeys,
  options: { allowTestStoreKey?: boolean } = {},
): KPlusRevenueCatConfigResult {
  if (platform !== 'ios' && platform !== 'android') {
    return { status: 'not_configured', reason: 'UNSUPPORTED_PLATFORM' };
  }
  const raw = platform === 'ios' ? keys.ios : keys.android;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length === 0) return { status: 'not_configured', reason: 'MISSING_KEY' };
  if (/^sk_/i.test(key)) return { status: 'not_configured', reason: 'SECRET_KEY_REJECTED' };
  if (/^test_/.test(key)) {
    return options.allowTestStoreKey === true
      ? { status: 'configured', apiKey: key }
      : { status: 'not_configured', reason: 'TEST_KEY_IN_RELEASE' };
  }
  if (!key.startsWith(PUBLIC_KEY_PREFIX[platform]) || key.length <= PUBLIC_KEY_PREFIX[platform].length) {
    return { status: 'not_configured', reason: 'MALFORMED_KEY' };
  }
  return { status: 'configured', apiKey: key };
}

// ── Operation results ────────────────────────────────────────────────────────

export type KPlusPurchaseOutcome =
  /** Store purchase completed; canonical authority still resolving. */
  | { outcome: 'ENTITLEMENT_RESOLVING' }
  /** Store purchase completed AND canonical authority now says K+. */
  | { outcome: 'ENTITLEMENT_CONFIRMED' }
  | { outcome: 'USER_CANCELLED' }
  /** `code` is the bounded RevenueCat error code, never a payload. */
  | { outcome: 'STORE_ERROR'; code: string; pending: boolean }
  | { outcome: 'UNAVAILABLE'; reason: KPlusUnavailableReason }
  | { outcome: 'PRODUCT_UNAVAILABLE'; kind: KPlusProductKind; availability: Exclude<KPlusProductAvailability, { status: 'available' }> }
  /** The actor changed while the operation ran: its completion belongs to nobody here. */
  | { outcome: 'DISCARDED_ACTOR_CHANGED' }
  /** Another purchase or restore is already in flight. */
  | { outcome: 'BUSY' };

export type KPlusRestoreOutcome =
  | { outcome: 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' }
  | { outcome: 'ENTITLEMENT_CONFIRMED' }
  | { outcome: 'NOTHING_RESTORED' }
  | { outcome: 'STORE_ERROR'; code: string }
  | { outcome: 'UNAVAILABLE'; reason: KPlusUnavailableReason }
  | { outcome: 'DISCARDED_ACTOR_CHANGED' }
  | { outcome: 'BUSY' };

/**
 * Whether the STORE says this customer can still redeem the Monthly intro
 * offer (Build 35 Phase D). Only 'ELIGIBLE' may ever produce trial copy.
 * 'UNKNOWN' is what RevenueCat returns when it cannot decide -- always on
 * Android, and on iOS when subscription-group data is missing -- and its own
 * guidance is to present the non-intro price in that case.
 */
export type KPlusIntroEligibility = 'ELIGIBLE' | 'INELIGIBLE' | 'NO_INTRO_OFFER' | 'UNKNOWN';

export interface KPlusCommerceSnapshot {
  status: KPlusCommerceStatus;
  unavailableReason: KPlusUnavailableReason | null;
  /** Null until offerings have been read for the current actor. */
  catalog: KPlusProductCatalog | null;
  /** The product kind an in-flight / just-completed purchase concerns. */
  pendingKind: KPlusProductKind | null;
  /** Store-reported Monthly intro eligibility for the current actor's catalog. */
  monthlyIntroEligibility: KPlusIntroEligibility;
  annualIntroEligibility?: KPlusIntroEligibility;
  /** Which kind of store failure produced UNAVAILABLE, when the SDK said so. Copy only. */
  unavailableCause?: KPlusUnavailableCause | null;
  /** The last server reconciliation answer for this actor, or null. Never an access decision. */
  reconciliation?: KPlusReconcileResult | null;
}

export const INITIAL_KPLUS_COMMERCE_SNAPSHOT: KPlusCommerceSnapshot = Object.freeze({
  status: 'IDLE' as KPlusCommerceStatus,
  unavailableReason: null,
  catalog: null,
  pendingKind: null,
  monthlyIntroEligibility: 'UNKNOWN' as KPlusIntroEligibility,
  annualIntroEligibility: 'UNKNOWN' as KPlusIntroEligibility,
  unavailableCause: null,
  reconciliation: null,
});

// ── Native commerce port ─────────────────────────────────────────────────────

export type KPlusRuntimeStatus =
  | { supported: true }
  | { supported: false; reason: 'UNSUPPORTED_PLATFORM' | 'NATIVE_MODULE_MISSING' };

/** A completed provider call, reduced INSIDE the adapter to the one bounded fact
 *  the service may use. Raw receipts, transactions, tokens and CustomerInfo
 *  objects never cross this boundary. */
export type KPlusPortPurchaseResult =
  | { status: 'ok' }
  | { status: 'cancelled' | 'pending' | 'store_error'; code: string };

export type KPlusPortRestoreResult =
  | { status: 'ok'; providerOwnership: boolean }
  | { status: 'error'; code: string };

/**
 * The ONLY surface through which K+ commerce talks to the native SDK. A test
 * substitutes a fake; production uses services/kplus/revenueCatNative.ts.
 */
export interface KPlusNativeCommercePort {
  platform(): KPlusCommercePlatform;
  runtimeStatus(): KPlusRuntimeStatus;
  /** Has THIS port configured the SDK (once per process)? */
  isConfigured(): boolean;
  /** Configures the SDK already identified as `appUserId` (no anonymous customer is created). */
  configure(apiKey: string, appUserId: string): void;
  logIn(appUserId: string): Promise<void>;
  logOut(): Promise<void>;
  /** The id the SDK is currently acting as. */
  getAppUserId(): Promise<string | null>;
  getOfferings(): Promise<RawOfferings>;
  purchasePackage(packageIdentifier: string): Promise<KPlusPortPurchaseResult>;
  restorePurchases(): Promise<KPlusPortRestoreResult>;
  /**
   * Store-reported intro-offer eligibility for one store product. Optional: a
   * port without it is treated as 'UNKNOWN', which never produces trial copy.
   */
  checkIntroEligibility?(storeProductIdentifier: string): Promise<KPlusIntroEligibility>;
  /** Provider-state observation only. The callback gets the customer id, nothing else. */
  subscribeToProviderUpdates(onUpdate: (update: { appUserId: string }) => void): () => void;
}
