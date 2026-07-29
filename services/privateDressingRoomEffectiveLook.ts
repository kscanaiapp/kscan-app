/**
 * Base look + validated overrides → effective look.
 *
 * PURE, and the single point where a Phase 2 generated look meets a Phase 3
 * user edit. Everything visible in Phase 3 flows through here.
 *
 * STRICT IMMUTABILITY, IN MEMORY AS WELL AS ON DISK. The base look is not
 * merely "not written back" — it is never touched at all:
 *
 *   - a NEW look object is built, never a mutated clone
 *   - `items` is a NEW array; base items are never pushed, spliced or sorted
 *   - a changed slot gets a NEW item object; the base item object is reused by
 *     reference only where it is genuinely unchanged, and is never written to
 *   - `missingSlots` is a NEW array recomputed from the result
 *
 * A shallow top-level copy that reuses the base `items` array would satisfy a
 * naive equality check and still let a later `sort()` reorder the generated
 * composition under the composer's feet. It is exactly the bug this module is
 * shaped to make impossible, and the tests freeze the base look to prove it.
 */

import {
  PRIVATE_CORE_SLOT_SETS,
  PRIVATE_SLOT_DISPLAY_ORDER,
  isPrivateSlot,
} from '../types/privateDressingRoomComposition';
import type {
  PrivateDressingRoomLookOption,
  PrivateDressingRoomOutfitItem,
  PrivateDressingRoomSlot,
  PrivateLookCompleteness,
} from '../types/privateDressingRoomComposition';
import type { PrivateDressingRoomSlotOverride } from '../types/privateDressingRoomInteraction';

export type EffectiveLookItem = PrivateDressingRoomOutfitItem & {
  /** True when this slot currently differs from the generated baseline. */
  overridden: boolean;
  /** The generated item this slot held, when it has been overridden. */
  baseClosetItemId: string | null;
};

export type EffectiveLook = {
  lookId: string;
  sessionId: string;
  items: EffectiveLookItem[];
  completeness: PrivateLookCompleteness;
  missingSlots: PrivateDressingRoomSlot[];
  labelCodes: readonly string[];
  rank: number;
  /** True when any slot of this look currently carries an override. */
  edited: boolean;
};

export type EffectiveLookFailure =
  | 'INVALID_INPUT'
  | 'STRUCTURAL_CONFLICT'
  | 'DUPLICATE_ITEM';

export type EffectiveLookResult = {
  ok: boolean;
  look: EffectiveLook | null;
  errorCode: EffectiveLookFailure | null;
};

function failure(errorCode: EffectiveLookFailure): EffectiveLookResult {
  return { ok: false, look: null, errorCode };
}

/**
 * Which core structure does this slot set satisfy, and what is absent?
 *
 * Reported against the structure the look comes CLOSEST to satisfying, exactly
 * as the Phase 2 composer does, so a top+bottom look is missing shoes rather
 * than "a dress".
 */
function recomputeStructure(filled: ReadonlySet<PrivateDressingRoomSlot>): {
  completeness: PrivateLookCompleteness;
  missingSlots: PrivateDressingRoomSlot[];
} {
  let best: readonly PrivateDressingRoomSlot[] = PRIVATE_CORE_SLOT_SETS[0];
  let bestFilled = -1;
  for (const structure of PRIVATE_CORE_SLOT_SETS) {
    const count = structure.filter((slot) => filled.has(slot)).length;
    if (count > bestFilled) {
      bestFilled = count;
      best = structure;
    }
  }
  const missingSlots = best.filter((slot) => !filled.has(slot));
  return {
    completeness: missingSlots.length === 0 ? 'complete' : 'partial',
    missingSlots,
  };
}

/**
 * A one-piece and separates cannot coexist.
 *
 * Phase 3 forbids structural category transformations outright (a top may only
 * become a top), so this can only trigger on a malformed or tampered override
 * set — which is precisely when it must refuse rather than render something the
 * user could not wear.
 */
function hasStructuralConflict(filled: ReadonlySet<PrivateDressingRoomSlot>): boolean {
  return filled.has('dress') && (filled.has('top') || filled.has('bottom'));
}

/**
 * Project one base look through its overrides.
 *
 * Overrides that do not apply — unknown slot, an item identical to the base, a
 * slot the base look does not have and cannot legally gain — are IGNORED rather
 * than treated as fatal, because a stale override must never make a perfectly
 * good generated look unrenderable. Overrides that would produce an unwearable
 * result (a duplicate garment, a dress beside a top) DO fail, because rendering
 * them would be worse than refusing.
 */
