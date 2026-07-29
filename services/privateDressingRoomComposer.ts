/**
 * Deterministic local outfit composition for the private Dressing Room.
 *
 * PURE. No filesystem, no network, no React, no record mutation. It is handed a
 * session context and an already-loaded typed Closet result, and returns ranked
 * looks or a typed reason there are none. No remote call is authorized in this
 * phase and none is made.
 *
 * WHAT IT WILL NOT DO, because a styling tool that does any of them is lying:
 *   - invent a garment the user does not own
 *   - show the same outfit twice to fill a third card
 *   - strip a garment out of a complete outfit to manufacture a variant
 *   - claim a slot is missing when the Closet simply failed to load
 *
 * COMPLEXITY. Candidate pools are scored, sorted and only THEN capped
 * (20/20/15/12/15/10 by slot). Assembly is a bounded beam search: at most 100
 * intermediate combinations survive each expansion and at most 2,500 states are
 * ever scored, after which assembly stops with whatever it has. Worst case is
 * therefore O(maxScoredStates) scoring operations regardless of Closet size —
 * a 10,000-item Closet costs the same assembly work as a 100-item one, and only
 * the initial per-item classification and sort scale with input.
 */

import {
  isNeutralColor,
  colorFamily,
} from './free-tier/outfitGenerator';
import { getClosetItemProjections } from './closetItemProjection';
import type { ClosetItemProjection } from './closetItemProjection';
import { classifyClosetItemSlot, eligibleSlotsFor } from './privateDressingRoomSlots';
import type { SlotClassification } from './privateDressingRoomSlots';
import {
  PRIVATE_CORE_SLOT_SETS,
  PRIVATE_OPTIONAL_SLOTS,
} from '../types/privateDressingRoomComposition';
import type {
  PrivateComposerCode,
  PrivateDressingRoomLookOption,
  PrivateDressingRoomOutfitItem,
  PrivateDressingRoomLookLabelCode,
  PrivateDressingRoomSlot,
  PrivateOccasionGroup,
} from '../types/privateDressingRoomComposition';
import { createLookId, normalizeOccasionKey } from './privateDressingRoomCompositionSchema';

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Hard maxima. The implementation may use less; it may never use more. */
export const COMPOSER_LIMITS = Object.freeze({
  candidateCaps: Object.freeze({
    top: 20,
    bottom: 20,
    dress: 15,
    outerwear: 12,
    footwear: 15,
    accessory: 10,
  } as Record<PrivateDressingRoomSlot, number>),
  /** Intermediate combinations retained after each expansion. */
  beamWidth: 100,
  /** Total combinations ever scored, across every expansion. */
  maxScoredStates: 2500,
  maxLooks: 3,
});

// ── Occasion table ───────────────────────────────────────────────────────────

/**
 * Verified occasion values → soft formality group.
 *
 * Sources: types/fashionReasoning.ts#OUTFIT_OCCASIONS (casual, work, date,
 * event, travel, other), the private route's own chips (Work, Dinner, Weekend,
 * Event, Travel), and free-tier/dailyStylePrompt.ts (office, business, smart,
 * brunch, relaxed). Anything not listed is `neutral` — the user's typed text is
 * never replaced, only mapped for RANKING.
 */
const OCCASION_GROUPS: Readonly<Record<string, PrivateOccasionGroup>> = Object.freeze({
  casual: 'casual',
  weekend: 'casual',
  brunch: 'casual',
  relaxed: 'casual',
  smart: 'smart_casual',
  work: 'work',
  office: 'work',
  business: 'work',
  date: 'evening',
  dinner: 'evening',
  event: 'evening',
  travel: 'travel',
  other: 'neutral',
});

export function occasionGroupFor(occasion: string | null | undefined): PrivateOccasionGroup {
  const key = normalizeOccasionKey(occasion);
  if (!key) return 'neutral';
  if (OCCASION_GROUPS[key]) return OCCASION_GROUPS[key];
  // A multi-word occasion still matches on a contained verified token, so
  // "work dinner" ranks as evening rather than falling to neutral.
  for (const token of key.split(' ')) {
    if (OCCASION_GROUPS[token]) return OCCASION_GROUPS[token];
  }
  return 'neutral';
}

// ── Colour model ─────────────────────────────────────────────────────────────

type ColorClass = { kind: 'neutral' } | { kind: 'family'; family: string } | { kind: 'unknown' };

