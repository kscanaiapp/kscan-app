// Build 35 Packing Intelligence -- structured plan state (pure).
//
// WHY STATE, NOT PROSE. V1 refinement regenerated the whole trip from the
// original request plus a growing list of sentences. "Make Friday casual" could
// therefore change Monday, and "keep Saturday" had nothing to hold on to. This
// is the data a refinement modifies: which looks sit on which days, which
// pieces are pinned or rejected, and which constraints are active.
//
// THE CONCIERGE TRUST RULE, APPLIED TO A TRIP. Wardrobe Concierge V2
// (eliseOutfitState.ts) established it and Packing inherits it unchanged:
// state that round-trips through the client is UNTRUSTED on the way back in.
//   - rejections can only REMOVE pieces from a plan;
//   - a carried or pinned piece survives only if its id re-resolves against
//     THIS actor's freshly retrieved, RLS-scoped Closet (verifyPackingPlanState);
//   - ownership is never read from this object -- it has no ownership field to
//     forge. Every packed item's ownership is re-derived from retrieval.
// So another actor's state, or a tampered one, can at most ask for fewer
// pieces. It cannot put a garment in anyone's suitcase.
//
// DELIBERATELY SEPARATE TYPE from EliseOutfitState: that models ONE look across
// chat turns; this models a multi-day trip whose slots, pins and reuse only mean
// something against a schedule. The principles are shared, the shape cannot be.
//
// Ids, enums and bounded codes only. No titles, no destination, no free text.

import { PACKING_ACTIVITIES, type PackingActivity } from './packingContract.ts';
import { SLOT_ID_RE } from './packingSchedule.ts';
import type { PackingFormalityShift } from './packingGarmentFacts.ts';

export const PACKING_STATE_VERSION = 1;

export const PACKING_STATE_LIMITS = {
  maxSlots: 21,
  maxItemsPerSlot: 6,
  maxPinnedSlots: 21,
  maxPinnedItems: 12,
  maxRejections: 40,
  maxRejectedClasses: 12,
  maxConstraints: 16,
  maxGapCodes: 8,
  maxIdChars: 80,
  maxPlanVersion: 500,
} as const;

export interface PackingStateSlot {
  slotId: string;
  activity: PackingActivity;
  originalActivity: PackingActivity | null;
  formalityShift: PackingFormalityShift | null;
  itemIds: string[];
}

export interface PackingRejection {
  itemId: string;
  /** Where the piece was when it was rejected, so "bring it back" can restore it. */
  slotIds: string[];
}

