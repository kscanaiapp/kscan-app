/**
 * Which K+ surface a gate opens for an actor who does not hold K+.
 *
 * There are two, and they are not interchangeable:
 *
 *   'membership'    the paid K+ membership surface -- the same model, store
 *                   products, trial metadata, Restore and canonical-entitlement
 *                   handling as Welcome Step 6 (components/kplus/
 *                   KPlusMembershipStep.tsx), presented after onboarding by
 *                   components/kplus/KPlusMembershipSheet.tsx.
 *   'early_access'  the Build 34 complimentary Early Access status/activation
 *                   sheet (components/kplus/KPlusEarlyAccessSheet.tsx).
 *
 * WHY THIS IS A CLOSED, PER-SOURCE DECISION. Every K+ gate used to open the
 * Early Access sheet. Once Step 6 began selling Monthly and Lifetime, a gate
 * that still opened that sheet offered a Free actor something different from
 * what onboarding had just offered them. Each gate moves to the membership
 * surface deliberately, by acquiring an entry below -- not by a global switch,
 * which would change four other features' acquisition path in a change that was
 * about one. Virtual Try-On is the first.
 *
 * This decides WHICH SURFACE OPENS and nothing else. It carries no price, no
 * product, no trial and no entitlement rule: the membership surface reads all
 * of those from the existing K+ commerce authority, and who holds K+ is still
 * answered only by the canonical entitlement summary.
 */

import type { KPlusSource } from '../../types/kplusSource';

export type KPlusAcquisitionSurface = 'membership' | 'early_access';

/** Sources whose gate opens the paid membership surface. */
export const KPLUS_MEMBERSHIP_ACQUISITION_SOURCES: readonly KPlusSource[] = Object.freeze(['vto']);

export function resolveKPlusAcquisitionSurface(source: KPlusSource): KPlusAcquisitionSurface {
  return KPLUS_MEMBERSHIP_ACQUISITION_SOURCES.includes(source) ? 'membership' : 'early_access';
}