const WARM = new Set(['red', 'orange', 'yellow', 'pink']);
const COOL = new Set(['green', 'blue', 'purple']);
/** Conservative, and only pairs the repository's own families can express. */
const COMPLEMENTS = new Set(['blue|orange', 'orange|blue', 'yellow|purple', 'purple|yellow']);

/**
 * Classify a colour using the repository's verified vocabulary
 * (services/free-tier/outfitGenerator.ts), never a parallel one.
 *
 * ABSENCE IS `unknown`, NOT NEUTRAL. `isNeutralColor` answers true for a
 * missing colour deliberately — it exists to avoid BLOCKING a pairing — but
 * scoring an unknown colour as a confident neutral match would invent evidence.
 */
export function classifyColor(color: string | null | undefined): ColorClass {
  if (typeof color !== 'string' || !color.trim()) return { kind: 'unknown' };
  const family = colorFamily(color);
  if (family) return { kind: 'family', family };
  if (isNeutralColor(color)) return { kind: 'neutral' };
  return { kind: 'unknown' };
}

/**
 * Bounded, NEVER NEGATIVE pair score. Colour can promote a look; it can never
 * demote or disqualify one, so a bold combination is ranked lower than a safe
 * one without being called wrong.
 */
export function scoreColorPair(a: string | null | undefined, b: string | null | undefined): number {
  const left = classifyColor(a);
  const right = classifyColor(b);
  if (left.kind === 'unknown' || right.kind === 'unknown') return 0;
  if (left.kind === 'neutral' && right.kind === 'neutral') return 3;
  if (left.kind === 'neutral' || right.kind === 'neutral') return 2;
  if (left.family === right.family) return 2;
  if (COMPLEMENTS.has(`${left.family}|${right.family}`)) return 1;
  if (
    (WARM.has(left.family) && WARM.has(right.family)) ||
    (COOL.has(left.family) && COOL.has(right.family))
  ) {
    return 1;
  }
  return 0;
}

// ── Material / layering ──────────────────────────────────────────────────────

const HEAVY_MATERIALS = ['wool', 'leather', 'denim', 'shearling', 'tweed', 'fleece', 'down'];

function isHeavy(item: ClosetItemProjection): boolean {
  const values = [...(item.material ?? [])].map((m) => m.toLowerCase());
  return values.some((value) => HEAVY_MATERIALS.some((heavy) => value.includes(heavy)));
}

function hasMaterial(item: ClosetItemProjection): boolean {
  return Array.isArray(item.material) && item.material.length > 0;
}

/**
 * Low-weight layering signal. Missing material is NEUTRAL, never a penalty, and
 * nothing here rejects a look — weather is not inferred and cannot be.
 */
function scoreLayering(bySlot: Map<PrivateDressingRoomSlot, ClosetItemProjection>): number {
  const outer = bySlot.get('outerwear');
  const top = bySlot.get('top');
  if (!outer || !top) return 0;
  if (!hasMaterial(outer) || !hasMaterial(top)) return 0;
  // Two heavy core layers doing the same job is the one combination worth
  // ranking below its alternatives.
  if (isHeavy(outer) && isHeavy(top)) return 0;
  return 1;
}

// ── Occasion affinity ────────────────────────────────────────────────────────

