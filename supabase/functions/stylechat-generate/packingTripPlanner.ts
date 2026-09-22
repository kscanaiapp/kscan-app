// Build 35 Packing Intelligence -- the trip-level planner (pure, deterministic).
//
// DIVISION OF LABOUR (PLANNING_ARCHITECTURE):
//   model          -- proposes a coherent look for each slot it is asked about,
//                     and says why (one call, unchanged from V1).
//   this module    -- treats the suitcase as ONE system: enforces pins,
//                     rejections, hard occasion rules and realistic reuse, then
//                     removes pieces whose role another packed piece already
//                     covers, and reports what each slot's coverage really is.
// Nothing here calls a model and nothing here can create ownership: every id it
// can place comes from `candidates`, the actor's own authorized Closet index.
//
// THE OBJECTIVE (ADD-02). Minimise unnecessary DISTINCT packed items, subject to:
// every slot keeps a viable look where the Closet allows one; explicit
// constraints and pins hold; hygiene caps hold; unknown garment facts are never
// promoted to known. Among valid choices, ties break by explicit traveller
// preference, then Signature Style, then plain heuristics.
//
// REUSE AND REDUNDANCY ARE ONE PASS (ADD-09). `consolidate` asks one question
// per packed piece: "can pieces already in the suitcase cover every look this
// piece is in?" A yes is simultaneously a reuse (the covering piece now works
// harder) and a redundancy removal (this piece stays home). There is no second
// algorithm that could disagree with it.

import type { EliseWardrobeCandidate } from './eliseAdviceTypes.ts';
import { packingGarmentClassesOf as candidateGarmentClasses } from './packingGarmentFacts.ts';
import type { PackingActivity } from './packingContract.ts';
import {
  bandDistance,
  colorsCompatible,
  formalityBandOf,
  hasWarmthEvidence,
  matchesColorPreference,
  requirementFor,
  reuseCapFor,
  sameGarmentClass,
  type PackingActivityRequirement,
  type PackingColorPreference,
  type PackingFormalityBand,
} from './packingGarmentFacts.ts';
import type { PackingRepeatDay, PackingSlot } from './packingSchedule.ts';

export type PackingSlotCoverage = 'covered' | 'unconfirmed' | 'uncovered';

export interface PackingPlannedSlot extends PackingSlot {
  itemIds: string[];
  coverage: PackingSlotCoverage;
  /** Role codes still missing, or `formality_unconfirmed`. */
  missing: string[];
  source: 'model' | 'carried' | 'filled';
}

export type PackingDecisionCode =
  | 'left_home'
  | 'rejected_removed'
  | 'pin_conflict'
  | 'hygiene_split'
  | 'repeat_worn'
  | 'laundry_assumed'
  | 'repeat_without_laundry'
  | 'formality_removed'
  | 'prefer_class_applied'
  | 'prefer_class_unavailable'
  | 'formality_adjusted'
  | 'role_filled'
  // Build 35 refinement quality.
  | 'slot_replaced'
  | 'replace_unavailable'
  | 'warmth_added'
  | 'warmth_removed'
  | 'warmth_unavailable'
  | 'max_role_applied'
  | 'max_role_conflict';

export interface PackingDecision {
  code: PackingDecisionCode;
  itemId: string | null;
  /** The piece that now covers for `itemId`, or replaced it. */
  otherItemId: string | null;
  slotIds: string[];
  garmentClass?: string | null;
  /** For `max_role_*`: the limit the traveller set. */
  limit?: number;
}

