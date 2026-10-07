/** The single K+ presentation catalog. Core Scanner, Shopping, local Closet,
 * Signature Style, Elise and Dressing Rooms remain Free. Build flags describe
 * compiled entry points; server records describe known service posture.
 * Packing, Watchlist and Cloud Closet additionally require dated runtime proof
 * scoped to this environment and build. This never grants an entitlement. */

import {
  ELISE_CONCIERGE_V1,
  PACKING_INTELLIGENCE_V1,
  VOICESCAN_ENABLED,
  VTO_UI_ENABLED,
  SMART_WATCHLIST_V1,
  CLOSET_CLOUD_SYNC_V1,
  CLOSET_CROSS_DEVICE_RESTORE_V1,
  CLOSET_LEGACY_MIGRATION_V1,
} from '../../constants/featureFlags';
import { capabilityProofContext, hasRuntimeCapabilityProof, type CapabilityProofContext } from './kplusCapabilityProof';

/** Bounded capability ids for the activation screen (presentation keys, not
 *  entitlement keys -- the single entitlement is 'k_plus'). */
export type KPlusActivationCapabilityId =
  | 'voice_scan'
  | 'virtual_try_on'
  | 'wardrobe_concierge'
  | 'packing_intelligence'
  | 'smart_watchlist'
  | 'cloud_closet';

export interface KPlusActivationCapability {
  id: KPlusActivationCapabilityId;
  title: string;
  /** One line. Must describe what the SHIPPING implementation does. */
  description: string;
  /** Decorative glyph; the card carries the real accessible name. */
  glyph: string;
  /** True when this build compiled the capability in AND the server is known
   *  to serve it (see KPLUS_CAPABILITY_SERVER_ENABLEMENT). */
  available: boolean;
}

/** Approved capabilities. Copy describes the shipped behavior; resolution
 * removes unproven or unavailable capabilities before any benefit is rendered. */
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
    title: 'Try it on with AI',
    description: 'See how an eligible look might work on you before you buy.',
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
  Object.freeze({ id: 'smart_watchlist' as const, title: 'Smart Watchlist',
    description: 'Track eligible products and check price changes.', glyph: '◎' }),
  Object.freeze({ id: 'cloud_closet' as const, title: 'Cloud Closet',
    description: 'Back up your Closet with K+.', glyph: '☁' }),
]);

/** Server posture is necessary but insufficient for premium-value claims.
 * The typed proof projection independently expires Packing, Watchlist and
 * Closet claims. Live VTO and the existing Voice/Concierge rules are preserved. */
export type KPlusServerEnablement = 'confirmed' | 'unconfirmed' | 'live';

/** Answers for the 'live' capabilities. `undefined`/`null` means not known yet. */
export type KPlusLiveSignals = Partial<Record<KPlusActivationCapabilityId, boolean | null>>;

export interface KPlusServerEnablementRecord {
  readonly status: KPlusServerEnablement;
  /** What the status rests on, and when it was observed. Prose for the next owner. */
  readonly basis: string;
}

export const KPLUS_CAPABILITY_SERVER_ENABLEMENT: Readonly<
  Record<KPlusActivationCapabilityId, KPlusServerEnablementRecord>
> = Object.freeze({
  voice_scan: Object.freeze({
    status: 'confirmed' as const,
    basis:
      'Speech recognition runs on the device; the transcript is searched through the same ' +
      'text-search backend every typed search uses, which was live at the 2026-09-24 audit. ' +
      'The voice platform is provisioned on both platforms. Device behaviour is a separate, ' +
      'pending check.',
  }),
  virtual_try_on: Object.freeze({
    status: 'live' as const,
    basis:
      'Advertised only while the remote try-on feature switch reads enabled, which is the ' +
      'same switch every try-on entry point already obeys; unknown fails closed. At the ' +
      '2026-09-24 audit the switch was on and the service deployed, but no generation was run, ' +
      'so the provider credential and plan are unproven.',
  }),
  wardrobe_concierge: Object.freeze({
    status: 'unconfirmed' as const,
    basis:
      'The server-side switches Wardrobe Concierge needs were not enabled at the ' +
      '2026-09-24 read-only audit, so it does nothing for an activated member.',
  }),
  packing_intelligence: Object.freeze({
    status: 'confirmed' as const,
    basis:
      'Staging generation and refinement succeeded on 2026-10-07. Advertising also requires ' +
      'the dated environment-scoped runtime proof; Production has no proof.',
  }),
  smart_watchlist: Object.freeze({ status: 'confirmed' as const,
    basis: 'Staging create, owner read and real price observation succeeded on 2026-10-07. ' +
      'Only tracking is proven; worker behavior and platform push are separate.' }),
  cloud_closet: Object.freeze({ status: 'unconfirmed' as const,
    basis: 'At 2026-10-07, outbound media sync and isolated-client restore remain unproven.' }),
});

/**
 * Which capabilities the screen may advertise: those this build compiled in
 * (build flags) AND that the server is known to serve
 * (KPLUS_CAPABILITY_SERVER_ENABLEMENT, with 'live' entries decided by
 * `liveSignals`) AND governed proof for premium-value capabilities. All inputs
 * are injectable so tests can exercise every
 * combination without re-importing the module under a mutated environment; the
 * catalog remains the single presentation projection.
 */