function taxonomyText(item: ClosetItemProjection): string {
  return [item.subtype, item.clothingType, item.category, item.title]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * Soft occasion affinity. Additive hints only — a Closet projection carries no
 * occasion metadata, so this reads garment TYPE and nothing more, and it never
 * makes a structurally valid look ineligible. Deliberately no dress codes:
 * "work requires closed-toe shoes" is an opinion no repository rule supports.
 */
function scoreOccasion(
  group: PrivateOccasionGroup,
  bySlot: Map<PrivateDressingRoomSlot, ClosetItemProjection>,
): number {
  if (group === 'neutral') return 0;
  let score = 0;
  const footwear = bySlot.get('footwear');
  const bottom = bySlot.get('bottom');
  const shoes = footwear ? taxonomyText(footwear) : '';
  const legs = bottom ? taxonomyText(bottom) : '';
  const hasOuter = bySlot.has('outerwear');
  const isOnePiece = bySlot.has('dress');

  if (group === 'evening') {
    if (isOnePiece) score += 2;
    if (/heel|loafer|oxford|pump|dress shoe/.test(shoes)) score += 2;
    if (hasOuter) score += 1;
  } else if (group === 'casual') {
    if (/sneaker|trainer|flat|sandal/.test(shoes)) score += 2;
    if (/jean|short|chino|legging/.test(legs)) score += 1;
  } else if (group === 'work') {
    if (hasOuter) score += 2;
    if (/loafer|heel|oxford|boot|pump/.test(shoes)) score += 1;
  } else if (group === 'travel') {
    if (/sneaker|trainer|boot|flat/.test(shoes)) score += 2;
    if (hasOuter) score += 1;
  } else if (group === 'smart_casual') {
    if (hasOuter) score += 1;
    if (/loafer|boot|flat/.test(shoes)) score += 1;
  }
  return score;
}

// ── Input / output ───────────────────────────────────────────────────────────

export type ComposerSessionContext = {
  actorId: string | null;
  sessionId: string;
  status: string;
  anchorClosetItemId?: string | null;
  occasion?: string | null;
};

export type ComposerClosetInput = {
  ok: boolean;
  items: unknown[];
  code?: string;
};

export type ComposerResult = {
  code: PrivateComposerCode;
  looks: PrivateDressingRoomLookOption[];
  /** Diagnostics for evidence and tests. Never rendered raw. */
  scoredStates: number;
  anchorSlot: PrivateDressingRoomSlot | null;
};

function fail(code: PrivateComposerCode): ComposerResult {
  return { code, looks: [], scoredStates: 0, anchorSlot: null };
}

// ── Candidate pools ──────────────────────────────────────────────────────────

type Candidate = {
  item: ClosetItemProjection;
  classification: SlotClassification;
  score: number;
};

/**
 * Per-item affinity used ONLY to order and cap a pool.
 *
 * Deliberately independent of the other garments chosen, so pool order is
 * stable across every combination that consults it — which is what makes the
 * whole search reproducible.
 */
function candidateScore(
  item: ClosetItemProjection,
  classification: SlotClassification,
  anchor: ClosetItemProjection | null,
  group: PrivateOccasionGroup,
): number {
  let score = 0;
  if (anchor) score += scoreColorPair(anchor.primaryColor, item.primaryColor);
  // A structured classification is better evidence than a title guess.
  if (!classification.fallback) score += 1;
  if (group !== 'neutral') {
    const text = taxonomyText(item);
    if (group === 'evening' && /heel|loafer|silk|dress|blazer/.test(text)) score += 1;
    if (group === 'casual' && /sneaker|jean|tee|knit|short/.test(text)) score += 1;
    if (group === 'work' && /blazer|trouser|loafer|shirt/.test(text)) score += 1;
    if (group === 'travel' && /sneaker|knit|jean|boot/.test(text)) score += 1;
  }
  return score;
}

/**
 * Build the per-slot candidate pools.
 *
 * ORDER BEFORE CAP, always. Sorting after capping would make the cap decide
 * which garments exist, and object iteration order would leak into the result.
 * The final tie-break is `closetItemId` ascending, so two items with identical
 * scores always resolve the same way.
 */
function buildPools(
  classified: Array<{ item: ClosetItemProjection; classification: SlotClassification }>,
  anchor: ClosetItemProjection | null,
  anchorId: string | null,
  group: PrivateOccasionGroup,
): Map<PrivateDressingRoomSlot, Candidate[]> {
  const pools = new Map<PrivateDressingRoomSlot, Candidate[]>();
  for (const entry of classified) {
    if (anchorId && entry.item.id === anchorId) continue;
    for (const slot of eligibleSlotsFor(entry.classification)) {
      const list = pools.get(slot) ?? [];
      list.push({
        item: entry.item,
        classification: entry.classification,
        score: candidateScore(entry.item, entry.classification, anchor, group),
      });
      pools.set(slot, list);
    }
  }
  for (const [slot, list] of pools) {
    list.sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
    pools.set(slot, list.slice(0, COMPOSER_LIMITS.candidateCaps[slot]));
  }
  return pools;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

type PartialLook = {
  bySlot: Map<PrivateDressingRoomSlot, ClosetItemProjection>;
  score: number;
};

function lookKey(bySlot: Map<PrivateDressingRoomSlot, ClosetItemProjection>): string {
  return [...bySlot.values()]
    .map((item) => item.id)
    .sort()
    .join('+');
}

function scorePartial(
  bySlot: Map<PrivateDressingRoomSlot, ClosetItemProjection>,
  group: PrivateOccasionGroup,
): number {
  const items = [...bySlot.values()];
  let color = 0;
  let pairs = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      color += scoreColorPair(items[i].primaryColor, items[j].primaryColor);
      pairs += 1;
    }
  }
  // Averaged so a four-item look is not mechanically preferred over a
  // three-item one purely for having more pairs to score.
  const colorScore = pairs > 0 ? color / pairs : 0;
  // WEIGHTS ENCODE THE RANKING CONTRACT: occasion outranks colour, colour
  // outranks layering, and none of them can outrank completeness — which is
  // applied at selection time, not here.
  return scoreOccasion(group, bySlot) * 10 + colorScore * 3 + scoreLayering(bySlot);
}

