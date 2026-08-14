/**
 * Shared Dressing Room Intelligence (E4.1).
 *
 * Consumed by BOTH Elise endpoints so they cannot disagree about what a room
 * contains: stylechat-generate (conversational Elise) and style-outfit-generate
 * (the Dressing Room composer). The endpoints stay separate; the room truth
 * they reason over does not.
 *
 * Deliberately excluded from this module: provider execution, HTTP handling,
 * client state, avatar logic and commerce. It builds and describes room truth
 * and does nothing else.
 */

export {
  deriveGarmentRole,
  roleCoverage,
  type GarmentRole,
} from './itemRoles.ts';

export {
  buildRoomManifest,
  buildSuggestionContext,
  type ResolvedEvidenceLike,
  type RoomManifest,
  type RoomManifestItem,
  type RoomTrustClass,
} from './roomManifest.ts';

export {
  serializeRoomManifestSection,
  serializeRoomReasoningSection,
  type EscapeFn,
} from './promptSections.ts';
