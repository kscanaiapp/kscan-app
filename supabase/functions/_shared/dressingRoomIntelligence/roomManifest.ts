/**
 * Server-authoritative room manifest (E4.1).
 *
 * WHY THIS EXISTS: the visual-context envelope already resolves and authorizes
 * each attachment INDIVIDUALLY, and the prompt presented the results as a flat
 * `evidence[1..n]` list. That is enough to answer "what is this jacket" and not
 * enough to answer "what is missing from this look" — nothing in the prompt
 * said the items constituted ONE room, which item does which structural job,
 * or that the list was exhaustive. Asked what was missing, the model could not
 * tell a room genuinely lacking shoes apart from one whose shoes were simply
 * never attached.
 *
 * This module turns that authorized list into a bounded room manifest: one
 * room, a known item set, derived roles, and an explicit statement of what the
 * server does and does not vouch for.
 *
 * INVARIANTS
 *   - Membership is never taken from the caller. Only items the resolver
 *     already marked server_verified may enter IN_ROOM.
 *   - Nothing is invented. An absent field is absent, not guessed.
 *   - A shared item never becomes an owned item, so ownership language stays
 *     truthful.
 */

import { deriveGarmentRole, roleCoverage, type GarmentRole } from './itemRoles.ts';

/**
 * Trust classes. These must stay separable all the way through prompt
 * construction: collapsing them is what lets a suggestion be described as
 * something the user already owns.
 */
export type RoomTrustClass =
  | 'IN_ROOM'
  | 'USER_STYLE_SIGNAL'
  | 'SUGGESTED_ITEM';

export type RoomManifestItem = {
  itemId: string;
  role: GarmentRole;
  category: string | null;
  subtype: string | null;
  primaryColor: string | null;
  otherColors: string[];
  materials: string[];
  pattern: string | null;
  silhouette: string | null;
  fit: string | null;
  brand: string | null;
  occasion: string[];
  /** 'owned' | 'shared' — never upgraded, never client-claimed. */
  relationship: string;
  hasAuthorizedImage: boolean;
};

export type RoomManifest = {
  roomId: string | null;
  /** True only when every included item was server-resolved for this actor. */
  authorized: boolean;
  /** 'owned_room' | 'shared_room' | 'mixed' | 'none' */
  roomKind: string;
  /**
   * Changes whenever the resolved item set changes. The model is told to treat
   * a differing revision as a new room state, which is what stops a follow-up
   * turn reasoning over items that have since been removed.
   */
  revision: string;
  items: RoomManifestItem[];
  coverage: ReturnType<typeof roleCoverage>;
  /** Fields the current contracts cannot reliably supply for this room. */
  unavailableFields: string[];
};

/** The shape this module consumes. Deliberately structural, not a class. */
export type ResolvedEvidenceLike = {
  evidenceId: string;
  itemId: string | null;
  roomId: string | null;
  sourceType: string;
  actorRelationship: string;
  trust: string;
  title: string | null;
  category: string | null;
  subcategory: string | null;
  colors: string[];
  materials: string[];
  silhouette: string | null;
  /**
   * Closet V2 / S4. Optional so a caller built against the pre-S4 envelope
   * still type-checks; absent is read as "not carried", exactly as before.
   */
  pattern?: string | null;
  fit?: string | null;
  styleAttributes: string[];
  occasionAttributes: string[];
  brand: string | null;
  imageReferenceType: string;
};

const ROOM_SOURCE_TYPES = new Set(['owned_room_item', 'shared_room_item']);

/**
 * Fields Room Intelligence would use but the active identification contract
 * does not guarantee. Recorded explicitly and told to the model rather than
 * silently omitted, so "I can't judge the texture" is available as an honest
 * answer instead of an invented one.
 *
 * `texture` remains here permanently: nothing in the identification contract
 * produces it.
 *
 * `fit` and `pattern` were here for the same reason until Closet V2 / S4
 * repaired the resolver — the identification snapshot always carried them, but
 * the evidence envelope dropped them before the manifest could see them. They
 * are now computed per-manifest below rather than declared constant, because a
 * constant list goes stale in exactly the direction that makes the model
 * understate what it actually knows. An item that genuinely has no pattern
 * still reports pattern unavailable; a room where every item has one no longer
 * does.
 */
