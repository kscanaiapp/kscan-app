/**
 * The K+ activation catalog: what the activation screen is allowed to claim.
 *
 * Three separate questions, deliberately kept apart:
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
 *      what is really compiled in.
 *
 *   3. WHICH OF THEM THE SERVER ACTUALLY SERVES.  A build flag says the code is
 *      in the binary; it says nothing about whether the server side that code
 *      calls is switched on. Packing Intelligence and Wardrobe Concierge are
 *      compiled into the Build 34 certification binary, but the server side
 *      they need was not enabled at the last audit, so a member who activated
 *      K+ for them would get a failing feature. The screen may only advertise a
 *      capability the user can actually USE, so
 *      `KPLUS_CAPABILITY_SERVER_ENABLEMENT` is a closed, dated record of what
 *      the server is known to serve (or, for a capability whose server switch
 *      the client can read, which live signal decides) and
 *      `resolveActivationCapabilities` requires BOTH answers.
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
  /** True when this build compiled the capability in AND the server is known
   *  to serve it (see KPLUS_CAPABILITY_SERVER_ENABLEMENT). */
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

/**
 * Whether the SERVER is known to serve a capability's server side.
 *
 *   'confirmed'   -- the server side this capability needs is switched on. (It
 *                    says nothing about on-device behaviour, which is checked on
 *                    a device.)
 *   'unconfirmed' -- not known to work: dark, unset, or simply unproven. The
 *                    screen must not advertise it.
 *   'live'        -- the server side has a switch the client CAN read, so the
 *                    answer is decided at runtime from an injected signal
 *                    (`KPlusLiveSignals`), not from this file. Unknown -- not
 *                    read yet, unreadable, or off -- is not advertised.
 *
 * A hand-maintained record rather than a probe for the capabilities that have
 * nothing the client could read: Packing Intelligence and Wardrobe Concierge
 * are gated by server-side switches that no client-readable row mirrors, and
 * the entitlement summary carries no capability field. For THOSE entries a
 * snapshot goes stale in one direction only -- it can under-advertise (a
 * capability the owner enables later stays hidden until a client release flips
 * its entry), never over-advertise. A 'confirmed' entry is only as current as
 * its date, which is why anything with a readable switch is 'live' instead.
 * Each entry carries the evidence it rests on and when it was observed so the
 * next owner can re-check it.
 *
 * Flip an entry to 'confirmed' only after the capability has been enabled on
 * the server AND proven to work for a K+ member. The server switches are not
 * named here on purpose: this file ships in the app bundle.
 */
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
    status: 'unconfirmed' as const,
    basis:
      'The server-side switch Packing Intelligence needs was not enabled at the ' +
      '2026-09-24 read-only audit, so a Packing request fails for an activated member.',
  }),
});

/**
 * Which capabilities the screen may advertise: those this build compiled in
 * (build flags) AND that the server is known to serve
 * (KPLUS_CAPABILITY_SERVER_ENABLEMENT, with 'live' entries decided by
 * `liveSignals`). All three inputs are injectable so tests can exercise every
 * combination without re-importing the module under a mutated environment; the
 * catalog itself stays free of imports beyond the build flags.
 */
export function resolveActivationCapabilities(
  flags: {
    voiceScan?: boolean;
    vto?: boolean;
    concierge?: boolean;
    packing?: boolean;
  } = {},
  serverEnablement: Readonly<
    Record<KPlusActivationCapabilityId, KPlusServerEnablementRecord>
  > = KPLUS_CAPABILITY_SERVER_ENABLEMENT,
  liveSignals: KPlusLiveSignals = {},
): KPlusActivationCapability[] {
  const {
    voiceScan = VOICESCAN_ENABLED,
    vto = VTO_UI_ENABLED,
    concierge = ELISE_CONCIERGE_V1,
    packing = PACKING_INTELLIGENCE_V1,
  } = flags;

  const compiledIn: Record<KPlusActivationCapabilityId, boolean> = {
    voice_scan: voiceScan,
    virtual_try_on: vto,
    wardrobe_concierge: concierge,
    packing_intelligence: packing,
  };

  const servedByServer = (id: KPlusActivationCapabilityId): boolean => {
    const status = serverEnablement[id]?.status;
    if (status === 'confirmed') return true;
    // A 'live' capability is advertised only on an explicit yes. Not read yet,
    // unreadable and off all fail closed.
    if (status === 'live') return liveSignals[id] === true;
    return false;
  };

  return KPLUS_ACTIVATION_CAPABILITIES
    .filter((capability) => compiledIn[capability.id] && servedByServer(capability.id))
    .map((capability) => ({ ...capability, available: true }));
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
