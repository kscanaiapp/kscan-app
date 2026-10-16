// Try-On Studio: the permanent Home destination for Virtual Try-On.
//
// This file is the Studio's whole decision. It reads nothing and renders
// nothing; hooks/useVtoStudio.ts feeds it facts that already exist (build flag,
// sign-in, the remote operator row, the K+ answer, Live capability, awareness
// history) and components/screens only draw
// what it returns. Import-free on purpose, like vtoDiscovery.ts, so it can be
// tested in isolation. Its state table is docs/vto-discovery-integration-matrices.md §3.
//
// RESUME IS NOT OFFERED. A minimized try-on belongs to the entry that launched it
// (VtoLaunchHost state is per entry on purpose), so the Studio cannot restore
// another screen's sheet. A Resume button here would be a control that does
// nothing; it is left out until the launcher has a restorable, app-level session.
//
// WHAT THE STUDIO IS NOT. It is not an entry point that can start a generation:
// every action navigates to somewhere a real garment is chosen (Scanner,
// Closet, Elise) or to an existing destination (Dressing Rooms).
// It never opens an empty request, adds no paywall, price, free
// allowance or quota, and stores nothing.
//
// WHAT IT DOES NOT SHOW, AND WHY.
//   - Live is offered only when the build flag, the remote Live switch and a
//     verified native capability all agree AND AI Photo itself is usable. Any
//     missing input hides it entirely: no "coming soon", no simulated Live.
//   - Recent Looks is not modelled. A saved try-on is stored as an ordinary
//     Dressing Room inspiration item that carries no VTO marker, so a "recent
//     try-ons" list could only be built from unrelated Dressing Room records or
//     a second store, and both are ruled out. Returning customers get a
//     navigation action to their Dressing Rooms instead.
//   - A K+ marker is never shown while the K+ answer is unknown (resolving is
//     not Free).

export type VtoStudioKPlus = 'free' | 'active' | 'complimentary' | 'resolving';

export interface VtoStudioInput {
  /** Build-time VTO UI flag. */
  uiEnabled: boolean;
  authenticated: boolean;
  /** The remote operator row; `null` until it has been read. */
  remote: { enabled: boolean; liveEnabled: boolean } | null;
  kplus: VtoStudioKPlus;
  /** Build-time Live flag. */
  liveBuildEnabled: boolean;
  /** A verified, native-sourced capability, never the development harness. */
  liveNativeCapable: boolean;
  /** `true` once this account has opened or completed a try-on; `null` until
   *  that history has been read. */
  everUsed: boolean | null;
}

export const VTO_STUDIO_STATES = [
  'HIDDEN',
  'RESOLVING',
  'UNAVAILABLE',
  'FIRST_USE',
  'RETURNING',
] as const;
export type VtoStudioState = (typeof VTO_STUDIO_STATES)[number];

export type VtoStudioPhoto = 'available' | 'kplus_required' | 'unavailable' | 'resolving';
export type VtoStudioMarker = 'none' | 'locked' | 'included';

export const VTO_STUDIO_ACTIONS = ['scan', 'closet', 'elise', 'dressing_rooms'] as const;
export type VtoStudioAction = (typeof VTO_STUDIO_ACTIONS)[number];

export interface VtoStudioDecision {
  state: VtoStudioState;
  /** Whether the Home entry and the screen render at all. */
  visible: boolean;
  photo: VtoStudioPhoto;
  /** `offered` only when every Live control agrees. */
  live: 'offered' | 'hidden';
  kplusMarker: VtoStudioMarker;
  /** Ordered. Empty whenever try-on is not usable. */
  actions: readonly VtoStudioAction[];
}

const HIDDEN: VtoStudioDecision = Object.freeze({
  state: 'HIDDEN',
  visible: false,
  photo: 'unavailable',
  live: 'hidden',
  kplusMarker: 'none',
  actions: Object.freeze([]) as readonly VtoStudioAction[],
});

export function resolveVtoStudio(input: VtoStudioInput): VtoStudioDecision {
  if (!input.uiEnabled || !input.authenticated) return HIDDEN;

  // The operator switch is read first: if it is off, nothing below matters.
  if (input.remote !== null && input.remote.enabled !== true) {
    return {
      state: 'UNAVAILABLE',
      visible: true,
      photo: 'unavailable',
      live: 'hidden',
      kplusMarker: 'none',
      actions: [],
    };
  }

  if (input.remote === null || input.kplus === 'resolving') {
    return {
      state: 'RESOLVING',
      visible: true,
      photo: 'resolving',
      live: 'hidden',
      kplusMarker: 'none',
      actions: [],
    };
  }

  const member = input.kplus === 'active' || input.kplus === 'complimentary';
  const returning = input.everUsed === true;
  const actions: VtoStudioAction[] = [];
  actions.push('scan', 'closet', 'elise');
  if (member && returning) actions.push('dressing_rooms');

  return {
    state: returning ? 'RETURNING' : 'FIRST_USE',
    visible: true,
    photo: member ? 'available' : 'kplus_required',
    live:
      member
      && input.liveBuildEnabled === true
      && input.remote.liveEnabled === true
      && input.liveNativeCapable === true
        ? 'offered'
        : 'hidden',
    kplusMarker: member ? 'included' : 'locked',
    actions,
  };
}

/** Every customer-visible word of the Studio. No fit, size or quality claim. */
export const VTO_STUDIO_COPY = Object.freeze({
  entryTitle: 'Try-On Studio',
  entrySubtitleReady: 'See how a piece could look on you.',
  entrySubtitleUnavailable: 'Not available right now.',
  entrySubtitleResolving: 'Checking availability.',
  entryA11yHint: 'Opens the Try-On Studio',
  screenTitle: 'Try-On Studio',
  screenSubtitle: 'VIRTUAL TRY-ON',
  photoTitle: 'AI Photo',
  photoBody:
    'Choose a piece, then a photo of yourself, and K Scan creates an AI visualization. '
    + 'It is a visualization, not a promise of how an item fits or what size to buy.',
  photoKPlusRequired: 'AI Photo try-on is part of K+. You can look around first.',
  liveTitle: 'Live',
  liveBody: 'Live shows a piece over your camera in real time. It is separate from AI Photo.',
  unavailableTitle: 'Try-on is not available right now',
  unavailableBody: 'Please check back later. Nothing is needed from you.',
  resolvingBody: 'Checking what is available for you.',
  actionsTitle: 'Start with a piece',
  actions: Object.freeze({
    scan: { label: 'Scan a look', hint: 'Opens the scanner to find a piece to try on' },
    closet: { label: 'Choose from your Closet', hint: 'Opens your Closet to pick a piece you own' },
    elise: { label: 'Ask Elise for styling help', hint: 'Opens a conversation with Elise' },
    dressing_rooms: { label: 'Your Dressing Rooms', hint: 'Opens the Dressing Rooms where saved try-ons are kept' },
  }),
});
