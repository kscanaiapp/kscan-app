/**
 * K+ native RevenueCat adapter (Build 35 Phase B).
 *
 * The ONLY module that imports react-native-purchases. UI and services talk to
 * the KPlusNativeCommercePort it implements; no other file calls Purchases.*.
 *
 * What this adapter guarantees:
 *   - The SDK is configured ONCE, already identified as the K Scan actor's
 *     Supabase UUID, so no anonymous RevenueCat customer is created at start-up.
 *   - It sends NO subscriber attributes and disables identifier collection. The
 *     customer id is the only thing RevenueCat learns about the actor.
 *   - Raw provider objects (CustomerInfo, transactions, receipts, purchase
 *     tokens) are reduced to bounded facts HERE and never returned, stored or
 *     logged. Errors are reduced to their RevenueCat error code.
 *   - A runtime without the real native module (Expo Go, web, an unlinked
 *     build) reports itself unsupported. The SDK would otherwise fall back to
 *     a browser/preview mode whose products are not the store's; this adapter
 *     refuses to talk to it.
 */
import { NativeModules, Platform } from 'react-native';
import Purchases, { LOG_LEVEL, PURCHASES_ERROR_CODE } from 'react-native-purchases';
import type {
  KPlusCommercePlatform,
  KPlusIntroEligibility,
  KPlusNativeCommercePort,
  KPlusPortPurchaseResult,
  KPlusPortRestoreResult,
  KPlusRuntimeStatus,
  RawOfferings,
  RawPackage,
} from '../../types/kplusCommerceContract';

type NativePackage = Parameters<typeof Purchases.purchasePackage>[0];

interface ProviderOwnershipView {
  activeSubscriptions?: readonly string[];
  allPurchasedProductIdentifiers?: readonly string[];
  entitlements?: { active?: Record<string, unknown> };
}

/** The bounded fact restore needs: does the provider know of ANY purchase for
 *  this customer. It is never an access decision. */
function hasProviderOwnership(info: ProviderOwnershipView | null | undefined): boolean {
  if (!info) return false;
  return (info.activeSubscriptions?.length ?? 0) > 0
    || (info.allPurchasedProductIdentifiers?.length ?? 0) > 0
    || Object.keys(info.entitlements?.active ?? {}).length > 0;
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : 'UNKNOWN';
}

function isCancelled(error: unknown): boolean {
  const e = error as { code?: unknown; userCancelled?: unknown } | null;
  return errorCodeOf(error) === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR || e?.userCancelled === true;
}

let sdkConfigured = false;
let identityEpoch = 0;
let nativePackages = new Map<string, NativePackage>();

function platformOf(): KPlusCommercePlatform {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'other';
}

