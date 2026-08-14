import {
  STYLIST_AVATAR_PRESET_BY_ID,
  STYLIST_SPEECH_CONFIG_BY_ID,
} from '../constants/stylistIdentity';
import { hasValidFacialOverlayPackage } from '../constants/avatarFacialOverlays';
import {
  NO_MOTION_CAPABILITIES,
  type AvatarMotionCapabilities,
} from './avatarMotionState';

// Capability contract for avatar animation layers.
//
// Capabilities are DERIVED from the authoritative avatar configuration in
// constants/stylistIdentity.ts — never asserted independently — so a
// capability can only become true when the backing assets actually exist in
// the shipped configuration. Missing configuration always resolves to the
// fail-closed static-portrait default.
//
// Current baseline truth for the priority portraits (01–04, plus 05/08):
//   three-state mouth  YES  (closed/half-open/open PNG sets are bundled)
//   round mouth        NO   — assets missing
//   blink              NO   — assets missing
//   brows              NO   — assets missing
//   independent gaze   NO   — assets missing
//   head motion        YES  (rigid whole-composite transform, no new assets)
//   upper-body motion  YES  (rigid whole-composite transform, no new assets)

export function getAvatarMotionCapabilities(
  avatarId: string | null | undefined,
): AvatarMotionCapabilities {
  if (!avatarId) return NO_MOTION_CAPABILITIES;
  const preset = STYLIST_AVATAR_PRESET_BY_ID.get(avatarId);
  if (!preset || preset.kind !== 'portrait' || preset.availability !== 'ready') {
    // Abstract avatars and placeholders render as static treatments only.
    return NO_MOTION_CAPABILITIES;
  }

  const speech = STYLIST_SPEECH_CONFIG_BY_ID.get(avatarId);
  const hasMouthStates =
    speech?.speakingMotionMode === 'mouth_states' &&
    speech.mouthRegion != null &&
    speech.mouthStateSources != null &&
    speech.mouthStateSources.closed != null;

  return Object.freeze({
    threeStateMouth: hasMouthStates === true,
    // True only when a real round-mouth asset ships: either in the legacy
    // full-canvas mouth configuration or as a validated localized overlay
    // package. Registering the asset is what flips this on.
    roundMouth:
      hasMouthStates === true &&
      (speech!.mouthStateSources!.round != null ||
        hasValidFacialOverlayPackage(avatarId, 'mouthRound')),
    // Blink and brows require complete validated overlay packages; partial
    // packages count as absent. These must never be simulated by distorting
    // the portrait.
    blink: hasValidFacialOverlayPackage(avatarId, 'eyes'),
    brows: hasValidFacialOverlayPackage(avatarId, 'brows'),
    // Visible gaze needs independent eye assets. The head-orientation-only
    // fallback cue is not visually approved, so gaze tracks the eye package.
    gaze: hasValidFacialOverlayPackage(avatarId, 'eyes'),
    // Whole-composite rigid transforms need no per-avatar assets.
    headMotion: true,
    upperBodyMotion: true,
  });
}
