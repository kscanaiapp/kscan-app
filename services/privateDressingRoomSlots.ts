/**
 * Closet item → private Dressing Room slot classification.
 *
 * PURE. Never mutates a projection, never reads a trusted internal Closet
 * record, never touches the filesystem.
 *
 * WHY KEYWORDS RATHER THAN A LOOKUP TABLE. Closet taxonomy is not a closed
 * enum. `category`, `clothingType` and `subtype` are free-form bounded strings
 * produced by the backend classifier and merely length-clamped on the way in
 * (services/closetLibrary.js#normalizeClosetTaxonomyValue,
 * services/closetCandidateClassification.js). There is no repository vocabulary
 * to enumerate, so an exhaustive value→slot table would be a table of guesses
 * that silently fails on the first unseen term. The repository's own answer to
 * this is keyword matching — services/free-tier/outfitGenerator.ts
 * #bucketForCategory, already shared with free-tier/pairingSuggestions.ts — and
 * this module reuses that engine rather than inventing a second vocabulary.
 *
 * WHAT IS ADDED on top of `bucketForCategory`: a precedence order. That function
 * takes ONE string; a Closet projection carries four fields of decreasing
 * specificity, and "Blazer" as a subtype should beat "Outerwear" as a category
 * only in the sense that it is consulted first and agrees. Consulting the most
 * specific field first is what makes a `subtype: 'jumpsuit'` under
 * `category: 'Dresses'` classify as a one-piece rather than by luck.
 */

import { bucketForCategory } from './free-tier/outfitGenerator';
import type { ClosetItemProjection } from './closetItemProjection';
import { isPrivateSlot } from '../types/privateDressingRoomComposition';
import type { PrivateDressingRoomSlot } from '../types/privateDressingRoomComposition';

/** Which projection field decided the slot. Surfaced for evidence, not for UI. */
export type SlotClassificationSource =
  | 'subtype'
  | 'clothingType'
  | 'category'
  | 'title'
  | 'none';

export type SlotClassification = {
  /** null when nothing in the record maps to a slot this workspace composes. */
  primarySlot: PrivateDressingRoomSlot | null;
  /**
   * Other slots this item could legitimately fill, in deterministic preference
   * order. Used ONLY to retry an anchor whose primary slot yields no outfit —
   * never to quietly re-role a supporting garment.
   */
  secondarySlots: PrivateDressingRoomSlot[];
  source: SlotClassificationSource;
  /** True when the slot came from the bounded legacy title fallback. */
  fallback: boolean;
  /** Set only when primarySlot is null. */
  unsupportedReason: 'unclassified' | 'unsupported_role' | 'invalid_item' | null;
};

const UNSUPPORTED: SlotClassification = Object.freeze({
  primarySlot: null,
  secondarySlots: Object.freeze([]) as PrivateDressingRoomSlot[],
  source: 'none',
  fallback: false,
  unsupportedReason: 'unclassified',
});

/**
 * Secondary eligibility.
 *
 * Deliberately sparse. A garment's role is usually unambiguous, and inventing
 * alternatives would let the composer place a coat where a shirt belongs just
 * to produce an outfit. Only genuinely dual-role cases are listed:
 *
 *   - dress → top: a long shirt-dress worn over trousers is a real styling
 *     move, and a one-piece anchor with no bottoms available is exactly the
 *     case the anchor retry exists for.
 *   - outerwear → top: a heavy knit cardigan classifies as outerwear by
 *     keyword but is worn as the top layer when nothing else is available.
 *
 * Nothing else has a secondary role. Footwear is footwear.
 */
const SECONDARY_SLOTS: Readonly<Record<PrivateDressingRoomSlot, PrivateDressingRoomSlot[]>> =
  Object.freeze({
    top: [],
    bottom: [],
    dress: ['top'],
    outerwear: ['top'],
    footwear: [],
    accessory: [],
  });

/**
 * Map a free-tier bucket onto a private slot.
 *
 * `bag` and `other` deliberately do NOT map. A bag is not a garment role this
 * workspace composes around in Phase 2, and `other` means classification
 * failed — placing it somewhere plausible-looking would put an unidentified
 * object in the user's outfit and call it a top.
 */
