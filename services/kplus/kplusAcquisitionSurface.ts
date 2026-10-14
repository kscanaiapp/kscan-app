/**
 * All authenticated K+ acquisition routes now share the paid RevenueCat
 * membership surface. Complimentary grants are evaluated by the canonical
 * entitlement reader; they are NOT acquired through a client Early Access UI.
 * Retained source taxonomy is bounded for telemetry only.
 */
import type { KPlusSource } from '../../types/kplusSource';

export type KPlusAcquisitionSurface = 'membership';

export const KPLUS_MEMBERSHIP_ACQUISITION_SOURCES: readonly KPlusSource[] = Object.freeze([
  'vto', 'packing', 'watchlist', 'closet_intelligence',
  'voice_scan', 'onboarding', 'account', 'wardrobe_concierge', 'unknown',
]);

export function resolveKPlusAcquisitionSurface(_source: KPlusSource): KPlusAcquisitionSurface {
  return 'membership';
}
