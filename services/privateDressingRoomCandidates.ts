/**
 * Eligible Closet alternatives for one slot of one effective look.
 *
 * PURE. No filesystem, no network, no React, no mutation of the Closet, the
 * composition or the look. Given the effective look, a target slot and the
 * actor's current projections, it returns up to 20 ranked alternatives or a
 * typed reason there are none.
 *
 * COMPLEXITY IS DELIBERATELY LINEARITHMIC, and this is the property that keeps
 * the slot editor responsive on a large Closet:
 *
 *     eligibility filter   O(n)      one pass, bounded taxonomy checks per item
 *     candidate scoring    O(n · k)  k = occupied slots in THIS look, k ≤ 6
 *     sort                 O(n log n)
 *     cap                  20
 *
 * Each candidate is scored against the bounded items of the current effective
 * look — never against every other Closet item. There is no combination search
 * here at all: the Phase 2 beam search is not invoked, because replacing one
 * garment is not a re-composition.
 *
 * STRICTER THAN PHASE 2 ON PURPOSE. The composer may place a cardigan in `top`
 * via its verified secondary classification; a Phase 3 SWAP may not, because
 * doing so would change the look's structural template while claiming to have
 * changed one slot. Category transformations (top↔dress, dress↔separates) are
 * multi-slot mutations and are outside this phase entirely.
 */

import { classifyClosetItemSlot } from './privateDressingRoomSlots';
import type { ClosetItemProjection } from './closetItemProjection';
import { scoreColorPair, occasionGroupFor } from './privateDressingRoomComposer';
import { PRIVATE_INTERACTION_BOUNDS } from '../types/privateDressingRoomInteraction';
import type { PrivateSlotEditCode } from '../types/privateDressingRoomInteraction';
import type { PrivateDressingRoomSlot } from '../types/privateDressingRoomComposition';
import type { EffectiveLook } from './privateDressingRoomEffectiveLook';

export type SlotCandidate = {
  closetItemId: string;
  item: ClosetItemProjection;
  /** Rank score, exposed for evidence and tests. Never rendered. */
  score: number;
};

export type SlotCandidateResult = {
  code: PrivateSlotEditCode;
  slot: PrivateDressingRoomSlot | null;
  /** The item this slot shows right now, or null when the slot is missing. */
  currentClosetItemId: string | null;
  /** True when the slot currently carries a user override. */
  overridden: boolean;
  /** True when this operation would FILL an explicitly missing slot. */
  fills: boolean;
  candidates: SlotCandidate[];
  /** Diagnostics for the performance harness. */
  scanned: number;
  eligible: number;
};

function failure(code: PrivateSlotEditCode, slot: PrivateDressingRoomSlot | null = null): SlotCandidateResult {
  return {
    code,
    slot,
    currentClosetItemId: null,
    overridden: false,
    fills: false,
    candidates: [],
    scanned: 0,
    eligible: 0,
  };
}

/**
 * STRICT slot matching for a swap.
 *
 * A candidate qualifies only when its PRIMARY classification is the target
 * slot. Secondary classifications are deliberately not consulted: they exist so
 * the composer can build a whole outfit around an awkward anchor, and using
 * them here would let a dress arrive in `top` and quietly turn a one-piece look
 * into separates.
 *
 * This is also the INHERITED-CLASSIFIER GUARD required by Phase 3. The shared
 * free-tier matcher is substring-based ('capsule' contains 'cap'), so a stray
 * candidate can reach a slot on a false positive. The private classifier
 * records WHICH field decided, and a title-derived match is refused for a swap
 * whenever structured taxonomy exists on the record and disagrees — the shared
 * classifier itself is left untouched.
 */
function qualifiesForSlot(
  item: ClosetItemProjection,
  slot: PrivateDressingRoomSlot,
): boolean {
  const classification = classifyClosetItemSlot(item);
  if (classification.primarySlot !== slot) return false;
  if (!classification.fallback) return true;
  // A title-only guess is accepted ONLY when the record genuinely carries no
  // structured taxonomy to contradict it.
  return item.taxonomyUnknown === true;
}

/**
 * Per-candidate score.
 *
 * Bounded by the current look's occupied slots (k ≤ 6), never by Closet size.
 * The ordering contract is encoded in the weights: completeness impact outranks
 * occasion, occasion outranks colour, colour outranks material, and
 * `closetItemId` is the final deterministic tie-break applied at sort time.
 */
function scoreCandidate(
  candidate: ClosetItemProjection,
  look: EffectiveLook,
  targetSlot: PrivateDressingRoomSlot,
  fills: boolean,
  occasionGroup: string,
  byId: ReadonlyMap<string, ClosetItemProjection>,
): number {
  let score = 0;

  // 2. Whole-look completeness impact: filling a genuinely missing slot is the
  //    single most valuable thing a swap can do.
  if (fills) score += 100;

  // 3. Occasion compatibility, read from garment TYPE only — a projection
  //    carries no occasion metadata, and no dress code is invented.
  if (occasionGroup !== 'neutral') {
    const text = [candidate.subtype, candidate.clothingType, candidate.category, candidate.title]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    if (occasionGroup === 'evening' && /heel|loafer|silk|dress|blazer|oxford/.test(text)) score += 20;
    if (occasionGroup === 'casual' && /sneaker|jean|tee|knit|short|flat/.test(text)) score += 20;
    if (occasionGroup === 'work' && /blazer|trouser|loafer|shirt|oxford/.test(text)) score += 20;
    if (occasionGroup === 'travel' && /sneaker|knit|jean|boot/.test(text)) score += 20;
    if (occasionGroup === 'smart_casual' && /loafer|boot|knit|blazer/.test(text)) score += 20;
  }

  // 4. Colour compatibility against the REST of the effective look — the slot
  //    being replaced is excluded, since it is on its way out.
  let colour = 0;
  let pairs = 0;
  for (const item of look.items) {
    if (item.slot === targetSlot) continue;
    const placed = byId.get(item.closetItemId) ?? null;
    colour += scoreColorPair(candidate.primaryColor, placed?.primaryColor ?? null);
    pairs += 1;
  }
  score += pairs > 0 ? (colour / pairs) * 3 : 0;

  // 5. Material presence is the weakest signal; absence is neutral, never a
  //    penalty, and nothing is rejected on it.
  if (Array.isArray(candidate.material) && candidate.material.length > 0) score += 1;

  return score;
}

