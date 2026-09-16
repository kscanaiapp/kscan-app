/**
 * The K+ activation catalog: what the activation screen is allowed to claim.
 *
 * Two separate questions, deliberately kept apart:
 *
 *   1. WHICH CAPABILITIES ARE K+ AT ALL.  `KPLUS_ACTIVATION_CAPABILITIES` is
 *      the closed, approved list. It is exactly four entries. Signature Style,
 *      Scanner, Shopping, Closet, Elise, and Dressing Rooms are CORE/FREE and
 *      may never appear here -- __tests__/kplusCoreFreeBoundary.test.js pins
 *      the same boundary from the gate side. Smart Watchlist is a K+ surface
 *      elsewhere but is deliberately NOT part of the signup activation offer.
 *
 *   2. WHICH OF THEM THIS BUILD ACTUALLY SHIPS.  Each capability is behind its
 *      own build flag, each defaulting off. A build compiled without VTO does
 *      not get to promise VTO on the signup screen just because VTO is on the
 *      approved list. `resolveActivationCapabilities` filters the catalog by
 *      what is really compiled in, so the screen can only ever advertise a
 *      capability the user can actually reach after activating.
 *
 * This is presentation only. Nothing here grants, extends, or checks an
 * entitlement -- the server owns that (services/kplus/kplusClient.ts).
 */

import {
  ELISE_CONCIERGE_V1,
  PACKING_INTELLIGENCE_V1,
  VOICESCAN_ENABLED,
  VTO_UI_ENABLED,
} from '../../constants/featureFlags';

/** Bounded capability ids for the activation screen (presentation keys, not
 *  entitlement keys -- the single entitlement is 'k_plus'). */
export type KPlusActivationCapabilityId =
  | 'voice_scan'
  | 'virtual_try_on'
  | 'wardrobe_concierge'
  | 'packing_intelligence';

export interface KPlusActivationCapability {
  id: KPlusActivationCapabilityId;
  title: string;
  /** One line. Must describe what the SHIPPING implementation does. */
  description: string;
  /** Decorative glyph; the card carries the real accessible name. */
  glyph: string;
  /** True when this build actually compiled the capability in. */
  available: boolean;
}

/**
 * The approved four. Copy is bounded by what Build 34 actually does:
 *   - Voice Scan speaks a search instead of typing one. It is not an
 *     assistant and does not act on the user's behalf.
 *   - Virtual Try-On visualizes a selected garment. It makes no claim about
 *     fit, sizing accuracy, or photorealism.
 *   - Wardrobe Concierge conditions Elise's recommendations on owned items.
 *     It does not shop, buy, or act autonomously.
 *   - Packing Intelligence plans a trip from the user's Closet. It is not a
 *     generic checklist and does not book anything.
 */
export const KPLUS_ACTIVATION_CAPABILITIES: ReadonlyArray<
  Omit<KPlusActivationCapability, 'available'>
> = Object.freeze([
  Object.freeze({
    id: 'voice_scan' as const,
    title: 'Voice Scan',
    description: 'Hands-free search for what you love.',
    glyph: '◉',
  }),
  Object.freeze({
    id: 'virtual_try_on' as const,
    title: 'Virtual Try-On',
    description: 'Visualize selected styles on you.',
    glyph: '◇',
  }),
  Object.freeze({
    id: 'wardrobe_concierge' as const,
    title: 'Wardrobe Concierge',
    description: 'Deeper recommendations from what you own.',
    glyph: '❖',
  }),
  Object.freeze({
    id: 'packing_intelligence' as const,
    title: 'Packing Intelligence',
    description: 'Smarter trip planning from your Closet.',
    glyph: '▣',
  }),
]);

/** Build-flag answer per approved capability. Kept as a function of injected
 *  flags so tests can exercise every combination without re-importing the
 *  module under a mutated environment. */
export function resolveActivationCapabilities(
  flags: {
    voiceScan?: boolean;
    vto?: boolean;
    concierge?: boolean;
    packing?: boolean;
  } = {},
): KPlusActivationCapability[] {
  const {
    voiceScan = VOICESCAN_ENABLED,
    vto = VTO_UI_ENABLED,
    concierge = ELISE_CONCIERGE_V1,
    packing = PACKING_INTELLIGENCE_V1,
  } = flags;

  const availability: Record<KPlusActivationCapabilityId, boolean> = {
    voice_scan: voiceScan,
    virtual_try_on: vto,
    wardrobe_concierge: concierge,
    packing_intelligence: packing,
  };

  return KPLUS_ACTIVATION_CAPABILITIES
    .map((capability) => ({ ...capability, available: availability[capability.id] }))
    .filter((capability) => capability.available);
}

/**
 * The core experience that stays available whether or not K+ is activated.
 *
 * Declining K+ must never read as losing K Scan AI, so the screen names what
 * Free actually keeps. Every entry here is a CORE surface with no K+ gate on
 * it (see __tests__/kplusCoreFreeBoundary.test.js). Signature Style belongs
 * on THIS list and never on the capability list above.
 */
export const KSCAN_FREE_CORE_CAPABILITIES: ReadonlyArray<string> = Object.freeze([
  'Scanner',
  'Shopping',
  'Closet',
  'Signature Style',
  'Elise',
  'Dressing Rooms',
]);

export const KPLUS_FREE_REASSURANCE =
  "You'll still have access to the core K Scan AI Free experience — always.";
