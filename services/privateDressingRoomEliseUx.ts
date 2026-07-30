/**
 * The approved Elise copy, and the rules for when each surface may appear.
 *
 * ONE TABLE, AND THE APP OWNS IT. The response contract has room for a
 * `clarification` and a `displayCopy` string, and both are validated and bounded
 * — but nothing here reads them. Every word the user sees is chosen locally from
 * the status the application derived, so a provider cannot author UI text, and a
 * reword never has to chase a prompt.
 *
 * PURE. No React, no navigation, no storage. The screen renders what this
 * returns; it does not decide any of it.
 */

import { isOnCasualnessLadder } from './privateDressingRoomCasualness';
import type { EliseStatus } from './privateDressingRoomEliseOrchestration';

export const PRIVATE_ELISE_COPY = Object.freeze({
  occasionEntryLabel: 'Other…',
  occasionSheetTitle: 'Describe the occasion',
  occasionSheetPlaceholder: 'Dinner with clients',
  occasionSubmit: 'Ask Elise',
  cancel: 'Cancel',
  makeMoreCasual: 'Make it more casual',
  buildAround: 'Build an Outfit',

  loadingOccasion: 'Understanding your occasion…',
  loadingAnchor: 'Building around this item…',
  loadingCasual: 'Making this look more casual…',

  successCasual: 'This look is now more casual.',
  successAnchor: 'Building around your item.',
  clarification: 'I need a little more detail about the occasion.',
  unsupportedOccasion: "I couldn't match that to a supported occasion. Choose an option below.",
  alreadyCasual: 'This look is already at its most casual. Try changing the occasion or anchor.',
  unsupportedAnchor: "This item can't be used as the anchor for a look yet.",
  capabilityUnavailable: 'Elise is being updated. Try again soon.',
  sessionExpired: 'Your session expired. Sign in again to ask Elise.',
  safeFailure: "I couldn't update this look. Try again.",
});

/** The bounded occasion input length. Matches the contract's instruction bound. */
export const PRIVATE_ELISE_INPUT_MAX_LENGTH = 200;

/**
 * The single line of status copy for a state, or null when nothing shows.
 *
 * `success` for an occasion names the occasion because the user asked for that
 * specific change and deserves to see which one landed. The name is the
 * validated enum value, never provider prose.
 */
export function eliseStatusCopy(status: EliseStatus | null | undefined): string | null {
  if (!status || status.kind === 'idle') return null;
  switch (status.kind) {
    case 'loading':
      if (status.operation === 'build_around_item') return PRIVATE_ELISE_COPY.loadingAnchor;
      if (status.operation === 'make_more_casual') return PRIVATE_ELISE_COPY.loadingCasual;
      return PRIVATE_ELISE_COPY.loadingOccasion;
    case 'success':
      if (status.operation === 'make_more_casual') return PRIVATE_ELISE_COPY.successCasual;
      if (status.operation === 'build_around_item') {
        // NEVER the loading string. Device QA found a completed action showing
        // "Building around this item…" — a progress message, ellipsis and all —
        // because itemType was unset. A finished operation must read as finished.
        return status.itemType
          ? `Building around your ${status.itemType}.`
          : PRIVATE_ELISE_COPY.successAnchor;
      }
      return status.occasion ? `Using “${status.occasion}” for this occasion.` : null;
    case 'clarification':
      return PRIVATE_ELISE_COPY.clarification;
    case 'unsupported':
      if (status.operation === 'build_around_item') return PRIVATE_ELISE_COPY.unsupportedAnchor;
      return PRIVATE_ELISE_COPY.unsupportedOccasion;
    case 'already_casual':
      return PRIVATE_ELISE_COPY.alreadyCasual;
    case 'capability_unavailable':
      return PRIVATE_ELISE_COPY.capabilityUnavailable;
    case 'session_expired':
      return PRIVATE_ELISE_COPY.sessionExpired;
    case 'failed':
      return PRIVATE_ELISE_COPY.safeFailure;
    default:
      return null;
  }
}

/**
 * Copy that must be announced to a screen reader when it appears.
 *
 * Loading is announced so a blind user is not left in silence; results are
 * announced once. `assertive` is reserved for states that end the operation, so
 * a spinner never interrupts.
 */
export function eliseAnnouncement(status: EliseStatus | null | undefined): {
  message: string;
  politeness: 'polite' | 'assertive';
} | null {
  const message = eliseStatusCopy(status);
  if (!message || !status) return null;
  const terminal =
    status.kind !== 'loading' && status.kind !== 'idle';
  return { message, politeness: terminal ? 'assertive' : 'polite' };
}

/** True while an operation is running and the submit control must be disabled. */
export function isEliseBusy(status: EliseStatus | null | undefined): boolean {
  return status?.kind === 'loading';
}

/**
 * Which Phase 4 affordances may render right now.
 *
 * ADDITIVE BY CONSTRUCTION. With `eliseEnabled` false every value is false, so
 * the Phase 3.5 screen renders exactly as it did — the manual occasion chips are
 * never removed, renamed or reordered by this phase, and "Other…" is only ever
 * appended after them.
 */
export function eliseAffordances(input: {
  eliseEnabled: boolean;
  sessionActive: boolean;
  hasEffectiveLook: boolean;
  currentOccasion: string | null;
  busy: boolean;
}): {
  showOccasionEntry: boolean;
  showMakeMoreCasual: boolean;
  canSubmitOccasion: boolean;
} {
  const enabled = input.eliseEnabled && input.sessionActive;
  return {
    showOccasionEntry: enabled,
    // Offered for a real current look whose occasion is ON the formality ladder
    // — INCLUDING the floor. At the floor the action explains itself with the
    // approved "already at its most casual" copy; hiding it there (which is what
    // gating on `canMakeMoreCasual` did) left that copy unreachable and told the
    // user nothing. Off-ladder occasions (travel, neutral) are still not
    // offered, because there the transition has no meaning at all.
    showMakeMoreCasual: enabled && input.hasEffectiveLook && isOnCasualnessLadder(input.currentOccasion),
    canSubmitOccasion: enabled && !input.busy,
  };
}

/** Trims and bounds a typed occasion description. Empty means "not submittable". */
export function normalizeOccasionInput(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, PRIVATE_ELISE_INPUT_MAX_LENGTH);
}