export interface PackingPlannerInput {
  slots: PackingSlot[];
  repeats: PackingRepeatDay[];
  /** Per-slot proposals already resolved through the ownership gate. */
  proposals: Map<string, string[]>;
  /** Proposals the model gave an occasion but no usable slot, in model order. */
  activityProposals: Map<PackingActivity, string[][]>;
  /** Item sets carried from verified prior state. */
  carried: Map<string, string[]>;
  /** Slots whose looks must come from `proposals`. Null means every slot. */
  regenerate: Set<string> | null;
  /** Authorized owned index (itemId -> candidate). The only source of pieces. */
  candidates: Map<string, EliseWardrobeCandidate>;
  /** Retrieval order (itemId -> rank). Deterministic final tie-break. */
  order: Map<string, number>;
  rejectedItemIds: Set<string>;
  rejectedClasses: Set<string>;
  pinnedSlotIds: Set<string>;
  pinnedItemIds: Set<string>;
  /**
   * Pieces placed by THIS refinement ("bring the loafers back"). Protected from
   * consolidation for this run only, so a restore is not undone by the same
   * request that made it. Never persisted -- unlike a pin.
   */
  protectedItemIds?: Set<string>;
  /**
   * ADD-15. True when the whole suitcase may be re-optimised (a new plan, or
   * the traveller asked to pack lighter). False for a local refinement: looks
   * this request did not touch are never rewritten merely to save a piece.
   * Defaults to true only when every slot is being generated.
   */
  rebalance?: boolean;
  preferClasses: Array<{ slotIds: string[] | null; garmentClass: string }>;
  noRepeatRoles: string[];
  rewearRoles: string[];
  explicitColor: PackingColorPreference | null;
  signatureColor: PackingColorPreference | null;
  packLight: boolean;
  laundry: 'available' | 'unavailable' | 'unknown';
  /**
   * Build 35. Pieces taken out of specific looks only ("change Friday's
   * shoes"). This run only: the look that comes back is what is carried next.
   */
  slotExclusions?: Map<string, Set<string>>;
  /** Hard colour / material exclusions. Only a piece whose OWN record says so is removed. */
  excludedColors?: string[];
  excludedMaterials?: string[];
  /** "Warmer" / "lighter layers", for these slots (null = every slot). */
  warmth?: { direction: 'warmer' | 'lighter'; slotIds: Set<string> | null } | null;
  /** Stated conditions; lighter layers never strip rain or cold protection. */
  conditions?: string[];
  /** "Only two pairs of shoes": distinct packed pieces allowed per role. */
  maxRoles?: Record<string, number>;
}

export interface PackingPlannerResult {
  slots: PackingPlannedSlot[];
  repeats: PackingRepeatDay[];
  /** Packed ids in order of first wear. */
  packedItemIds: string[];
  wears: Record<string, number>;
  decisions: PackingDecision[];
}

/** One look carries at most one of these; extras are structural noise. */
const SINGLE_PER_LOOK = new Set(['shoe', 'bottom', 'one_piece', 'outer']);
/** Consolidation order: highest-reuse roles first, where one piece most often covers many looks. */
const CONSOLIDATION_ROLES = ['shoe', 'outer', 'accessory', 'mid', 'bottom'];
const HIGH_REUSE_ROLES = new Set(['shoe', 'outer', 'accessory']);