type AssemblyOutcome = {
  complete: PartialLook[];
  partial: PartialLook[];
  scoredStates: number;
};

/**
 * Bounded beam search over one core structure.
 *
 * Bases first (top+bottom, or dress), then footwear, then the optional slots.
 * Every stage ranks and truncates to `beamWidth`, and the global scored-state
 * budget is checked before each score so assembly can never run away.
 */
function assemble(
  structure: readonly PrivateDressingRoomSlot[],
  pools: Map<PrivateDressingRoomSlot, Candidate[]>,
  pinned: Map<PrivateDressingRoomSlot, ClosetItemProjection>,
  group: PrivateOccasionGroup,
  budget: { scored: number },
): AssemblyOutcome {
  const complete: PartialLook[] = [];
  const partial: PartialLook[] = [];

  let beam: PartialLook[] = [{ bySlot: new Map(pinned), score: 0 }];
  let reachedAll = true;

  const expand = (slot: PrivateDressingRoomSlot, required: boolean) => {
    if (pinned.has(slot)) return true;
    const pool = pools.get(slot) ?? [];
    if (pool.length === 0) {
      if (required) reachedAll = false;
      return !required;
    }
    const next: PartialLook[] = [];
    const seen = new Set<string>();
    for (const state of beam) {
      // An optional slot may also be declined, so a look without a coat still
      // competes rather than being forced to carry one.
      const branches: Array<ClosetItemProjection | null> = required ? [] : [null];
      for (const candidate of pool) branches.push(candidate.item);
      for (const choice of branches) {
        if (budget.scored >= COMPOSER_LIMITS.maxScoredStates) break;
        const bySlot = new Map(state.bySlot);
        if (choice) {
          if ([...bySlot.values()].some((item) => item.id === choice.id)) continue;
          bySlot.set(slot, choice);
        }
        const key = lookKey(bySlot);
        if (seen.has(key)) continue;
        seen.add(key);
        budget.scored += 1;
        next.push({ bySlot, score: scorePartial(bySlot, group) });
      }
      if (budget.scored >= COMPOSER_LIMITS.maxScoredStates) break;
    }
    if (next.length === 0) {
      if (required) reachedAll = false;
      return !required;
    }
    next.sort((a, b) => b.score - a.score || (lookKey(a.bySlot) < lookKey(b.bySlot) ? -1 : 1));
    beam = next.slice(0, COMPOSER_LIMITS.beamWidth);
    return true;
  };

  for (const slot of structure) {
    if (!expand(slot, true)) {
      // The structure cannot be satisfied. Whatever the beam holds is the
      // MAXIMAL valid combination for this shape, and is offered as partial
      // only if nothing complete exists anywhere.
      for (const state of beam) partial.push(state);
      return { complete, partial, scoredStates: budget.scored };
    }
  }

  if (reachedAll) {
    for (const slot of PRIVATE_OPTIONAL_SLOTS) expand(slot, false);
    for (const state of beam) complete.push(state);
  }
  return { complete, partial, scoredStates: budget.scored };
}

// ── Look construction ────────────────────────────────────────────────────────

function missingSlotsFor(
  bySlot: Map<PrivateDressingRoomSlot, ClosetItemProjection>,
): PrivateDressingRoomSlot[] {
  // Report against the core structure this look came CLOSEST to satisfying, so
  // a top+bottom look is missing shoes rather than "a dress".
  let best: readonly PrivateDressingRoomSlot[] = PRIVATE_CORE_SLOT_SETS[0];
  let bestFilled = -1;
  for (const structure of PRIVATE_CORE_SLOT_SETS) {
    const filled = structure.filter((slot) => bySlot.has(slot)).length;
    if (filled > bestFilled) {
      bestFilled = filled;
      best = structure;
    }
  }
  return best.filter((slot) => !bySlot.has(slot));
}