function slotForBucket(bucket: string): PrivateDressingRoomSlot | null {
  return isPrivateSlot(bucket) ? bucket : null;
}

/** Consult one taxonomy value, returning a slot only on a confident match. */
function classifyValue(value: string | null | undefined): PrivateDressingRoomSlot | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return slotForBucket(bucketForCategory(text));
}

/**
 * Classify one projected Closet item.
 *
 * PRECEDENCE: subtype → clothingType → category → bounded title fallback.
 * Structured taxonomy always wins; the title is consulted only when every
 * structured field is absent or unrecognised, because a title is user- or
 * model-authored prose ("Summer favourite") and matching it against garment
 * keywords is a guess that should never override a real classification.
 */
export function classifyClosetItemSlot(
  item: ClosetItemProjection | null | undefined,
): SlotClassification {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
    return { ...UNSUPPORTED, unsupportedReason: 'invalid_item' };
  }

  const ordered: Array<[SlotClassificationSource, string | null]> = [
    ['subtype', item.subtype],
    ['clothingType', item.clothingType],
    ['category', item.category],
  ];

  // Did any structured field produce a RECOGNISED role, whether or not this
  // workspace composes around it? This is what stops a `subtype: 'Tote bag'`
  // from falling through to the title and being re-read as a garment: the
  // taxonomy was present and it was understood, so the answer is "no outfit
  // role", not "we don't know".
  let structuredRecognised = false;

  for (const [source, value] of ordered) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const bucket = bucketForCategory(value.trim());
    if (bucket === 'other') continue;
    structuredRecognised = true;
    const slot = slotForBucket(bucket);
    if (slot) {
      return {
        primarySlot: slot,
        secondarySlots: [...SECONDARY_SLOTS[slot]],
        source,
        fallback: false,
        unsupportedReason: null,
      };
    }
    // Recognised as bag/other-role. Structured taxonomy is authoritative, so we
    // stop here rather than letting a title override it.
    break;
  }

  if (structuredRecognised) {
    return { ...UNSUPPORTED, secondarySlots: [], unsupportedReason: 'unsupported_role' };
  }

  // BOUNDED LEGACY FALLBACK. Pre-taxonomy Closet records (Build 2 ships
  // `taxonomyUnknown` precisely because they exist) carry only a title. Last
  // resort, reached ONLY when no structured field was recognised at all, and
  // marked `fallback` so a caller can weigh it.
  const titleSlot = classifyValue(item.title);
  if (titleSlot) {
    return {
      primarySlot: titleSlot,
      secondarySlots: [...SECONDARY_SLOTS[titleSlot]],
      source: 'title',
      fallback: true,
      unsupportedReason: null,
    };
  }

  return { ...UNSUPPORTED, secondarySlots: [], unsupportedReason: 'unclassified' };
}

export type ClassifiedClosetItem = {
  item: ClosetItemProjection;
  classification: SlotClassification;
};

/**
 * Classify a projection list, keeping only items with a usable slot.
 *
 * Order is preserved: the caller (the composer) owns deterministic ordering and
 * must not have it decided here.
 */
export function classifyClosetItems(
  items: readonly ClosetItemProjection[] | null | undefined,
): ClassifiedClosetItem[] {
  if (!Array.isArray(items)) return [];
  const out: ClassifiedClosetItem[] = [];
  for (const item of items) {
    const classification = classifyClosetItemSlot(item);
    if (!classification.primarySlot) continue;
    out.push({ item, classification });
  }
  return out;
}

/**
 * Every slot an item may occupy, primary first. Empty when unsupported.
 * The anchor retry walks this in order.
 */
export function eligibleSlotsFor(classification: SlotClassification): PrivateDressingRoomSlot[] {
  if (!classification.primarySlot) return [];
  const slots: PrivateDressingRoomSlot[] = [classification.primarySlot];
  for (const slot of classification.secondarySlots) {
    if (!slots.includes(slot)) slots.push(slot);
  }
  return slots;
}
