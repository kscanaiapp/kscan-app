/**
 * RevenueCat hosted Paywalls V2 bridge -- commercial presentation only.
 *
 * RevenueCat controls the native product selection/checkout UI. Its purchase
 * and restore results are provider facts, NEVER K+ entitlement facts; callers
 * must recheck Supabase's get_my_kplus_entitlement_summary().
 *
 * Do not use presentPaywallIfNeeded(): RevenueCat does not know about
 * K Scan's canonical complimentary membership grants.
 */
import { NativeModules, Platform } from 'react-native';

export type HostedKPlusOutcome =
  | 'dismissed' | 'purchased' | 'restored' | 'unavailable';

export function isHostedKPlusPaywallAvailable(): boolean {
  return (Platform.OS === 'ios' || Platform.OS === 'android')
    && Boolean(NativeModules.RNPurchases && NativeModules.RNPaywalls);
}

export function mapHostedPaywallResult(result: string): HostedKPlusOutcome {
  if (result === 'PURCHASED') return 'purchased';
  if (result === 'RESTORED') return 'restored';
  if (result === 'CANCELLED') return 'dismissed';
  return 'unavailable';
}

/**
 * Only the K+ commerce service configures Purchases and binds the Supabase UUID
 * as RevenueCat appUserID. This bridge refuses to configure or change identity.
 */
export async function presentHostedKPlusPaywall(actorId: string): Promise<HostedKPlusOutcome> {
  if (!actorId || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return 'unavailable';
  if (!isHostedKPlusPaywallAvailable()) return 'unavailable';

  try {
    // Import only after checking native linkage. Expo Go / previous signed
    // binaries must still render a truthful Free-and-retry fallback.
    const [{ default: Purchases }, { default: RevenueCatUI }] = await Promise.all([
      import('react-native-purchases'),
      import('react-native-purchases-ui'),
    ]);
    if (await Purchases.getAppUserID() !== actorId) return 'unavailable';
    const offerings = await Purchases.getOfferings();
    // Offer identity is a published RevenueCat configuration, not an app price.
    if (!offerings.current || offerings.current.identifier !== 'default'
      || offerings.current.availablePackages.length === 0) return 'unavailable';
    const result = await RevenueCatUI.presentPaywall({
      offering: offerings.current,
      displayCloseButton: true,
    });
    // An SDK callback can arrive after logout/account switch.
    if (await Purchases.getAppUserID() !== actorId) return 'unavailable';
    return mapHostedPaywallResult(result);
  } catch {
    // No credential, receipt, entitlement or provider error in logs.
    return 'unavailable';
  }
}
