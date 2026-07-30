import type { ClosetItemProjection } from './closetItemProjection';
import { classifyClosetItemSlot } from './privateDressingRoomSlots';
import type { PrivateDressingRoomSlot } from '../types/privateDressingRoomComposition';
import type { PrivateSavedLookSlotV1, PrivateSavedLookV1 } from '../types/privateSavedLook';

export const PRIVATE_OWNERSHIP_STATES = [
  'exact_owned',
  'probable_owned',
  'similar_owned',
  'not_owned',
  'unknown',
  'deleted_reference',
  'incompatible_edit',
] as const;

export type PrivateOwnershipState = (typeof PRIVATE_OWNERSHIP_STATES)[number];

export type PrivateOwnershipAction =
  | 'shop_anyway'
  | 'find_alternative'
  | 'replace_item'
  | 'upgrade_piece';

export type OwnershipClosetProjection = ClosetItemProjection & { actorId?: string | null };

/**
 * The actor the supplied Closet was read for.
 *
 * REQUIRED, and deliberately not optional. `ClosetItemProjection` carries no
 * `actorId`, so an item on its own cannot prove whose it is, and guessing is
 * unsafe in BOTH directions:
 *
 *   - admit an unattributed item and another actor's garment can be reported as
 *     owned, which is a cross-actor disclosure;
 *   - exclude it and a genuinely owned piece resolves to `not_owned`, which
 *     un-suppresses commerce and offers to sell the user something they own.
 *
 * Neither is an acceptable default, so this resolver does not choose one. The
 * caller states the scope it can actually prove — the actor id its Closet read
 * was made with — and TypeScript rejects any call site that stays silent.
 *
 * `loadedForActorId: null` means "cannot be proven" and fails closed: only
 * items carrying an explicit matching `actorId` are considered.
 */
export type OwnershipClosetScope = {
  loadedForActorId: string | null;
};

export type PrivateSlotOwnership = {
  slotKey: PrivateDressingRoomSlot;
  state: PrivateOwnershipState;
  matchedItem: ClosetItemProjection | null;
  ownedAlternatives: ClosetItemProjection[];
  confidenceExplanation: string;
  commerceSuppressed: boolean;
  showOwnedAlternativeFirst: boolean;
  actions: PrivateOwnershipAction[];
};

export type PrivateSavedLookOwnershipResult = {
  savedLookId: string;
  slots: PrivateSlotOwnership[];
};

function normalized(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return text || null;
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalized(a);
  const right = normalized(b);
  return !!left && !!right && left === right;
}

function sameSlot(item: ClosetItemProjection, slot: PrivateDressingRoomSlot): boolean {
  return classifyClosetItemSlot(item).primarySlot === slot;
}

/**
 * Fails closed on absent evidence. An item that names an actor must name THIS
 * one; an item that names none is admitted only under an explicit, matching
 * scope attestation from the caller.
 */
function belongsToActor(
  item: OwnershipClosetProjection,
  actorId: string,
  scope: OwnershipClosetScope,
): boolean {
  const declared = typeof item.actorId === 'string' ? item.actorId.trim() || null : null;
  if (declared !== null) return declared === actorId;
  const scoped = typeof scope?.loadedForActorId === 'string'
    ? scope.loadedForActorId.trim() || null
    : null;
  return scoped !== null && scoped === actorId;
}

function typeMatches(saved: PrivateSavedLookSlotV1, item: ClosetItemProjection): boolean {
  const snapshot = saved.snapshot;
  const savedTypes = [snapshot.subtype, snapshot.clothingType].filter(Boolean);
  if (savedTypes.length === 0) return false;
  return savedTypes.some((value) => same(value, item.subtype) || same(value, item.clothingType));
}

function sufficientTaxonomy(slot: PrivateSavedLookSlotV1): boolean {
  return !!normalized(slot.snapshot.category) &&
    (!!normalized(slot.snapshot.subtype) || !!normalized(slot.snapshot.clothingType));
}

function isProbable(slot: PrivateSavedLookSlotV1, item: ClosetItemProjection): boolean {
  const snapshot = slot.snapshot;
  if (!sufficientTaxonomy(slot) || !normalized(snapshot.primaryColor)) return false;
  if (!same(snapshot.category, item.category)) return false;
  if (!typeMatches(slot, item)) return false;
  if (!same(snapshot.primaryColor, item.primaryColor)) return false;
  if (normalized(snapshot.brand) && normalized(item.brand) && !same(snapshot.brand, item.brand)) {
    return false;
  }
  return true;
}

