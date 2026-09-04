/**
 * User-visible privacy state model — Phase 3 Section 22.
 *
 * "The privacy-state change must always be explicit," and "the existing AI
 * Photo/generative path" must never be described as zero-knowledge -- the
 * Live path and Photoreal path have genuinely different privacy properties,
 * and this module's whole job is making that difference legible rather than
 * blurring it into one reassuring sentence.
 *
 * Candidate copy only, same non-binding status as the existing
 * `CANDIDATE_PRIVACY_DISCLAIMER`/`CANDIDATE_FIT_DISCLAIMER` in
 * `@kscan-live-vto/contract`'s `privacy.ts`: exported as named candidates,
 * not wired into any UI string table, so nothing here can reach a shipped
 * screen without someone deliberately importing it. Final production
 * wording remains legal/product's call, exactly as Phase 1-2 already noted.
 */

import { CANDIDATE_FIT_DISCLAIMER, CANDIDATE_PRIVACY_DISCLAIMER } from '@kscan-live-vto/contract';
import type { PhotorealIntentState } from './photorealIntent';

export const USER_VISIBLE_PRIVACY_STAGES = [
  'LIVE_PREVIEW',
  'PHOTOREAL_REQUESTED',
  'PHOTOREAL_PROCESSING',
  'RETURN_TO_LIVE',
] as const;
export type UserVisiblePrivacyStage = (typeof USER_VISIBLE_PRIVACY_STAGES)[number];

export interface PrivacyStageDescription {
  stage: UserVisiblePrivacyStage;
  headline: string;
  detail: string;
}

/**
 * Section 22's four-row table, reproduced as candidate copy. LIVE_PREVIEW
 * reuses the existing `CANDIDATE_PRIVACY_DISCLAIMER` verbatim rather than
 * inventing a second sentence describing the same on-device processing
 * claim -- two slightly different sentences making the same claim is how a
 * privacy statement quietly drifts.
 */
export const PRIVACY_STAGE_COPY: Readonly<Record<UserVisiblePrivacyStage, PrivacyStageDescription>> = {
  LIVE_PREVIEW: {
    stage: 'LIVE_PREVIEW',
    headline: 'Camera processing: on device',
    detail: CANDIDATE_PRIVACY_DISCLAIMER,
  },
  PHOTOREAL_REQUESTED: {
    stage: 'PHOTOREAL_REQUESTED',
    headline: 'Photoreal requested',
    detail: 'A still image will be sent for AI generation once you confirm the capture.',
  },
  PHOTOREAL_PROCESSING: {
    stage: 'PHOTOREAL_PROCESSING',
    headline: 'Photoreal processing',
    detail: `Cloud processing is active for the explicit still you captured. ${CANDIDATE_FIT_DISCLAIMER}`,
  },
  RETURN_TO_LIVE: {
    stage: 'RETURN_TO_LIVE',
    headline: 'Back to Live Preview',
    detail: 'Live camera processing remains local. Nothing further is sent unless you choose Photoreal again.',
  },
};

/**
 * Derives the user-visible stage from the intent state machine plus whether
 * the bridge handoff has actually been invoked yet. `bridgeInFlight` is
 * intentionally a separate input rather than a fifth `PhotorealIntentState`:
 * GENERATIVE_HANDOFF_READY means "a request COULD be sent now," which is
 * still fully local, while PHOTOREAL_PROCESSING means a request actually
 * was sent -- collapsing those into one state would blur exactly the
 * distinction Section 22 asks this module to keep explicit.
 */
export function describePrivacyStage(
  state: PhotorealIntentState,
  bridgeInFlight: boolean,
): PrivacyStageDescription {
  if (state === 'LIVE_LOCAL') return PRIVACY_STAGE_COPY.LIVE_PREVIEW;
  if (state === 'GENERATIVE_HANDOFF_READY' && bridgeInFlight) return PRIVACY_STAGE_COPY.PHOTOREAL_PROCESSING;
  return PRIVACY_STAGE_COPY.PHOTOREAL_REQUESTED;
}

/** The transient acknowledgement shown at the moment a session returns to
 *  Live -- distinct from the steady-state LIVE_PREVIEW description, since
 *  the language should acknowledge "you're back" rather than "you never
 *  left." A caller shows this once, then the ordinary LIVE_PREVIEW
 *  description applies again. */
export function describeReturnToLive(): PrivacyStageDescription {
  return PRIVACY_STAGE_COPY.RETURN_TO_LIVE;
}

/**
 * Honesty guard for anything built on top of this module: the existing
 * generative path is not, and must never be described as, zero-knowledge.
 * Exported as an assertion (not just a comment) so a contract test can pin
 * it against every candidate string in this file.
 */
export function assertNoZeroKnowledgeClaim(text: string): void {
  if (/zero[\s-]?knowledge/i.test(text)) {
    throw new RangeError(`Privacy copy must not claim zero-knowledge processing: ${JSON.stringify(text)}`);
  }
}