/**
 * Rank eligible alternatives for one slot.
 *
 * @param input.anchorClosetItemId the session anchor. When it occupies the
 *   target slot the slot is LOCKED: the anchor changes only through the Phase 1
 *   anchor action, never through a swap that would silently rewrite session
 *   context.
 */
export function rankSlotCandidates(input: {
  look: EffectiveLook | null | undefined;
  slot: PrivateDressingRoomSlot;
  closetItems: readonly ClosetItemProjection[];
  closetOk?: boolean;
  anchorClosetItemId?: string | null;
  occasion?: string | null;
  isActorCurrent?: () => boolean;
}): SlotCandidateResult {
  if (typeof input?.isActorCurrent === 'function' && !input.isActorCurrent()) {
    return failure('ACTOR_CHANGED');
  }
  const look = input?.look;
  if (!look || !Array.isArray(look.items) || !input.slot) return failure('INVALID_INPUT');
  if (input.closetOk === false) return failure('CLOSET_LOAD_FAILED', input.slot);
  const closetItems = Array.isArray(input.closetItems) ? input.closetItems : [];

  const occupied = look.items.find((item) => item.slot === input.slot) ?? null;
  const missing = look.missingSlots.includes(input.slot);
  // A slot that is neither occupied nor explicitly missing is not editable:
  // adding it would be a structural change rather than a swap.
  if (!occupied && !missing) return failure('SLOT_NOT_EDITABLE', input.slot);

  const anchorId = input.anchorClosetItemId ?? null;
  if (occupied && anchorId && occupied.closetItemId === anchorId) {
    return { ...failure('ANCHOR_LOCKED', input.slot), currentClosetItemId: occupied.closetItemId };
  }

  // Built per call and passed explicitly. No module-level mutable state: two
  // concurrent rankings must not be able to see each other's Closet.
  const byId = new Map<string, ClosetItemProjection>();
  for (const item of closetItems) {
    if (item && typeof item.id === 'string') byId.set(item.id, item);
  }

  // Everything already worn in this look, so a garment cannot be offered into a
  // second slot at the same time.
  const usedElsewhere = new Set<string>();
  for (const item of look.items) {
    if (item.slot !== input.slot) usedElsewhere.add(item.closetItemId);
  }

  const currentId = occupied?.closetItemId ?? null;
  const occasionGroup = occasionGroupFor(input.occasion ?? null);
  const fills = !occupied && missing;

  // ── O(n) eligibility pass ──────────────────────────────────────────────────
  const eligible: SlotCandidate[] = [];
  for (const item of closetItems) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    if (item.id === currentId) continue;
    if (anchorId && item.id === anchorId) continue;
    if (usedElsewhere.has(item.id)) continue;
    if (!qualifiesForSlot(item, input.slot)) continue;
    eligible.push({
      closetItemId: item.id,
      item,
      score: scoreCandidate(item, look, input.slot, fills, occasionGroup, byId),
    });
  }

  // ── O(n log n) deterministic order, THEN the cap ───────────────────────────
  eligible.sort(
    (a, b) =>
      b.score - a.score ||
      (a.closetItemId < b.closetItemId ? -1 : a.closetItemId > b.closetItemId ? 1 : 0),
  );
  const candidates = eligible.slice(0, PRIVATE_INTERACTION_BOUNDS.maxCandidates);

  return {
    code: candidates.length > 0 ? 'READY' : 'NO_CANDIDATES',
    slot: input.slot,
    currentClosetItemId: currentId,
    overridden: occupied?.overridden ?? false,
    fills,
    candidates,
    scanned: closetItems.length,
    eligible: eligible.length,
  };
}

/**
 * Is this candidate still a legal choice for this slot, right now?
 *
 * Re-run immediately before an apply commits. The candidate list the user is
 * looking at was computed earlier, and the Closet may have changed underneath
 * it — so eligibility is proven again rather than trusted.
 */
export function isCandidateStillEligible(input: {
  look: EffectiveLook | null | undefined;
  slot: PrivateDressingRoomSlot;
  candidateClosetItemId: string;
  closetItems: readonly ClosetItemProjection[];
  anchorClosetItemId?: string | null;
}): boolean {
  const result = rankSlotCandidates({
    look: input.look,
    slot: input.slot,
    closetItems: input.closetItems,
    anchorClosetItemId: input.anchorClosetItemId,
  });
  if (result.code !== 'READY') return false;
  return result.candidates.some(
    (candidate) => candidate.closetItemId === input.candidateClosetItemId,
  );
}
