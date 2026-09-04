/**
 * Cloud transition boundary — Section 14.
 *
 * "Live processing and generative VTO are separate privacy states."
 * `LiveVTOPrivacyPhase` is the type-level fence between them: nothing that
 * touches phase `'live'` may reference a network client, and the only way
 * to reach `'aiPhoto'` is the explicit `requestAiPhoto` transition below —
 * never an automatic/background one.
 */
export type LiveVTOPrivacyPhase = 'live' | 'aiPhotoRequested' | 'aiPhotoInFlight';

export interface PrivacyPhaseTransition {
  from: LiveVTOPrivacyPhase;
  to: LiveVTOPrivacyPhase;
  /** Always true today — every transition in this contract requires a user action; there is no automatic phase change. Kept explicit rather than assumed so a future transition can't silently become automatic without this field being touched. */
  requiresExplicitUserAction: true;
}

export const AI_PHOTO_TRANSITION: PrivacyPhaseTransition = {
  from: 'live',
  to: 'aiPhotoRequested',
  requiresExplicitUserAction: true,
};

/**
 * Section 14 candidate copy — "Final production wording will require
 * legal/product approval." Exported as a named candidate, not silently
 * wired into any UI string table, so it cannot leak into a shipped screen
 * without someone deliberately importing it.
 */
export const CANDIDATE_PRIVACY_DISCLAIMER =
  'Pose and Live Preview processing happen on this device. A photo is sent only if you choose AI Photo.';

/**
 * Section 15 candidate copy — same non-binding status as the privacy
 * disclaimer above.
 */
export const CANDIDATE_FIT_DISCLAIMER = 'VISUALIZATION ONLY — NOT A FIT PREDICTION';

/**
 * Data classes Section 13 requires stay local during 'live' phase. This
 * list is consumed by the privacy test suite (tests/privacy/) to check
 * that no network-audit log entry references one of these class names
 * while phase === 'live'.
 */
export const LOCAL_ONLY_DURING_LIVE = [
  'cameraFrame',
  'faceImagery',
  'bodyImagery',
  'poseLandmarks',
  'segmentationMask',
  'bodyProxy',
  'cameraDerivedGeometry',
  'lightingAnalysis',
  'captureReplayBuffer',
] as const;
export type LocalOnlyDataClass = (typeof LOCAL_ONLY_DURING_LIVE)[number];