function similarityScore(slot: PrivateSavedLookSlotV1, item: ClosetItemProjection): number {
  let score = 0;
  if (same(slot.snapshot.category, item.category)) score += 4;
  if (typeMatches(slot, item)) score += 4;
  if (same(slot.snapshot.primaryColor, item.primaryColor)) score += 2;
  if (same(slot.snapshot.brand, item.brand)) score += 1;
  const savedMaterials = new Set(slot.snapshot.material.map(normalized).filter(Boolean));
  if (item.material.some((value) => savedMaterials.has(normalized(value)))) score += 1;
  return score;
}

function alternatives(
  slot: PrivateSavedLookSlotV1,
  closet: ClosetItemProjection[],
): ClosetItemProjection[] {
  return closet
    .filter((item) => sameSlot(item, slot.slotKey))
    .map((item) => ({ item, score: similarityScore(slot, item) }))
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
    .map((entry) => entry.item);
}

function result(
  slot: PrivateSavedLookSlotV1,
  state: PrivateOwnershipState,
  matchedItem: ClosetItemProjection | null,
  ownedAlternatives: ClosetItemProjection[],
  confidenceExplanation: string,
): PrivateSlotOwnership {
  const commerceSuppressed = state === 'exact_owned' || state === 'probable_owned';
  const showOwnedAlternativeFirst = state === 'similar_owned';
  const actions: PrivateOwnershipAction[] = commerceSuppressed
    ? ['shop_anyway', 'replace_item', 'upgrade_piece']
    : state === 'similar_owned'
      ? ['find_alternative', 'replace_item', 'upgrade_piece', 'shop_anyway']
      : ['find_alternative', 'shop_anyway'];
  return {
    slotKey: slot.slotKey,
    state,
    matchedItem,
    ownedAlternatives,
    confidenceExplanation,
    commerceSuppressed,
    showOwnedAlternativeFirst,
    actions,
  };
}

function resolveSlot(
  slot: PrivateSavedLookSlotV1,
  closet: ClosetItemProjection[],
): PrivateSlotOwnership {
  const sameId = slot.closetItemId
    ? closet.find((item) => item.id === slot.closetItemId) ?? null
    : null;
  if (sameId) {
    if (sameSlot(sameId, slot.slotKey)) {
      return result(
        slot,
        'exact_owned',
        sameId,
        [],
        'The original Closet item still exists in the same semantic slot.',
      );
    }
    return result(
      slot,
      'incompatible_edit',
      sameId,
      [],
      'The original Closet item still exists but now classifies into a different slot.',
    );
  }

  const candidates = alternatives(slot, closet);
  if (slot.closetItemId && slot.wasOwnedAtSave) {
    return result(
      slot,
      'deleted_reference',
      null,
      candidates,
      'The item was owned when saved, but its Closet reference no longer exists.',
    );
  }

  const probable = candidates.find((item) => isProbable(slot, item)) ?? null;
  if (probable) {
    return result(
      slot,
      'probable_owned',
      probable,
      candidates.filter((item) => item.id !== probable.id),
      'Slot, category, garment type, and primary color match deterministically; brand agrees when comparable.',
    );
  }

  const similar = candidates.filter((item) => typeMatches(slot, item));
  if (similar.length > 0 && sufficientTaxonomy(slot)) {
    return result(
      slot,
      'similar_owned',
      similar[0],
      similar.slice(1),
      'A same-slot Closet item exists, but one or more saved attributes differ.',
    );
  }

  if (!sufficientTaxonomy(slot)) {
    return result(
      slot,
      'unknown',
      null,
      [],
      'The saved slot lacks enough normalized taxonomy to decide ownership.',
    );
  }

  return result(
    slot,
    'not_owned',
    null,
    [],
    'No exact, probable, or similar same-slot Closet item exists.',
  );
}

/**
 * Pure: no auth, filesystem, Supabase, navigation, or mutation.
 *
 * `scope` is required — see OwnershipClosetScope for why absent actor evidence
 * cannot be given a safe default here.
 */
export function resolvePrivateSavedLookOwnership(
  savedLook: PrivateSavedLookV1,
  closetItems: readonly OwnershipClosetProjection[],
  scope: OwnershipClosetScope,
): PrivateSavedLookOwnershipResult {
  const actorCloset = closetItems
    .filter((item) => belongsToActor(item, savedLook.actorId, scope))
    .map(({ actorId: _actorId, ...item }) => item as ClosetItemProjection);
  return {
    savedLookId: savedLook.id,
    slots: savedLook.slots.map((slot) => resolveSlot(slot, actorCloset)),
  };
}