function labelsFor(
  bySlot: Map<PrivateDressingRoomSlot, ClosetItemProjection>,
  complete: boolean,
  group: PrivateOccasionGroup,
): PrivateDressingRoomLookLabelCode[] {
  const labels: PrivateDressingRoomLookLabelCode[] = [];
  // Every garment is one the user already owns — that is the whole premise.
  if (complete) labels.push('NO_PURCHASE_NEEDED');
  else labels.push('PARTIAL_LOOK');

  const items = [...bySlot.values()];
  const allNeutral =
    items.length > 0 && items.every((item) => classifyColor(item.primaryColor).kind === 'neutral');

  // Labels are only applied where the SCORING justifies them.
  if (group === 'evening' && scoreOccasion('evening', bySlot) >= 2) labels.push('EVENING_OPTION');
  else if (group === 'work' && scoreOccasion('work', bySlot) >= 2) labels.push('MORE_POLISHED');
  else if (group === 'casual' && scoreOccasion('casual', bySlot) >= 2) labels.push('MORE_CASUAL');
  else if (allNeutral) labels.push('NEUTRAL_OPTION');

  return labels;
}

function toLook(
  state: PartialLook,
  sessionId: string,
  complete: boolean,
  group: PrivateOccasionGroup,
  rank: number,
): PrivateDressingRoomLookOption {
  const items: PrivateDressingRoomOutfitItem[] = [];
  for (const slot of ['outerwear', 'top', 'dress', 'bottom', 'footwear', 'accessory'] as const) {
    const item = state.bySlot.get(slot);
    if (item) items.push({ slot, closetItemId: item.id });
  }
  return {
    lookId: createLookId(),
    sessionId,
    items,
    completeness: complete ? 'complete' : 'partial',
    missingSlots: complete ? [] : missingSlotsFor(state.bySlot),
    labelCodes: labelsFor(state.bySlot, complete, group),
    rank,
  };
}

/**
 * Pick up to three MEANINGFULLY DISTINCT looks.
 *
 * Distinctness is by garment set, so the same outfit in a different order is
 * the same outfit. Beyond that, a candidate must differ from everything already
 * chosen by at least one NON-ANCHOR garment — otherwise three cards would show
 * the same styling decision with one accessory swapped.
 *
 * Deterministic throughout: no shuffling, and ties resolve on the canonical
 * sorted item-id set.
 */