const ALWAYS_UNAVAILABLE = ['texture'];

/** Per-field availability across the admitted room items. */
function deriveUnavailableFields(items: RoomManifestItem[]): string[] {
  const unavailable = [...ALWAYS_UNAVAILABLE];
  // A field is unavailable to the room only when NO admitted item carries it.
  // Partial coverage is genuine evidence and must not be suppressed.
  //
  // An empty room falls through both checks and reports each unavailable,
  // which is correct: with no items there is no evidence of either, and
  // claiming otherwise would be the exact overstatement this list prevents.
  if (!items.some((item) => item.pattern)) unavailable.push('pattern');
  if (!items.some((item) => item.fit)) unavailable.push('fit');
  return unavailable;
}

function firstOrNull(values: string[]): string | null {
  return values.length > 0 ? values[0] : null;
}

/**
 * A short, order-independent fingerprint of the resolved item set.
 *
 * Order-independent on purpose: re-attaching the same items in a different
 * order is the same room and must not read as a change. Synchronous and
 * dependency-free so manifest construction stays a pure function.
 */
function computeRevision(itemIds: string[]): string {
  if (itemIds.length === 0) return 'empty';
  let h1 = 0x811c9dc5;
  for (const id of [...itemIds].sort()) {
    for (let i = 0; i < id.length; i++) {
      h1 ^= id.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
    h1 = Math.imul(h1 ^ 0x2d, 0x01000193) >>> 0;
  }
  return `r${h1.toString(16)}-${itemIds.length}`;
}

/**
 * Build the manifest from already-resolved evidence.
 *
 * Only `trust === 'server_verified'` room items are admitted. Everything else
 * — a client_metadata item, a commerce product, a legacy unverified record —
 * is excluded from IN_ROOM by construction rather than by a later filter that
 * could be forgotten.
 */
export function buildRoomManifest(
  evidence: ResolvedEvidenceLike[],
): RoomManifest {
  const roomItems = evidence.filter(
    (item) =>
      ROOM_SOURCE_TYPES.has(item.sourceType) &&
      item.trust === 'server_verified' &&
      typeof item.itemId === 'string' &&
      item.itemId.length > 0,
  );

  const roomIds = [...new Set(roomItems.map((i) => i.roomId).filter((id): id is string => !!id))];
  const relationships = new Set(roomItems.map((i) => i.actorRelationship));

  const items: RoomManifestItem[] = roomItems.map((item) => ({
    itemId: item.itemId as string,
    role: deriveGarmentRole({
      category: item.category,
      // The envelope's `subcategory` carries what identification calls
      // `subtype`. Named here as the contract names it.
      subtype: item.subcategory,
      title: item.title,
    }),
    category: item.category,
    subtype: item.subcategory,
    primaryColor: firstOrNull(item.colors),
    otherColors: item.colors.slice(1),
    materials: item.materials,
    // Closet V2 / S4: carried from the repaired resolver contract. Still
    // `?? null` rather than derived — an item whose source never recorded one
    // reports absent, it does not borrow a neighbour's value.
    pattern: item.pattern ?? null,
    silhouette: item.silhouette,
    fit: item.fit ?? null,
    brand: item.brand,
    occasion: item.occasionAttributes,
    relationship: item.actorRelationship,
    hasAuthorizedImage: item.imageReferenceType === 'storage_object',
  }));

  const roomKind = roomItems.length === 0
    ? 'none'
    : relationships.has('owned') && relationships.has('shared')
    ? 'mixed'
    : relationships.has('shared')
    ? 'shared_room'
    : 'owned_room';

  return {
    roomId: roomIds.length === 1 ? roomIds[0] : null,
    authorized: roomItems.length > 0,
    roomKind,
    revision: computeRevision(items.map((i) => i.itemId)),
    items,
    coverage: roleCoverage(items.map((i) => i.role)),
    unavailableFields: deriveUnavailableFields(items),
  };
}

/** Evidence that is real but is NOT part of the room. */
export function buildSuggestionContext(
  evidence: ResolvedEvidenceLike[],
): ResolvedEvidenceLike[] {
  return evidence.filter((item) => !ROOM_SOURCE_TYPES.has(item.sourceType));
}