export const revenueCatNativePort: KPlusNativeCommercePort = {
  platform: platformOf,

  runtimeStatus(): KPlusRuntimeStatus {
    if (platformOf() === 'other') return { supported: false, reason: 'UNSUPPORTED_PLATFORM' };
    // Expo Go and an unlinked build both lack the real native module.
    if (!(NativeModules as Record<string, unknown>).RNPurchases) {
      return { supported: false, reason: 'NATIVE_MODULE_MISSING' };
    }
    return { supported: true };
  },

  isConfigured: () => sdkConfigured,

  configure(apiKey, appUserId) {
    if (sdkConfigured) return;
    void Purchases.setLogLevel(LOG_LEVEL.ERROR);
    Purchases.configure({
      apiKey,
      appUserID: appUserId,
      automaticDeviceIdentifierCollectionEnabled: false,
    });
    sdkConfigured = true;
  },

  async logIn(appUserId) {
    identityEpoch += 1;
    nativePackages.clear();
    await Purchases.logIn(appUserId);
  },

  async logOut() {
    identityEpoch += 1;
    nativePackages.clear();
    if (!(await Purchases.isAnonymous())) await Purchases.logOut();
  },

  async getAppUserId() {
    try {
      const id = await Purchases.getAppUserID();
      return typeof id === 'string' && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  },

  async getOfferings(): Promise<RawOfferings> {
    const epoch = identityEpoch;
    const offerings = await Purchases.getOfferings();
    if (epoch !== identityEpoch) throw new Error('STALE_COMMERCE_IDENTITY');
    const next = new Map<string, NativePackage>();
    for (const pkg of offerings.current?.availablePackages ?? []) next.set(pkg.identifier, pkg);
    nativePackages = next;
    if (platformOf() === 'android') {
      // defaultOption is the eligible Play offer purchasePackage will select.
      const current = offerings.current;
      return { current: current ? { identifier: current.identifier, availablePackages: current.availablePackages.map(pkg => {
        const option = pkg.product.defaultOption;
        const full = option?.fullPricePhase;
        const free = option?.freePhase;
        const intro = free ?? option?.introPhase;
        return { ...pkg, product: { ...pkg.product,
          price: full ? full.price.amountMicros / 1_000_000 : pkg.product.price,
          priceString: full?.price.formatted ?? pkg.product.priceString,
          subscriptionPeriod: full?.billingPeriod.iso8601 ?? pkg.product.subscriptionPeriod,
          introPrice: intro ? {
            price: intro.price.amountMicros / 1_000_000, priceString: intro.price.formatted, cycles: intro.billingCycleCount,
            period: intro.billingPeriod.iso8601, periodUnit: intro.billingPeriod.unit,
            periodNumberOfUnits: intro.billingPeriod.value,
          } : null,
        } };
      }) } : null } as unknown as RawOfferings;
    }
    return offerings as unknown as RawOfferings & { current: { availablePackages: RawPackage[] } | null };
  },

  async purchasePackage(packageIdentifier): Promise<KPlusPortPurchaseResult> {
    const pkg = nativePackages.get(packageIdentifier);
    if (!pkg) return { status: 'store_error', code: 'PACKAGE_NOT_LOADED' };
    try {
      await Purchases.purchasePackage(pkg);
      return { status: 'ok' };
    } catch (error) {
      if (errorCodeOf(error) === PURCHASES_ERROR_CODE.PRODUCT_ALREADY_PURCHASED_ERROR) return { status: 'ok' };
      if (isCancelled(error)) return { status: 'cancelled', code: errorCodeOf(error) };
      if (errorCodeOf(error) === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) {
        return { status: 'pending', code: errorCodeOf(error) };
      }
      return { status: 'store_error', code: errorCodeOf(error) };
    }
  },

  async restorePurchases(): Promise<KPlusPortRestoreResult> {
    try {
      const info = await Purchases.restorePurchases();
      return { status: 'ok', providerOwnership: hasProviderOwnership(info as unknown as ProviderOwnershipView) };
    } catch (error) {
      return { status: 'error', code: errorCodeOf(error) };
    }
  },

  async checkIntroEligibility(storeProductIdentifier): Promise<KPlusIntroEligibility> {
    if (platformOf() === 'android') {
      const product = [...nativePackages.values()].find(pkg => pkg.product.identifier === storeProductIdentifier)?.product;
      const free = product?.defaultOption?.freePhase;
      return (free && free.price.amountMicros === 0) || product?.defaultOption?.introPhase ? 'ELIGIBLE' : 'NO_INTRO_OFFER';
    }
    // RevenueCat answers UNKNOWN whenever it cannot decide (always on Android),
    // and anything unexpected here is UNKNOWN too. Only the store's explicit
    // ELIGIBLE may ever turn into trial copy.
    try {
      const statuses = Purchases.INTRO_ELIGIBILITY_STATUS;
      const result = await Purchases.checkTrialOrIntroductoryPriceEligibility([storeProductIdentifier]);
      const status = result?.[storeProductIdentifier]?.status;
      if (!statuses || status === undefined) return 'UNKNOWN';
      if (status === statuses.INTRO_ELIGIBILITY_STATUS_ELIGIBLE) return 'ELIGIBLE';
      if (status === statuses.INTRO_ELIGIBILITY_STATUS_INELIGIBLE) return 'INELIGIBLE';
      if (status === statuses.INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS) return 'NO_INTRO_OFFER';
      return 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  },

  subscribeToProviderUpdates(onUpdate) {
    // The CustomerInfo payload is deliberately ignored: an update means only
    // "the SDK's current customer changed". Which customer that is comes from the
    // SDK's own current id, never from the payload.
    const listener = () => {
      void revenueCatNativePort.getAppUserId().then((id) => {
        if (id) onUpdate({ appUserId: id });
      });
    };
    Purchases.addCustomerInfoUpdateListener(listener);
    return () => {
      Purchases.removeCustomerInfoUpdateListener(listener);
    };
  },
};