function selectDistinct(
  states: PartialLook[],
  anchorId: string | null,
): PartialLook[] {
  const ordered = [...states].sort(
    (a, b) => b.score - a.score || (lookKey(a.bySlot) < lookKey(b.bySlot) ? -1 : 1),
  );
  const chosen: PartialLook[] = [];
  const seenSets = new Set<string>();

  const nonAnchorIds = (state: PartialLook) =>
    new Set(
      [...state.bySlot.values()].map((item) => item.id).filter((id) => id !== anchorId),
    );

  for (const state of ordered) {
    if (chosen.length >= COMPOSER_LIMITS.maxLooks) break;
    const key = lookKey(state.bySlot);
    if (seenSets.has(key)) continue;
    const candidateIds = nonAnchorIds(state);
    const distinctEnough = chosen.every((existing) => {
      const existingIds = nonAnchorIds(existing);
      for (const id of candidateIds) if (!existingIds.has(id)) return true;
      for (const id of existingIds) if (!candidateIds.has(id)) return true;
      return false;
    });
    if (!distinctEnough) continue;
    seenSets.add(key);
    chosen.push(state);
  }
  return chosen;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Compose 1–3 looks, or explain why there are none.
 *
 * The session is composition-ready when it carries EITHER a valid anchor OR a
 * non-empty occasion — both is not required, and neither means there is nothing
 * to compose around yet.
 */
export function composePrivateOutfits(input: {
  session: ComposerSessionContext;
  closet: ComposerClosetInput;
  isActorCurrent?: () => boolean;
}): ComposerResult {
  const session = input?.session;
  if (!session || typeof session.sessionId !== 'string' || !session.sessionId) {
    return fail('INVALID_INPUT');
  }
  if (typeof input.isActorCurrent === 'function' && !input.isActorCurrent()) {
    return fail('ACTOR_CHANGED');
  }
  if (session.status !== 'active') return fail('SESSION_CONTEXT_REQUIRED');

  const closet = input.closet;
  if (!closet || typeof closet !== 'object' || !Array.isArray(closet.items)) {
    return fail('INVALID_INPUT');
  }
  // A Closet that failed to load is NOT an empty Closet, and must never be
  // reported as one — that is the distinction Stage 1 exists to make.
  if (!closet.ok) return fail('CLOSET_LOAD_FAILED');

  const anchorId =
    typeof session.anchorClosetItemId === 'string' && session.anchorClosetItemId.trim()
      ? session.anchorClosetItemId.trim()
      : null;
  const occasion = typeof session.occasion === 'string' ? session.occasion : null;
  const hasOccasion = normalizeOccasionKey(occasion) !== '';
  if (!anchorId && !hasOccasion) return fail('SESSION_CONTEXT_REQUIRED');

  const projections = getClosetItemProjections(
    closet.items as Array<Record<string, unknown> | null | undefined>,
  );
  if (projections.length === 0) return fail('CLOSET_EMPTY');

  const anchor = anchorId ? projections.find((item) => item.id === anchorId) ?? null : null;
  // The anchor names a garment this actor's Closet can no longer resolve. No
  // stale metadata is reconstructed around it.
  if (anchorId && !anchor) return fail('ANCHOR_MISSING');

  const group = occasionGroupFor(occasion);
  const classified = [];
  for (const item of projections) {
    const classification = classifyClosetItemSlot(item);
    if (classification.primarySlot) classified.push({ item, classification });
  }
  if (classified.length === 0) return fail('INSUFFICIENT_ITEMS');

  const anchorClassification = anchor ? classifyClosetItemSlot(anchor) : null;
  if (anchor && anchorClassification && !anchorClassification.primarySlot) {
    return fail('UNSUPPORTED_ANCHOR');
  }

  const anchorSlots = anchorClassification ? eligibleSlotsFor(anchorClassification) : [null];
  const pools = buildPools(classified, anchor, anchorId, group);
  const budget = { scored: 0 };

  // Walk the anchor's primary slot then its verified secondaries, collecting
  // per-slot outcomes. COMPLETE LOOKS ARE SOUGHT ACROSS EVERY ELIGIBLE SLOT
  // BEFORE ANY PARTIAL IS ACCEPTED: a dress anchor with no shoes should get the
  // chance to be styled as a top with a complete outfit, rather than being
  // frozen at the first partial its primary slot happened to produce.
  const attempts: Array<{
    slot: PrivateDressingRoomSlot | null;
    complete: PartialLook[];
    partial: PartialLook[];
  }> = [];

  for (const anchorSlot of anchorSlots) {
    const pinned = new Map<PrivateDressingRoomSlot, ClosetItemProjection>();
    if (anchor && anchorSlot) pinned.set(anchorSlot, anchor);

    const complete: PartialLook[] = [];
    const partial: PartialLook[] = [];
    for (const structure of PRIVATE_CORE_SLOT_SETS) {
      // A one-piece structure cannot host a pinned top or bottom, and vice
      // versa: pinning would silently drop the anchor from the look.
      if (anchorSlot && !structure.includes(anchorSlot)) {
        const optional = (PRIVATE_OPTIONAL_SLOTS as readonly string[]).includes(anchorSlot);
        if (!optional) continue;
      }
      const outcome = assemble(structure, pools, pinned, group, budget);
      complete.push(...outcome.complete);
      partial.push(...outcome.partial);
    }
    attempts.push({ slot: anchorSlot ?? null, complete, partial });
  }

  // NO PADDING. When complete looks exist, ONLY complete looks are returned —
  // one complete look is returned as exactly one look, never topped up with
  // deliberately degraded variants of itself.
  for (const attempt of attempts) {
    if (attempt.complete.length === 0) continue;
    const chosen = selectDistinct(attempt.complete, anchorId);
    return {
      code: 'SUCCESS',
      looks: chosen.map((state, index) => toLook(state, session.sessionId, true, group, index)),
      scoredStates: budget.scored,
      anchorSlot: attempt.slot,
    };
  }

  // Only now, with no complete look available anywhere, are maximal partial
  // combinations offered — each truthfully reporting what it is missing.
  for (const attempt of attempts) {
    if (attempt.partial.length === 0) continue;
    const chosen = selectDistinct(attempt.partial, anchorId);
    const looks = chosen
      .map((state, index) => toLook(state, session.sessionId, false, group, index))
      // A "partial" look with nothing missing is not partial; drop rather than
      // mislabel it.
      .filter((look) => look.missingSlots.length > 0);
    if (looks.length > 0) {
      return {
        code: 'SUCCESS_PARTIAL',
        looks: looks.map((look, index) => ({ ...look, rank: index })),
        scoredStates: budget.scored,
        anchorSlot: attempt.slot,
      };
    }
  }

  return { code: 'INSUFFICIENT_ITEMS', looks: [], scoredStates: budget.scored, anchorSlot: null };
}