export function planPackingTrip(input: PackingPlannerInput): PackingPlannerResult {
  const decisions: PackingDecision[] = [];
  const record = (decision: PackingDecision) => {
    const duplicate = decisions.find(
      (existing) =>
        existing.code === decision.code &&
        existing.itemId === decision.itemId &&
        existing.otherItemId === decision.otherItemId &&
        (existing.garmentClass ?? null) === (decision.garmentClass ?? null),
    );
    if (duplicate) {
      for (const slotId of decision.slotIds) {
        if (!duplicate.slotIds.includes(slotId)) duplicate.slotIds.push(slotId);
      }
      return;
    }
    decisions.push({ ...decision, slotIds: [...decision.slotIds] });
  };

  const bands = new Map<string, PackingFormalityBand | null>();
  const bandOf = (id: string): PackingFormalityBand | null => {
    if (!bands.has(id)) {
      const candidate = input.candidates.get(id);
      bands.set(id, candidate ? formalityBandOf(candidate) : null);
    }
    return bands.get(id) ?? null;
  };
  const roleOf = (id: string): string | null => input.candidates.get(id)?.layeringRole ?? null;
  const classesOf = (id: string): string[] => {
    const candidate = input.candidates.get(id);
    return candidate ? candidateGarmentClasses(candidate) : [];
  };
  const excludedColors = input.excludedColors ?? [];
  const excludedMaterials = input.excludedMaterials ?? [];
  // Positive evidence only: a piece with no recorded colour is not "black",
  // and it is not proven "not black" either. It is left in, and the copy says
  // so, rather than being guessed into either answer (unknown stays unknown).
  const hasExcludedAttribute = (id: string): boolean => {
    if (excludedColors.length === 0 && excludedMaterials.length === 0) return false;
    const candidate = input.candidates.get(id);
    if (!candidate) return false;
    const colors = candidate.colors.join(' ').toLowerCase();
    if (excludedColors.some((color) => colors.includes(color))) return true;
    const materialWords = `${candidate.materials.join(' ')} ${candidate.title ?? ''}`.toLowerCase();
    const materialTokens = materialWords.split(/[^a-z]+/);
    return excludedMaterials.some((material) => materialTokens.includes(material));
  };
  const isRejected = (id: string): boolean =>
    input.rejectedItemIds.has(id) || classesOf(id).some((cls) => input.rejectedClasses.has(cls)) ||
    hasExcludedAttribute(id);
  const slotExcluded = (slotId: string, id: string): boolean => input.slotExclusions?.get(slotId)?.has(id) ?? false;
  const capOf = (id: string): number =>
    reuseCapFor(roleOf(id), { noRepeatRoles: input.noRepeatRoles, rewearRoles: input.rewearRoles });
  const requirementOf = (slot: PackingSlot): PackingActivityRequirement =>
    requirementFor(slot.activity, slot.formalityShift);
  const isPinnedSlot = (slot: PackingSlot) => input.pinnedSlotIds.has(slot.slotId);

  // ── 1. Initial looks ──────────────────────────────────────────────────────
  const activityQueues = new Map<PackingActivity, string[][]>();
  for (const [activity, looks] of input.activityProposals) activityQueues.set(activity, [...looks]);
  const lastLookByActivity = new Map<PackingActivity, string[]>();

  const planned: PackingPlannedSlot[] = input.slots.map((slot) => {
    const regenerate = input.regenerate === null || input.regenerate.has(slot.slotId);
    let itemIds: string[] | undefined;
    let source: PackingPlannedSlot['source'] = 'model';
    if (!regenerate) {
      itemIds = input.carried.get(slot.slotId);
      source = 'carried';
    }
    if (!itemIds) {
      itemIds = input.proposals.get(slot.slotId) ?? activityQueues.get(slot.activity)?.shift();
      source = itemIds ? 'model' : 'filled';
    }
    if (!itemIds && !regenerate) {
      itemIds = input.carried.get(slot.slotId);
      source = 'carried';
    }
    // A slot the model skipped borrows an earlier look for the same occasion.
    // Hygiene caps below then split out anything that may not be re-worn.
    if (!itemIds) itemIds = lastLookByActivity.get(slot.activity);
    const known = (itemIds ?? []).filter((id) => input.candidates.has(id));
    if (known.length > 0) lastLookByActivity.set(slot.activity, known);
    return { ...slot, itemIds: [...new Set(known)], coverage: 'uncovered', missing: [], source };
  });
  const initialItems = new Map(planned.map((slot) => [slot.slotId, [...slot.itemIds]]));

  // ── 2. Rejections, occasion rules, one-per-look ───────────────────────────
  // What left each look, by role, so the stand-in chosen below can suit it.
  const removedFrom = new Map<string, string>();
  for (const slot of planned) {
    const pinned = isPinnedSlot(slot);
    const requirement = requirementOf(slot);
    const kept: string[] = [];
    const rolesSeen = new Set<string>();
    for (const id of slot.itemIds) {
      if (slotExcluded(slot.slotId, id)) {
        if (pinned) {
          record({ code: 'pin_conflict', itemId: id, otherItemId: null, slotIds: [slot.slotId] });
        } else {
          record({ code: 'slot_replaced', itemId: id, otherItemId: null, slotIds: [slot.slotId] });
          removedFrom.set(`${slot.slotId}|${roleOf(id)}`, id);
          continue;
        }
      }
      if (isRejected(id)) {
        if (pinned) {
          // ADD-04: a pin is not silently overridden. The piece stays in the
          // pinned look and the conflict is surfaced.
          record({ code: 'pin_conflict', itemId: id, otherItemId: null, slotIds: [slot.slotId] });
        } else {
          record({ code: 'rejected_removed', itemId: id, otherItemId: null, slotIds: [slot.slotId] });
          removedFrom.set(`${slot.slotId}|${roleOf(id)}`, id);
          continue;
        }
      }
      const band = bandOf(id);
      if (!pinned && band && requirement.disallowed.includes(band)) {
        record({ code: 'formality_removed', itemId: id, otherItemId: null, slotIds: [slot.slotId] });
        continue;
      }
      const role = roleOf(id);
      if (role && SINGLE_PER_LOOK.has(role)) {
        if (rolesSeen.has(role)) continue;
        rolesSeen.add(role);
      }
      kept.push(id);
    }
    slot.itemIds = kept;
  }

  // ── Shared substitute chooser ─────────────────────────────────────────────
  const wearsIn = (slots: PackingPlannedSlot[]): Map<string, number> => {
    const wears = new Map<string, number>();
    for (const slot of slots) for (const id of slot.itemIds) wears.set(id, (wears.get(id) ?? 0) + 1);
    return wears;
  };

  const allowedIn = (id: string, slot: PackingPlannedSlot): boolean => {
    if (isRejected(id) || slotExcluded(slot.slotId, id)) return false;
    const band = bandOf(id);
    return !(band && requirementOf(slot).disallowed.includes(band));
  };

  const preferenceScore = (id: string, slot: PackingPlannedSlot, original: string | null): number => {
    const candidate = input.candidates.get(id)!;
    const requirement = requirementOf(slot);
    const band = bandOf(id);
    let score = 0;
    if (band && requirement.preferred[0] === band) score += 8;
    else if (band && requirement.preferred.includes(band)) score += 5;
    if (requirement.strict && !band) score -= 30;
    if (matchesColorPreference(candidate, input.explicitColor)) score += 12;
    if (matchesColorPreference(candidate, input.signatureColor)) score += 4;
    const originalCandidate = original ? input.candidates.get(original) : null;
    if (originalCandidate && colorsCompatible(candidate, originalCandidate)) score += 3;
    if (candidate.colorFamilies.includes('neutral')) score += 1;
    return score;
  };

  const chooseSubstitute = (
    slot: PackingPlannedSlot,
    role: string,
    wears: Map<string, number>,
    options: {
      original: string | null;
      garmentClass?: string | null;
      exclude?: Set<string>;
      require?: (id: string) => boolean;
    },
  ): string | null => {
    let best: { id: string; score: number } | null = null;
    for (const [id, candidate] of input.candidates) {
      if (candidate.layeringRole !== role) continue;
      if (slot.itemIds.includes(id) || options.exclude?.has(id)) continue;
      if (options.require && !options.require(id)) continue;
      if (!allowedIn(id, slot)) continue;
      if ((wears.get(id) ?? 0) + 1 > capOf(id)) continue;
      if (options.garmentClass && !classesOf(id).includes(options.garmentClass)) continue;
      // Reuse first: a piece already in the suitcase is the trip-level win.
      const score = ((wears.get(id) ?? 0) > 0 ? 20 : 0) + preferenceScore(id, slot, options.original);
      const rank = input.order.get(id) ?? Number.MAX_SAFE_INTEGER;
      if (
        !best ||
        score > best.score ||
        (score === best.score && rank < (input.order.get(best.id) ?? Number.MAX_SAFE_INTEGER))
      ) {
        best = { id, score };
      }
    }
    return best?.id ?? null;
  };

  // ── 3. Explicit class preferences ("use sneakers instead") ────────────────
  for (const preference of input.preferClasses) {
    const owned = [...input.candidates.keys()].filter((id) => classesOf(id).includes(preference.garmentClass));
    const targets = planned.filter(
      (slot) => !isPinnedSlot(slot) && (preference.slotIds === null || preference.slotIds.includes(slot.slotId)),
    );
    if (owned.length === 0) {
      record({
        code: 'prefer_class_unavailable',
        itemId: null,
        otherItemId: null,
        slotIds: targets.map((slot) => slot.slotId),
        garmentClass: preference.garmentClass,
      });
      continue;
    }
    const role = roleOf(owned[0]);
    if (!role) continue;
    for (const slot of targets) {
      if (slot.itemIds.some((id) => classesOf(id).includes(preference.garmentClass))) continue;
      const wears = wearsIn(planned);
      const current = slot.itemIds.find((id) => roleOf(id) === role) ?? null;
      const replacement = chooseSubstitute(slot, role, wears, {
        original: current,
        garmentClass: preference.garmentClass,
      });
      if (!replacement) {
        record({
          code: 'prefer_class_unavailable',
          itemId: null,
          otherItemId: null,
          slotIds: [slot.slotId],
          garmentClass: preference.garmentClass,
        });
        continue;
      }
      slot.itemIds = [...slot.itemIds.filter((id) => id !== current), replacement];
      record({
        code: 'prefer_class_applied',
        itemId: current,
        otherItemId: replacement,
        slotIds: [slot.slotId],
        garmentClass: preference.garmentClass,
      });
    }
  }
  // ── 3b. Formality the traveller asked for ("make Friday more casual") ─────
  // The model restyles the slot; this makes the request hold even when it did
  // not. Only pieces whose band is KNOWN to be on the wrong side are swapped,
  // only for a same-role piece whose band is known to be on the right side, and
  // pieces already in the suitcase are preferred. Unknown is never guessed at.
  for (const slot of planned) {
    if (!slot.formalityShift || isPinnedSlot(slot)) continue;
    const wantLess = slot.formalityShift === 'less_formal';
    const wrongSide = (band: PackingFormalityBand | null) =>
      band !== null && (wantLess ? band === 'smart' || band === 'formal' : band === 'casual' || band === 'athletic');
    const rightSide = (band: PackingFormalityBand | null) =>
      band !== null && (wantLess ? band === 'casual' || band === 'athletic' : band === 'smart' || band === 'formal');
    for (const id of [...slot.itemIds]) {
      const role = roleOf(id);
      if (!role || !['shoe', 'outer', 'bottom'].includes(role)) continue;
      if (!wrongSide(bandOf(id)) || input.pinnedItemIds.has(id)) continue;
      const wears = wearsIn(planned);
      let best: { id: string; score: number } | null = null;
      for (const [other, candidate] of input.candidates) {
        if (candidate.layeringRole !== role || slot.itemIds.includes(other)) continue;
        if (!allowedIn(other, slot) || !rightSide(bandOf(other))) continue;
        if ((wears.get(other) ?? 0) + 1 > capOf(other)) continue;
        const score = ((wears.get(other) ?? 0) > 0 ? 20 : 0) + preferenceScore(other, slot, id);
        if (!best || score > best.score) best = { id: other, score };
      }
      if (!best) continue;
      slot.itemIds = slot.itemIds.map((existing) => (existing === id ? best!.id : existing));
      record({ code: 'formality_adjusted', itemId: id, otherItemId: best.id, slotIds: [slot.slotId] });
    }
  }

  const protectedOccurrence = new Set<string>();
  for (const slot of planned) {
    for (const id of slot.itemIds) {
      const preferred = input.preferClasses.some(
        (preference) =>
          (preference.slotIds === null || preference.slotIds.includes(slot.slotId)) &&
          classesOf(id).includes(preference.garmentClass),
      );
      if (isPinnedSlot(slot) || input.pinnedItemIds.has(id) || input.protectedItemIds?.has(id) || preferred) {
        protectedOccurrence.add(`${slot.slotId}|${id}`);
      }
    }
  }

  // ── 4. Hygiene caps (ADD-07) ──────────────────────────────────────────────
  // Chronological for a new plan. For a refinement, looks being KEPT are
  // counted first, so when a changed look pushes a piece over its cap it is the
  // changed look that gives way -- never an untouched Saturday (ADD-15).
  {
    const wears = new Map<string, number>();
    const order =
      input.regenerate === null
        ? planned
        : [...planned.filter((slot) => slot.source === 'carried'), ...planned.filter((slot) => slot.source !== 'carried')];
    const localRefinement = input.regenerate !== null && !input.rebalance;
    for (const slot of order) {
      const before = initialItems.get(slot.slotId) ?? [];
      // An untouched carried look keeps a repeat the traveller already accepted;
      // a local refinement does not quietly rewrite it to tidy an old repeat.
      const keptAsIs =
        localRefinement &&
        slot.source === 'carried' &&
        before.length === slot.itemIds.length &&
        before.every((id) => slot.itemIds.includes(id));
      for (const id of [...slot.itemIds]) {
        const next = (wears.get(id) ?? 0) + 1;
        if (next <= capOf(id) || protectedOccurrence.has(`${slot.slotId}|${id}`)) {
          wears.set(id, next);
          continue;
        }
        if (keptAsIs && !input.noRepeatRoles.includes(roleOf(id) ?? '')) {
          wears.set(id, next);
          record({ code: 'repeat_worn', itemId: id, otherItemId: null, slotIds: [slot.slotId] });
          continue;
        }
        const role = roleOf(id);
        const replacement = role
          ? chooseSubstitute(slot, role, wears, { original: id })
          : null;
        if (replacement) {
          slot.itemIds = slot.itemIds.map((existing) => (existing === id ? replacement : existing));
          wears.set(replacement, (wears.get(replacement) ?? 0) + 1);
          record({ code: 'hygiene_split', itemId: id, otherItemId: replacement, slotIds: [slot.slotId] });
        } else {
          wears.set(id, next);
          record({ code: 'repeat_worn', itemId: id, otherItemId: null, slotIds: [slot.slotId] });
        }
      }
    }
  }

  // ── 5. Fill roles a look cannot go without ────────────────────────────────
  const missingRoles = (slot: PackingPlannedSlot): string[] => {
    const roles = new Set(slot.itemIds.map(roleOf));
    const missing: string[] = [];
    if (!roles.has('shoe')) missing.push('shoe');
    if (!roles.has('one_piece')) {
      if (!roles.has('base')) missing.push('base');
      if (!roles.has('bottom')) missing.push('bottom');
    }
    return missing;
  };
  for (const slot of planned) {
    if (isPinnedSlot(slot)) continue;
    for (const role of missingRoles(slot)) {
      const replacement = chooseSubstitute(slot, role, wearsIn(planned), {
        original: removedFrom.get(`${slot.slotId}|${role}`) ?? null,
      });
      if (!replacement) continue;
      slot.itemIds.push(replacement);
      record({ code: 'role_filled', itemId: null, otherItemId: replacement, slotIds: [slot.slotId] });
    }
  }

  // ── 5b. Warmth the traveller asked for ("warmer", "lighter layers") ───────
  // Deterministic and local to the targeted looks: a warmer request adds one
  // layer to a look that has none the Closet can vouch for; it never rewrites
  // the rest of the look. Warmth is read from the item's own words only
  // (wool, down, fleece...) -- a jacket with no such words is not assumed warm.
  if (input.warmth) {
    const warmth = input.warmth;
    const targets = planned.filter(
      (slot) => !isPinnedSlot(slot) && (warmth.slotIds === null || warmth.slotIds.has(slot.slotId)),
    );
    const isLayer = (id: string) => ['mid', 'outer'].includes(roleOf(id) ?? '');
    const isWarm = (id: string) => {
      const candidate = input.candidates.get(id);
      return Boolean(candidate && hasWarmthEvidence(candidate));
    };
    if (warmth.direction === 'warmer') {
      for (const slot of targets) {
        if (slot.itemIds.some((id) => isLayer(id) && isWarm(id))) continue;
        let added: string | null = null;
        for (const role of ['mid', 'outer']) {
          if (slot.itemIds.some((id) => roleOf(id) === role)) continue;
          added = chooseSubstitute(slot, role, wearsIn(planned), { original: null, require: isWarm });
          if (added) break;
        }
        if (added) {
          slot.itemIds.push(added);
          protectedOccurrence.add(`${slot.slotId}|${added}`);
          record({ code: 'warmth_added', itemId: null, otherItemId: added, slotIds: [slot.slotId] });
        } else {
          record({ code: 'warmth_unavailable', itemId: null, otherItemId: null, slotIds: [slot.slotId] });
        }
      }
    } else {
      // Lighter never strips the protection a stated condition needs.
      const keepOuter = (input.conditions ?? []).some((condition) => ['rain', 'cold', 'snow'].includes(condition));
      for (const slot of targets) {
        for (const id of [...slot.itemIds]) {
          if (!isLayer(id) || !isWarm(id) || input.pinnedItemIds.has(id)) continue;
          if (keepOuter && roleOf(id) === 'outer') continue;
          slot.itemIds = slot.itemIds.filter((existing) => existing !== id);
          record({ code: 'warmth_removed', itemId: id, otherItemId: null, slotIds: [slot.slotId] });
        }
      }
    }
  }

  // ── 6. Consolidation: reuse and redundancy as one objective ───────────────
  // A local refinement consolidates only within the looks it actually changed.
  if (!(input.rebalance ?? input.regenerate === null)) {
    for (const slot of planned) {
      const before = initialItems.get(slot.slotId) ?? [];
      const untouched =
        !input.regenerate?.has(slot.slotId) &&
        before.length === slot.itemIds.length &&
        before.every((id) => slot.itemIds.includes(id));
      if (!untouched) continue;
      for (const id of slot.itemIds) protectedOccurrence.add(`${slot.slotId}|${id}`);
    }
  }
  const bandsCompatible = (replacement: string, original: string, slot: PackingPlannedSlot): boolean => {
    const requirement = requirementOf(slot);
    const rb = bandOf(replacement);
    const ob = bandOf(original);
    if (requirement.strict && !rb) return false;
    if (rb && ob) {
      const role = roleOf(original) ?? '';
      const tolerance = input.packLight || HIGH_REUSE_ROLES.has(role) ? 1 : 0;
      if (bandDistance(rb, ob) > tolerance) return false;
      // Never trade toward a less suitable band than the original held.
      const rank = (band: PackingFormalityBand) => {
        const index = requirement.preferred.indexOf(band);
        return index < 0 ? 99 : index;
      };
      return rank(rb) <= rank(ob) || bandDistance(rb, ob) === 0;
    }
    // The leaving piece says nothing about formality, but the covering piece is
    // PROVEN ideal for this occasion. That is not a claim the two are
    // equivalent -- only that the look no longer needs the unknown one.
    if (!ob && rb && !requirement.strict && requirement.preferred[0] === rb) return true;
    // Otherwise unknown on either side: only an item of the same garment class
    // is a credible stand-in. Unknown is never promoted to "equivalent".
    const a = input.candidates.get(replacement)!;
    const b = input.candidates.get(original)!;
    return sameGarmentClass(a, b);
  };

  for (const role of CONSOLIDATION_ROLES) {
    let changed = true;
    let guard = 0;
    while (changed && guard < 50) {
      changed = false;
      guard += 1;
      const wears = wearsIn(planned);
      const pieces = [...wears.keys()]
        .filter((id) => roleOf(id) === role)
        .sort((a, b) => {
          const delta = (wears.get(a) ?? 0) - (wears.get(b) ?? 0);
          if (delta !== 0) return delta;
          return (input.order.get(b) ?? 0) - (input.order.get(a) ?? 0);
        });
      if (pieces.length < 2) break;
      for (const leaving of pieces) {
        if (input.pinnedItemIds.has(leaving)) continue;
        const occurrences = planned.filter((slot) => slot.itemIds.includes(leaving));
        if (occurrences.some((slot) => protectedOccurrence.has(`${slot.slotId}|${leaving}`))) continue;
        const leavingCandidate = input.candidates.get(leaving)!;
        const leavingMatchesExplicit = matchesColorPreference(leavingCandidate, input.explicitColor);
        const projected = new Map(wears);
        const swaps: Array<{ slot: PackingPlannedSlot; replacement: string }> = [];
        for (const slot of occurrences) {
          let best: { id: string; score: number } | null = null;
          for (const other of pieces) {
            if (other === leaving || slot.itemIds.includes(other)) continue;
            if (!allowedIn(other, slot)) continue;
            if ((projected.get(other) ?? 0) + 1 > capOf(other)) continue;
            const otherCandidate = input.candidates.get(other)!;
            if (!colorsCompatible(otherCandidate, leavingCandidate)) continue;
            if (!bandsCompatible(other, leaving, slot)) continue;
            // An explicit colour instruction outranks packing one piece fewer.
            if (leavingMatchesExplicit && !matchesColorPreference(otherCandidate, input.explicitColor)) continue;
            const score = (projected.get(other) ?? 0) * 10 + preferenceScore(other, slot, leaving);
            if (!best || score > best.score) best = { id: other, score };
          }
          if (!best) break;
          projected.set(best.id, (projected.get(best.id) ?? 0) + 1);
          swaps.push({ slot, replacement: best.id });
        }
        if (swaps.length !== occurrences.length) continue;
        for (const { slot, replacement } of swaps) {
          slot.itemIds = slot.itemIds.map((id) => (id === leaving ? replacement : id));
        }
        const coveredBy = swaps
          .map((swap) => swap.replacement)
          .sort((a, b) => (projected.get(b) ?? 0) - (projected.get(a) ?? 0))[0];
        record({
          code: 'left_home',
          itemId: leaving,
          otherItemId: coveredBy,
          slotIds: swaps.map((swap) => swap.slot.slotId),
        });
        changed = true;
        break;
      }
    }
  }

  // ── 6b. Limits the traveller set ("only two pairs of shoes") ─────────────
  // A limit is trip-wide by definition, so it may move a piece between looks
  // the refinement did not otherwise touch -- but only for the limited role.
  // It is never met by breaking an occasion: a strict occasion keeps a piece
  // proven right for it, a pinned look keeps its piece, and when the limit
  // cannot be reached the plan says so instead of quietly exceeding it.
  for (const [role, max] of Object.entries(input.maxRoles ?? {})) {
    for (let guard = 0; guard < 20; guard += 1) {
      const wears = wearsIn(planned);
      const pieces = [...wears.keys()].filter((id) => roleOf(id) === role);
      if (pieces.length <= max) break;
      const leavingOrder = pieces
        .filter((id) => !input.pinnedItemIds.has(id))
        .sort((a, b) => {
          const delta = (wears.get(a) ?? 0) - (wears.get(b) ?? 0);
          if (delta !== 0) return delta;
          return (input.order.get(b) ?? 0) - (input.order.get(a) ?? 0);
        });
      let removed = false;
      for (const leaving of leavingOrder) {
        const occurrences = planned.filter((slot) => slot.itemIds.includes(leaving));
        if (occurrences.some((slot) => isPinnedSlot(slot))) continue;
        const projected = new Map(wears);
        const swaps: Array<{ slot: PackingPlannedSlot; replacement: string }> = [];
        for (const slot of occurrences) {
          const requirement = requirementOf(slot);
          let best: { id: string; score: number } | null = null;
          for (const other of pieces) {
            if (other === leaving || slot.itemIds.includes(other)) continue;
            if (!allowedIn(other, slot)) continue;
            if ((projected.get(other) ?? 0) + 1 > capOf(other)) continue;
            const band = bandOf(other);
            if (requirement.strict && (!band || !requirement.preferred.includes(band))) continue;
            const score = (projected.get(other) ?? 0) * 10 + preferenceScore(other, slot, leaving);
            if (!best || score > best.score) best = { id: other, score };
          }
          if (!best) break;
          projected.set(best.id, (projected.get(best.id) ?? 0) + 1);
          swaps.push({ slot, replacement: best.id });
        }
        if (swaps.length !== occurrences.length) continue;
        for (const { slot, replacement } of swaps) {
          slot.itemIds = slot.itemIds.map((id) => (id === leaving ? replacement : id));
        }
        record({
          code: 'max_role_applied',
          itemId: leaving,
          otherItemId: swaps
            .map((swap) => swap.replacement)
            .sort((a, b) => (projected.get(b) ?? 0) - (projected.get(a) ?? 0))[0],
          slotIds: swaps.map((swap) => swap.slot.slotId),
          garmentClass: role,
          limit: max,
        });
        removed = true;
        break;
      }
      if (!removed) {
        const stuck = leavingOrder[0] ?? pieces[0];
        record({
          code: 'max_role_conflict',
          itemId: stuck,
          otherItemId: null,
          slotIds: planned.filter((slot) => slot.itemIds.includes(stuck)).map((slot) => slot.slotId),
          garmentClass: role,
          limit: max,
        });
        break;
      }
    }
  }

  // ── 7. Coverage, honestly graded ──────────────────────────────────────────
  for (const slot of planned) {
    const missing = missingRoles(slot);
    const requirement = requirementOf(slot);
    if (missing.length > 0) {
      slot.coverage = 'uncovered';
      slot.missing = missing;
      continue;
    }
    if (requirement.strict) {
      const core = slot.itemIds.filter((id) => ['shoe', 'base', 'bottom', 'one_piece'].includes(roleOf(id) ?? ''));
      const unproven = core.some((id) => {
        const band = bandOf(id);
        return !band || !requirement.preferred.includes(band);
      });
      if (unproven) {
        slot.coverage = 'unconfirmed';
        slot.missing = ['formality_unconfirmed'];
        continue;
      }
    }
    slot.coverage = 'covered';
    slot.missing = [];
  }

  // ── 8. Repeat days and laundry (ADD-08) ───────────────────────────────────
  const wears = wearsIn(planned);
  if (input.repeats.length > 0) {
    const repeatedSlotIds: string[] = [];
    for (const repeat of input.repeats) {
      const source = planned.find((slot) => slot.slotId === repeat.repeatsSlotId);
      if (!source) continue;
      for (const id of source.itemIds) wears.set(id, (wears.get(id) ?? 0) + 1);
      if (!repeatedSlotIds.includes(source.slotId)) repeatedSlotIds.push(source.slotId);
    }
    const overCap = [...wears.entries()].some(([id, count]) => count > capOf(id));
    if (overCap) {
      record({
        code: input.laundry === 'unavailable' ? 'repeat_without_laundry' : 'laundry_assumed',
        itemId: null,
        otherItemId: null,
        slotIds: repeatedSlotIds,
      });
    }
  }

  const packedItemIds: string[] = [];
  for (const slot of planned) {
    for (const id of slot.itemIds) if (!packedItemIds.includes(id)) packedItemIds.push(id);
  }

  return {
    slots: planned,
    repeats: input.repeats,
    packedItemIds,
    wears: Object.fromEntries(wears),
    decisions,
  };
}