export function resolveActivationCapabilities(
  flags: {
    voiceScan?: boolean;
    vto?: boolean;
    concierge?: boolean;
    packing?: boolean;
    watchlist?: boolean;
    cloudSync?: boolean;
    cloudRestore?: boolean;
    cloudMigration?: boolean;
  } = {},
  serverEnablement: Readonly<
    Record<KPlusActivationCapabilityId, KPlusServerEnablementRecord>
  > = KPLUS_CAPABILITY_SERVER_ENABLEMENT,
  liveSignals: KPlusLiveSignals = {},
  proofContext: CapabilityProofContext = capabilityProofContext(),
): KPlusActivationCapability[] {
  const {
    voiceScan = VOICESCAN_ENABLED,
    vto = VTO_UI_ENABLED,
    concierge = ELISE_CONCIERGE_V1,
    packing = PACKING_INTELLIGENCE_V1,
    watchlist = SMART_WATCHLIST_V1,
    cloudSync = CLOSET_CLOUD_SYNC_V1,
    cloudRestore = CLOSET_CROSS_DEVICE_RESTORE_V1,
    cloudMigration = CLOSET_LEGACY_MIGRATION_V1,
  } = flags;

  const compiledIn: Record<KPlusActivationCapabilityId, boolean> = {
    voice_scan: voiceScan,
    virtual_try_on: vto,
    wardrobe_concierge: concierge,
    packing_intelligence: packing,
    smart_watchlist: watchlist,
    cloud_closet: cloudSync && cloudRestore && cloudMigration,
  };

  const servedByServer = (id: KPlusActivationCapabilityId): boolean => {
    if (id === 'packing_intelligence' && !hasRuntimeCapabilityProof(id, 'packing_generation_and_refinement', proofContext)) return false;
    if (id === 'smart_watchlist' && !hasRuntimeCapabilityProof(id, 'watch_tracking', proofContext)) return false;
    if (id === 'cloud_closet' && !hasRuntimeCapabilityProof(id, 'closet_outbound_sync', proofContext)) return false;
    const status = serverEnablement[id]?.status;
    if (status === 'confirmed') return true;
    // A 'live' capability is advertised only on an explicit yes. Not read yet,
    // unreadable and off all fail closed.
    if (status === 'live') return liveSignals[id] === true;
    return false;
  };

  return KPLUS_ACTIVATION_CAPABILITIES
    .filter((capability) => compiledIn[capability.id] && servedByServer(capability.id))
    .map((capability) => ({ ...capability, available: true,
      ...(capability.id === 'cloud_closet' && hasRuntimeCapabilityProof('cloud_closet', 'closet_cross_device_restore', proofContext)
        ? { description: 'Back up and restore your Closet across devices.' } : {}),
    }));
}

/**
 * PROMOTION is not AVAILABILITY.
 *
 * `resolveActivationCapabilities` answers "which K+ capabilities can a member
 * actually use here" -- and that is the commercial question: it is what makes a
 * K+ membership worth offering at all. Whether a capability is currently being
 * PROMOTED is a separate, softer one. An operator can quieten promotion of a
 * capability that keeps working (Virtual Try-On has such a dimmer), and doing
 * so must hide that capability's benefit line without making the membership
 * itself look like it has nothing in it.
 *
 * So a surface that decides whether to offer K+ asks the function above, and
 * only the benefit LIST is passed through this one. Only an explicit `false`
 * hides: a capability with no promotion answer is promoted exactly as before.
 */
export type KPlusCapabilityPromotion = Partial<Record<KPlusActivationCapabilityId, boolean | null>>;

export function selectPromotedCapabilities<T extends { id: KPlusActivationCapabilityId }>(
  capabilities: readonly T[],
  promotion: KPlusCapabilityPromotion = {},
): T[] {
  return capabilities.filter((capability) => promotion[capability.id] !== false);
}

/**
 * The verb each capability contributes to the activation sub-headline, in
 * sentence order. The order is the one the previous fixed sentence used
 * ("scan, style, try on, and plan"), so a build where all four are advertised
 * reads byte-for-byte as it always did.
 */
const ACTIVATION_WAYS: ReadonlyArray<{ id: KPlusActivationCapabilityId; verb: string }> =
  Object.freeze([
    Object.freeze({ id: 'voice_scan' as const, verb: 'scan' }),
    Object.freeze({ id: 'wardrobe_concierge' as const, verb: 'style' }),
    Object.freeze({ id: 'virtual_try_on' as const, verb: 'try on' }),
    Object.freeze({ id: 'packing_intelligence' as const, verb: 'plan' }),
    Object.freeze({ id: 'smart_watchlist' as const, verb: 'track' }),
    Object.freeze({ id: 'cloud_closet' as const, verb: 'back up' }),
  ]);

/** "scan", "scan and try on", "scan, style, and try on", "scan, style, try on, and plan". */
export function describeActivationWays(
  capabilities: ReadonlyArray<Pick<KPlusActivationCapability, 'id'>>,
): string {
  const verbs = ACTIVATION_WAYS
    .filter((way) => capabilities.some((capability) => capability.id === way.id))
    .map((way) => way.verb);
  if (verbs.length === 0) return '';
  if (verbs.length === 1) return verbs[0];
  if (verbs.length === 2) return `${verbs[0]} and ${verbs[1]}`;
  return `${verbs.slice(0, -1).join(', ')}, and ${verbs[verbs.length - 1]}`;
}

/** The activation offer's sub-headline. It may only name what is advertised. */
export function activationOfferSubhead(
  capabilities: ReadonlyArray<Pick<KPlusActivationCapability, 'id'>>,
): string {
  const ways = describeActivationWays(capabilities);
  return ways ? `Unlock more ways to ${ways} with K Scan AI.` : '';
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