export function projectEffectiveLook(
  baseLook: PrivateDressingRoomLookOption | null | undefined,
  overrides: readonly PrivateDressingRoomSlotOverride[] | null | undefined,
): EffectiveLookResult {
  if (!baseLook || typeof baseLook !== 'object' || !Array.isArray(baseLook.items)) {
    return failure('INVALID_INPUT');
  }
  if (typeof baseLook.lookId !== 'string' || !baseLook.lookId) return failure('INVALID_INPUT');

  // One override per slot; a later duplicate for the same slot is ignored.
  const bySlot = new Map<PrivateDressingRoomSlot, PrivateDressingRoomSlotOverride>();
  for (const override of overrides ?? []) {
    if (!override || typeof override !== 'object') continue;
    if (!isPrivateSlot(override.slot)) continue;
    if (typeof override.closetItemId !== 'string' || !override.closetItemId) continue;
    if (!bySlot.has(override.slot)) bySlot.set(override.slot, override);
  }

  const baseMissing = new Set<PrivateDressingRoomSlot>(
    (baseLook.missingSlots ?? []).filter(isPrivateSlot),
  );

  const items: EffectiveLookItem[] = [];
  const usedSlots = new Set<PrivateDressingRoomSlot>();
  let edited = false;

  // 1. Every base slot, replaced where an override exists. A NEW item object is
  //    built for each: the base item is read, never handed out or written to.
  for (const baseItem of baseLook.items) {
    if (!baseItem || !isPrivateSlot(baseItem.slot)) continue;
    if (usedSlots.has(baseItem.slot)) continue;
    usedSlots.add(baseItem.slot);

    const override = bySlot.get(baseItem.slot);
    const overridden = !!override && override.closetItemId !== baseItem.closetItemId;
    if (overridden) edited = true;
    items.push({
      slot: baseItem.slot,
      closetItemId: overridden ? override!.closetItemId : baseItem.closetItemId,
      overridden,
      baseClosetItemId: baseItem.closetItemId,
    });
  }

  // 2. Overrides that FILL a slot the base look explicitly reported missing.
  //    Only those: an override may not invent an optional slot the composer
  //    never offered, because that is a structural change, not a swap.
  for (const [slot, override] of bySlot) {
    if (usedSlots.has(slot)) continue;
    if (!baseMissing.has(slot)) continue;
    usedSlots.add(slot);
    edited = true;
    items.push({
      slot,
      closetItemId: override.closetItemId,
      overridden: true,
      baseClosetItemId: null,
    });
  }

  // A garment cannot be worn in two places at once.
  const seenItems = new Set<string>();
  for (const item of items) {
    if (seenItems.has(item.closetItemId)) return failure('DUPLICATE_ITEM');
    seenItems.add(item.closetItemId);
  }

  const filled = new Set(items.map((item) => item.slot));
  if (hasStructuralConflict(filled)) return failure('STRUCTURAL_CONFLICT');

  const structure = recomputeStructure(filled);

  // Canonical display order, computed on the NEW array. The base array is never
  // sorted — `baseLook.items` is only ever read above.
  const ordered = items
    .slice()
    .sort(
      (a, b) =>
        PRIVATE_SLOT_DISPLAY_ORDER.indexOf(a.slot) - PRIVATE_SLOT_DISPLAY_ORDER.indexOf(b.slot),
    );

  return {
    ok: true,
    errorCode: null,
    look: {
      lookId: baseLook.lookId,
      sessionId: baseLook.sessionId,
      items: ordered,
      completeness: structure.completeness,
      missingSlots: structure.missingSlots,
      labelCodes: [...(baseLook.labelCodes ?? [])],
      rank: baseLook.rank,
      edited,
    },
  };
}

/** Project a whole composition. A look that cannot project is DROPPED, not faked. */
export function projectEffectiveLooks(
  baseLooks: readonly PrivateDressingRoomLookOption[] | null | undefined,
  overridesByLook: ReadonlyMap<string, readonly PrivateDressingRoomSlotOverride[]> | null,
): EffectiveLook[] {
  if (!Array.isArray(baseLooks)) return [];
  const out: EffectiveLook[] = [];
  for (const baseLook of baseLooks) {
    const overrides = overridesByLook?.get(baseLook?.lookId ?? '') ?? [];
    const result = projectEffectiveLook(baseLook, overrides);
    if (result.ok && result.look) out.push(result.look);
  }
  return out;
}

/** Index a persisted override list by lookId, for the projection above. */
export function indexOverrides(
  overrides:
    | readonly { lookId: string; slots: readonly PrivateDressingRoomSlotOverride[] }[]
    | null
    | undefined,
): Map<string, PrivateDressingRoomSlotOverride[]> {
  const map = new Map<string, PrivateDressingRoomSlotOverride[]>();
  for (const entry of overrides ?? []) {
    if (!entry || typeof entry.lookId !== 'string' || !entry.lookId) continue;
    map.set(entry.lookId, [...(entry.slots ?? [])]);
  }
  return map;
}

/** The item a slot currently shows, or null when the slot is empty/missing. */
export function effectiveItemForSlot(
  look: EffectiveLook | null | undefined,
  slot: PrivateDressingRoomSlot,
): EffectiveLookItem | null {
  if (!look) return null;
  for (const item of look.items) {
    if (item.slot === slot) return item;
  }
  return null;
}

/** Slots this look could legally edit: occupied slots plus explicitly missing ones. */
export function editableSlotsFor(look: EffectiveLook | null | undefined): PrivateDressingRoomSlot[] {
  if (!look) return [];
  const slots: PrivateDressingRoomSlot[] = [];
  for (const slot of PRIVATE_SLOT_DISPLAY_ORDER) {
    if (look.items.some((item) => item.slot === slot)) slots.push(slot);
    else if (look.missingSlots.includes(slot)) slots.push(slot);
  }
  return slots;
}