export interface PackingPlanState {
  stateVersion: typeof PACKING_STATE_VERSION;
  plannerVersion: 2;
  /** Increments on every accepted change. */
  planVersion: number;
  /** Stable for the life of one trip's plan, across refinements. */
  tripId: string;
  /** Hash of destination + dates. State for a different trip is discarded. */
  tripKey: string;
  slots: PackingStateSlot[];
  pinnedSlotIds: string[];
  pinnedItemIds: string[];
  rejections: PackingRejection[];
  rejectedGarmentClasses: string[];
  /** Bounded codes, e.g. `no_repeat:bottom`, `prefer_class:d3-dinner:sneaker`. */
  activeConstraints: string[];
  gapCodes: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRIP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CLASS_RE = /^[a-z]{2,20}$/;
const ROLE_RE = /^(?:base|mid|outer|bottom|one_piece|shoe|accessory)$/;
const CONDITION_RE = /^(?:rain|snow|cold|hot)$/;
const COLOR_RE = /^[a-z]{3,12}$/;

/**
 * Every constraint code the planner understands. Anything else is dropped on
 * restore -- an unknown code is not a constraint this build can honour, and
 * carrying it would make the state claim a rule nobody enforces.
 */
export function isPackingConstraintCode(code: string): boolean {
  if (code === 'owned_only' || code === 'allow_shopping' || code === 'pack_light') return true;
  if (code === 'laundry:available' || code === 'laundry:unavailable') return true;
  const [kind, a, b] = code.split(':');
  switch (kind) {
    case 'no_repeat':
    case 'rewear_ok':
      return code.split(':').length === 2 && ROLE_RE.test(a ?? '');
    case 'condition':
      return code.split(':').length === 2 && CONDITION_RE.test(a ?? '');
    case 'color':
      return code.split(':').length === 2 && COLOR_RE.test(a ?? '');
    case 'prefer_class':
      return (
        code.split(':').length === 3 &&
        (a === 'all' || SLOT_ID_RE.test(a ?? '')) &&
        CLASS_RE.test(b ?? '')
      );
    default:
      return false;
  }
}

/** FNV-1a, hex. Identifies a trip without carrying its destination text. */
export function packingTripKey(trip: { destination: string; startDate: string; endDate: string }): string {
  const input = `${trip.destination.trim().toLowerCase()}|${trip.startDate}|${trip.endDate}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function idList(value: unknown, max: number, pattern: RegExp): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim().toLowerCase().slice(0, PACKING_STATE_LIMITS.maxIdChars);
    if (!pattern.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function activityOf(value: unknown): PackingActivity | null {
  return typeof value === 'string' && (PACKING_ACTIVITIES as readonly string[]).includes(value)
    ? (value as PackingActivity)
    : null;
}

/**
 * Parse client-held state. Every field is re-validated, every list capped, and
 * unknown values DROPPED rather than coerced. State for a different trip, a
 * different state version or an out-of-range plan version yields null -- the
 * same, safe position as a first plan.
 */
export function restorePackingPlanState(
  raw: unknown,
  expected: { tripKey: string },
): PackingPlanState | null {
  if (!isRecord(raw)) return null;
  if (raw.stateVersion !== PACKING_STATE_VERSION) return null;
  if (raw.tripKey !== expected.tripKey) return null;
  const tripId = typeof raw.tripId === 'string' && TRIP_ID_RE.test(raw.tripId) ? raw.tripId : null;
  if (!tripId) return null;
  const planVersion =
    typeof raw.planVersion === 'number' && Number.isInteger(raw.planVersion) ? raw.planVersion : -1;
  if (planVersion < 1 || planVersion > PACKING_STATE_LIMITS.maxPlanVersion) return null;

  const slots: PackingStateSlot[] = [];
  for (const entry of Array.isArray(raw.slots) ? raw.slots : []) {
    if (slots.length >= PACKING_STATE_LIMITS.maxSlots) break;
    if (!isRecord(entry)) continue;
    const slotId = typeof entry.slotId === 'string' && SLOT_ID_RE.test(entry.slotId) ? entry.slotId : null;
    const activity = activityOf(entry.activity);
    if (!slotId || !activity || slots.some((slot) => slot.slotId === slotId)) continue;
    const shift =
      entry.formalityShift === 'less_formal' || entry.formalityShift === 'more_formal'
        ? entry.formalityShift
        : null;
    slots.push({
      slotId,
      activity,
      originalActivity: activityOf(entry.originalActivity),
      formalityShift: shift,
      itemIds: idList(entry.itemIds, PACKING_STATE_LIMITS.maxItemsPerSlot, UUID_RE),
    });
  }

  const rejections: PackingRejection[] = [];
  for (const entry of Array.isArray(raw.rejections) ? raw.rejections : []) {
    if (rejections.length >= PACKING_STATE_LIMITS.maxRejections) break;
    if (!isRecord(entry)) continue;
    const [itemId] = idList([entry.itemId], 1, UUID_RE);
    if (!itemId || rejections.some((rejection) => rejection.itemId === itemId)) continue;
    rejections.push({
      itemId,
      slotIds: idList(entry.slotIds, PACKING_STATE_LIMITS.maxSlots, SLOT_ID_RE),
    });
  }

  const constraints: string[] = [];
  for (const entry of Array.isArray(raw.activeConstraints) ? raw.activeConstraints : []) {
    if (typeof entry !== 'string') continue;
    const code = entry.trim().toLowerCase().slice(0, 64);
    if (!isPackingConstraintCode(code) || constraints.includes(code)) continue;
    constraints.push(code);
    if (constraints.length >= PACKING_STATE_LIMITS.maxConstraints) break;
  }

  return {
    stateVersion: PACKING_STATE_VERSION,
    plannerVersion: 2,
    planVersion,
    tripId,
    tripKey: expected.tripKey,
    slots,
    pinnedSlotIds: idList(raw.pinnedSlotIds, PACKING_STATE_LIMITS.maxPinnedSlots, SLOT_ID_RE),
    pinnedItemIds: idList(raw.pinnedItemIds, PACKING_STATE_LIMITS.maxPinnedItems, UUID_RE),
    rejections,
    rejectedGarmentClasses: idList(raw.rejectedGarmentClasses, PACKING_STATE_LIMITS.maxRejectedClasses, CLASS_RE),
    activeConstraints: constraints,
    gapCodes: idList(raw.gapCodes, PACKING_STATE_LIMITS.maxGapCodes, /^[a-z_]{3,60}$/),
  };
}

export interface PackingStateVerification {
  state: PackingPlanState;
  /** Carried or pinned ids that do not resolve to this actor's Closet. */
  droppedItemIds: string[];
  /**
   * False when so little of the prior plan re-resolves that carrying it would
   * misrepresent it (another actor's state, a Closet emptied since). The
   * handler then plans the trip afresh and says why.
   */
  reliable: boolean;
}

/**
 * Re-verify every carried id against THIS actor's freshly authorized Closet.
 * Rejections are kept even when unresolvable: they can only remove, so keeping
 * one is always safe.
 */
export function verifyPackingPlanState(
  state: PackingPlanState,
  authorizedItemIds: Set<string>,
): PackingStateVerification {
  const dropped = new Set<string>();
  let carried = 0;
  let kept = 0;
  const slots = state.slots.map((slot) => {
    const itemIds = slot.itemIds.filter((id) => {
      carried += 1;
      if (authorizedItemIds.has(id)) {
        kept += 1;
        return true;
      }
      dropped.add(id);
      return false;
    });
    return { ...slot, itemIds };
  });
  const pinnedItemIds = state.pinnedItemIds.filter((id) => {
    if (authorizedItemIds.has(id)) return true;
    dropped.add(id);
    return false;
  });
  const reliable = carried > 0 && kept * 2 >= carried;
  return {
    state: {
      ...state,
      slots,
      pinnedItemIds,
      // A pin on a slot with nothing verifiable left in it pins nothing.
      pinnedSlotIds: state.pinnedSlotIds.filter((slotId) =>
        slots.some((slot) => slot.slotId === slotId && slot.itemIds.length > 0)
      ),
    },
    droppedItemIds: [...dropped],
    reliable,
  };
}

/** Parsed view of the constraint codes the planner consumes. */
export interface PackingActiveConstraintView {
  ownedOnly: boolean;
  allowShopping: boolean;
  packLight: boolean;
  laundry: 'available' | 'unavailable' | 'unknown';
  noRepeatRoles: string[];
  rewearRoles: string[];
  conditions: string[];
  colors: string[];
  preferClasses: Array<{ slotIds: string[] | null; garmentClass: string }>;
}

export function readActiveConstraints(codes: string[]): PackingActiveConstraintView {
  const view: PackingActiveConstraintView = {
    ownedOnly: false,
    allowShopping: false,
    packLight: false,
    laundry: 'unknown',
    noRepeatRoles: [],
    rewearRoles: [],
    conditions: [],
    colors: [],
    preferClasses: [],
  };
  for (const code of codes) {
    const [kind, a, b] = code.split(':');
    if (code === 'owned_only') view.ownedOnly = true;
    else if (code === 'allow_shopping') view.allowShopping = true;
    else if (code === 'pack_light') view.packLight = true;
    else if (kind === 'laundry') view.laundry = a === 'available' ? 'available' : 'unavailable';
    else if (kind === 'no_repeat' && a) view.noRepeatRoles.push(a);
    else if (kind === 'rewear_ok' && a) view.rewearRoles.push(a);
    else if (kind === 'condition' && a) view.conditions.push(a);
    else if (kind === 'color' && a) view.colors.push(a);
    else if (kind === 'prefer_class' && a && b) {
      view.preferClasses.push({ slotIds: a === 'all' ? null : [a], garmentClass: b });
    }
  }
  return view;
}
