// Build 35 Packing Intelligence -- the day-by-day planner path.
//
// Reached from packingHandler.ts ONLY after every V1 gate has passed -- K+
// precheck, Closet retrieval, K+ confirmation, readiness -- and only for a
// request that asked for planner version 2. Nothing in this file re-orders or
// weakens those gates, and the daily quota is still reserved immediately before
// (and only before) a provider call.
//
// COST (ADD-19). LLM calls per request are unchanged at most one. A refinement
// that the deterministic planner can satisfy -- reject, restore, pin, repeat
// rules, "use sneakers", pack light, laundry, shopping permission, a luggage
// question, a clarification -- makes NO call and spends no quota. A refinement
// that genuinely needs new styling ("make Friday more casual", "another dinner
// look") sends only the slots being changed.
//
// STATE (ADD-05). The response carries `plan.state`: ids, enums and codes only.
// On the next refinement it comes back as `priorState` and is re-verified
// against this actor's freshly retrieved Closet before any of it is used.

import type { EliseWardrobeCandidate } from './eliseAdviceTypes.ts';
import { packingGarmentClassesOf as candidateGarmentClasses } from './packingGarmentFacts.ts';
import { escapePromptData } from './promptHardening.ts';
import { PACKING_LIMITS, type ParsedPackingRequest, type PackingActivity } from './packingContract.ts';
import type { PackingRetrievalResult } from './packingRetrieval.ts';
import {
  resolveRequiredRoles,
  selectPackingCandidates,
  type PackingCandidateSelection,
} from './packingCandidates.ts';
import {
  derivePackingCoverageGaps,
  derivePackingExternalSuggestions,
  deriveScarcitySignal,
  type PackingExternalSuggestion,
  type PackingGapV2,
} from './packingGaps.ts';
import {
  formalityBandOf,
  hasRainEvidence,
  hasWarmthEvidence,
  requirementFor,
  type PackingColorPreference,
} from './packingGarmentFacts.ts';
import {
  PACKING_PROMPT_VERSION_V2,
  PACKING_SYSTEM_PROMPT_V2,
  buildPackingPlannerPrompt,
  type PackingWeatherPromptContext,
} from './packingPrompt.ts';
import {
  PACKING_STATE_VERSION,
  packingTripKey,
  readActiveConstraints,
  restorePackingPlanState,
  verifyPackingPlanState,
  type PackingPlanState,
} from './packingPlanState.ts';
import { interpretPackingRefinement, type PackingClarification } from './packingRefinementIntent.ts';
import { buildPackingSlots, dayLabel, slotLabel, type PackingSlot } from './packingSchedule.ts';
import { planPackingTrip, type PackingDecision, type PackingPlannerResult } from './packingTripPlanner.ts';
import {
  buildAuthorizedIndex,
  inspectPackingPlan,
  validatePackingModelOutput,
  type PackingPlan,
  type PackingPlanItem,
  type PackingPlanOutfit,
  type PackingPlanWeather,
} from './packingValidation.ts';
import type { PackingQuotaReservation, PackingTelemetry } from './packingHandler.ts';

export interface PackingPlanDaySlot {
  slotId: string;
  activity: PackingActivity;
  /** Set when a refinement changed this slot's formality away from its occasion. */
  formalityShift: 'less_formal' | 'more_formal' | null;
  label: string;
  outfitId: string | null;
  coverage: 'covered' | 'unconfirmed' | 'uncovered';
  missing: string[];
  pinned: boolean;
  /** For a later day that re-wears an earlier look. */
  repeatsSlotId: string | null;
}

export interface PackingPlanDay {
  dayIndex: number;
  date: string;
  label: string;
  slots: PackingPlanDaySlot[];
}

export interface PackingLeftHomeItem {
  itemId: string;
  title: string;
  coveredByItemId: string | null;
  coveredByTitle: string | null;
}

/** Build 35 additions to the V1 plan. Every field is additive. */
export interface PackingPlanV2 extends PackingPlan {
  plannerVersion: 2;
  days: PackingPlanDay[];
  decisions: PackingDecision[];
  notes: string[];
  leftHome: PackingLeftHomeItem[];
  gaps: PackingGapV2[];
  considerBuying: PackingExternalSuggestion[];
  state: PackingPlanState;
}

export interface PackingPlannerV2Outcome {
  httpStatus: number;
  body: {
    status: 'success' | 'no_result' | 'error';
    message: string;
    plan: PackingPlanV2 | null;
    clarification: PackingClarification | null;
    errorCode?: string;
  };
  providerInvoked: boolean;
}

export interface PackingPlannerV2Args {
  request: ParsedPackingRequest;
  planId: string;
  retrieval: PackingRetrievalResult;
  /** The readiness selection over the whole trip (census + required roles). */
  selection: PackingCandidateSelection;
  weather: PackingPlanWeather;
  weatherPrompt: PackingWeatherPromptContext | null;
  signatureStyleBlock: string | null;
  signatureColor: PackingColorPreference | null;
  telemetry: PackingTelemetry;
  reserveDailyGeneration: () => Promise<PackingQuotaReservation>;
  callProvider: (systemText: string, userText: string) => Promise<unknown>;
  now: () => number;
}

const ROLE_NOUNS: Record<string, string> = {
  shoe: 'shoes',
  base: 'top',
  bottom: 'bottoms',
  one_piece: 'dress',
  outer: 'outer layer',
  mid: 'mid layer',
  accessory: 'accessory',
};

/** "Black trousers" -> "black trousers"; "Carhartt jacket" keeps its brand. */
function nameOf(candidate: EliseWardrobeCandidate | undefined): string {
  const raw = (candidate?.title ?? candidate?.category ?? 'piece').replace(/[\u0000-\u001f<>`]/g, '').trim();
  const rest = raw.slice(1);
  return rest === rest.toLowerCase() ? raw.charAt(0).toLowerCase() + rest : raw;
}

function joinLabels(labels: string[]): string {
  const unique = [...new Set(labels)];
  if (unique.length <= 1) return unique[0] ?? '';
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

function timesWord(count: number): string {
  return count === 2 ? 'twice' : `${count} times`;
}

function outfitIdFor(slotId: string, itemIds: string[]): string {
  const input = `${slotId}|${[...itemIds].sort().join(',')}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `o-${slotId}-${hash.toString(16).padStart(8, '0')}`;
}

function colorPreferenceFromCodes(codes: string[]): PackingColorPreference | null {
  const families: string[] = [];
  const tokens: string[] = [];
  for (const code of codes) {
    if (['neutral', 'warm', 'cool', 'earth'].includes(code)) families.push(code);
    else tokens.push(code);
  }
  return families.length || tokens.length ? { families, tokens } : null;
}

/**
 * ADD-10. Deterministic ownership validation over the FINISHED structured plan,
 * before anything is rendered. Every packed or outfit id must resolve to this
 * actor's authorized owned Closet row; external suggestions must carry no item
 * id and must say `external`. Returns the ids that failed, which the caller
 * removes. No model is consulted.
 */
export function assertPackingOwnership(
  plan: Pick<PackingPlanV2, 'packedItems' | 'outfits' | 'considerBuying'>,
  authorized: Map<string, EliseWardrobeCandidate>,
): { violations: string[] } {
  const violations: string[] = [];
  const isOwned = (id: string) => {
    const candidate = authorized.get(id);
    return Boolean(candidate && candidate.actorRelationship === 'owned' && candidate.sourceType === 'closet');
  };
  for (const item of plan.packedItems) {
    if ((item as PackingPlanItem & { ownership?: string }).ownership !== 'owned' || !isOwned(item.itemId)) {
      violations.push(item.itemId);
    }
  }
  for (const outfit of plan.outfits) {
    for (const id of outfit.itemIds) if (!isOwned(id)) violations.push(id);
  }
  for (const suggestion of plan.considerBuying) {
    const record = suggestion as unknown as Record<string, unknown>;
    if (record.relationship !== 'external' || record.itemId != null) violations.push(`external:${suggestion.gapCode}`);
  }
  return { violations: [...new Set(violations)] };
}

export async function runPackingPlannerV2(args: PackingPlannerV2Args): Promise<PackingPlannerV2Outcome> {
  const { request, retrieval, telemetry } = args;
  const trip = request.trip;
  const tripKey = packingTripKey(trip);
  const slotPlan = buildPackingSlots(trip);
  const slots: PackingSlot[] = slotPlan.slots;
  const allDates = slotPlan.schedule.map((day) => day.date);
  const labelOf = (slotId: string) => {
    const slot = slots.find((entry) => entry.slotId === slotId);
    return slot ? slotLabel(slot, allDates) : slotId;
  };

  const authorized = buildAuthorizedIndex(retrieval.candidates);
  const order = new Map<string, number>();
  retrieval.candidates.forEach((candidate, index) => {
    const id = candidate.canonicalResourceIds.itemId?.toLowerCase();
    if (id && !order.has(id)) order.set(id, index);
  });
  const nameById = (id: string | null) => (id ? nameOf(authorized.get(id)) : 'piece');

  // ── Prior state: parsed, then re-verified against THIS actor's Closet ──────
  let prior: PackingPlanState | null = null;
  let priorUnreliable = false;
  if (request.priorState) {
    const restored = restorePackingPlanState(request.priorState, { tripKey });
    if (restored) {
      const verification = verifyPackingPlanState(restored, new Set(authorized.keys()));
      if (verification.reliable) prior = verification.state;
      else priorUnreliable = true;
    } else {
      priorUnreliable = true;
    }
  }

  const pinnedSlotIds = new Set(prior?.pinnedSlotIds ?? []);
  const pinnedItemIds = new Set(prior?.pinnedItemIds ?? []);
  const rejections = new Map<string, string[]>((prior?.rejections ?? []).map((entry) => [entry.itemId, entry.slotIds]));
  for (const id of request.constraints.excludeItemIds) if (!rejections.has(id)) rejections.set(id, []);
  const rejectedClasses = new Set(prior?.rejectedGarmentClasses ?? []);
  const codes = new Set(prior?.activeConstraints ?? []);
  if (request.constraints.packLight) codes.add('pack_light');
  if (request.constraints.ownedOnly) {
    codes.add('owned_only');
    codes.delete('allow_shopping');
  }
  for (const condition of trip.conditions ?? []) codes.add(`condition:${condition}`);

  const carried = new Map<string, string[]>();
  for (const priorSlot of prior?.slots ?? []) {
    const slot = slots.find((entry) => entry.slotId === priorSlot.slotId);
    if (!slot) continue;
    slot.formalityShift = priorSlot.formalityShift;
    slot.originalActivity = priorSlot.originalActivity;
    carried.set(priorSlot.slotId, [...priorSlot.itemIds]);
  }

  let regenerate: Set<string> | null = prior ? new Set() : null;
  const acknowledgements: string[] = [];
  const conflicts: string[] = [];
  const slotInstructions = new Map<string, string>();
  const avoidLooks: Array<{ slotId: string; itemIds: string[] }> = [];
  const freeNotes: string[] = [];
  let explicitStyleNote: string | null = null;
  const protectedItemIds = new Set<string>();
  let clarification: PackingClarification | null = null;
  let carryOnQuestion = false;
  let changed = !prior;
  // A trip-wide re-optimisation is allowed for a new plan, or when the traveller
  // asks for one. Every other refinement stays local (ADD-15).
  let rebalance = !prior;

  const targetSlots = (slotIds: string[] | null) =>
    slots.filter((slot) => slotIds === null || slotIds.includes(slot.slotId));
  const daysOf = (slotIds: string[]) =>
    joinLabels(slots.filter((slot) => slotIds.includes(slot.slotId)).map((slot) => slotLabel(slot, allDates)));
  const lockedConflict = (slot: PackingSlot) =>
    conflicts.push(`${slotLabel(slot, allDates)} is locked, so I left it exactly as it is.`);

  if (request.refinement) {
    if (!prior) {
      freeNotes.push(request.refinement.message);
      if (priorUnreliable) {
        acknowledgements.push("I couldn't match your earlier plan to your Closet, so I rebuilt the trip.");
      }
    } else {
      const interpretation = interpretPackingRefinement({
        message: request.refinement.message,
        resolvedItemId: request.refinement.resolvedItemId,
        resolvedDate: request.refinement.resolvedDate ?? null,
        slots: slots.map((slot) => ({
          slotId: slot.slotId,
          date: slot.date,
          activity: slot.activity,
          itemIds: carried.get(slot.slotId) ?? [],
        })),
        tripDates: allDates,
        repeatDays: [...new Set(slotPlan.repeats.map((repeat) => repeat.date))].map((date) => ({
          date,
          slotIds: slotPlan.repeats.filter((repeat) => repeat.date === date).map((repeat) => repeat.repeatsSlotId),
        })),
        candidates: authorized,
        rejectedItemIds: [...rejections.keys()],
        rejectedClasses: [...rejectedClasses],
      });
      clarification = interpretation.clarification;
      carryOnQuestion = interpretation.carryOnQuestion;

      if (!clarification) {
        for (const op of interpretation.ops) {
          switch (op.kind) {
            case 'reject_item': {
              if (pinnedItemIds.has(op.itemId)) {
                conflicts.push(`You asked me to keep the ${nameById(op.itemId)}, so it stays in the plan.`);
                break;
              }
              const inSlots = slots.filter((slot) => (carried.get(slot.slotId) ?? []).includes(op.itemId));
              rejections.set(op.itemId, inSlots.map((slot) => slot.slotId));
              acknowledgements.push(`I'll leave the ${nameById(op.itemId)} out of this trip.`);
              changed = true;
              break;
            }
            case 'reject_class':
              rejectedClasses.add(op.garmentClass);
              acknowledgements.push(`No ${op.garmentClass}s on this trip.`);
              changed = true;
              break;
            case 'restore_item': {
              const origins = rejections.get(op.itemId) ?? [];
              rejections.delete(op.itemId);
              const role = authorized.get(op.itemId)?.layeringRole ?? null;
              for (const slotId of origins) {
                const slot = slots.find((entry) => entry.slotId === slotId);
                if (!slot || pinnedSlotIds.has(slotId)) continue;
                const current = carried.get(slotId) ?? [];
                const withoutRole = current.filter((id) => authorized.get(id)?.layeringRole !== role);
                carried.set(slotId, [...withoutRole, op.itemId]);
              }
              protectedItemIds.add(op.itemId);
              acknowledgements.push(`Bringing the ${nameById(op.itemId)} back.`);
              changed = true;
              break;
            }
            case 'restore_class':
              rejectedClasses.delete(op.garmentClass);
              acknowledgements.push(`${op.garmentClass.charAt(0).toUpperCase()}${op.garmentClass.slice(1)}s are back on the table.`);
              changed = true;
              break;
            case 'include_item': {
              const candidate = authorized.get(op.itemId);
              const role = candidate?.layeringRole ?? null;
              const band = candidate ? formalityBandOf(candidate) : null;
              let placed = false;
              for (const slot of slots) {
                if (pinnedSlotIds.has(slot.slotId) || !role) continue;
                const requirement = requirementFor(slot.activity, slot.formalityShift);
                if (band && requirement.disallowed.includes(band)) continue;
                const current = carried.get(slot.slotId) ?? [];
                if (!current.some((id) => authorized.get(id)?.layeringRole === role)) continue;
                carried.set(slot.slotId, [...current.filter((id) => authorized.get(id)?.layeringRole !== role), op.itemId]);
                placed = true;
                if (['base', 'one_piece'].includes(role)) break;
              }
              rejections.delete(op.itemId);
              if (placed) {
                protectedItemIds.add(op.itemId);
                acknowledgements.push(`Added the ${nameById(op.itemId)}.`);
                changed = true;
              } else {
                conflicts.push(`I couldn't find a look on this trip where the ${nameById(op.itemId)} fits.`);
              }
              break;
            }
            case 'pin_slots':
              for (const slotId of op.slotIds) pinnedSlotIds.add(slotId);
              acknowledgements.push(`Keeping ${daysOf(op.slotIds)} exactly as it is.`);
              changed = true;
              break;
            case 'unpin_slots':
              for (const slotId of op.slotIds) pinnedSlotIds.delete(slotId);
              acknowledgements.push(`${daysOf(op.slotIds)} can change again.`);
              changed = true;
              break;
            case 'pin_item':
              pinnedItemIds.add(op.itemId);
              rejections.delete(op.itemId);
              acknowledgements.push(`Keeping the ${nameById(op.itemId)} in the plan.`);
              changed = true;
              break;
            case 'formality':
              for (const slot of targetSlots(op.slotIds)) {
                if (pinnedSlotIds.has(slot.slotId)) {
                  lockedConflict(slot);
                  continue;
                }
                const strict = requirementFor(slot.activity, null).strict;
                if (op.direction === 'less_formal' && strict) {
                  // ADD-03: an explicit later instruction supersedes the trip's
                  // earlier requirement, and the change is said out loud.
                  const day = slotLabel(slot, allDates).replace(/\s+formal event$/i, '');
                  acknowledgements.push(
                    `You had ${day} marked as a formal event. I'll switch it to casual as requested.`,
                  );
                  slot.originalActivity = slot.activity;
                } else if (op.direction === 'more_formal') {
                  slot.originalActivity = null;
                }
                slot.formalityShift = op.direction;
                regenerate!.add(slot.slotId);
                slotInstructions.set(
                  slot.slotId,
                  op.direction === 'less_formal' ? 'make this look more casual' : 'make this look dressier',
                );
              }
              if (!acknowledgements.some((line) => line.includes('as requested'))) {
                const touched = targetSlots(op.slotIds).filter((slot) => !pinnedSlotIds.has(slot.slotId));
                if (touched.length > 0) {
                  acknowledgements.push(
                    `Making ${daysOf(touched.map((slot) => slot.slotId))} ${op.direction === 'less_formal' ? 'more casual' : 'dressier'}.`,
                  );
                }
              }
              changed = true;
              break;
            case 'prefer_class': {
              const targets = targetSlots(op.slotIds).filter((slot) => {
                if (!pinnedSlotIds.has(slot.slotId)) return true;
                if (op.slotIds) lockedConflict(slot);
                return false;
              });
              const role = [...authorized.values()].find((candidate) =>
                candidateGarmentClasses(candidate).includes(op.garmentClass)
              )?.layeringRole;
              // A later preference replaces an earlier one for the same role.
              for (const code of [...codes]) {
                if (!code.startsWith('prefer_class:')) continue;
                const cls = code.split(':')[2];
                const sameRole = [...authorized.values()].some((candidate) =>
                  candidate.layeringRole === role && candidateGarmentClasses(candidate).includes(cls)
                );
                if (sameRole) codes.delete(code);
              }
              if (op.slotIds === null) codes.add(`prefer_class:all:${op.garmentClass}`);
              else for (const slot of targets) codes.add(`prefer_class:${slot.slotId}:${op.garmentClass}`);
              if (rejectedClasses.delete(op.garmentClass)) {
                acknowledgements.push(`You'd ruled out ${op.garmentClass}s earlier; they're back in.`);
              }
              for (const [id] of rejections) {
                const candidate = authorized.get(id);
                if (candidate && candidateGarmentClasses(candidate).includes(op.garmentClass)) rejections.delete(id);
              }
              if (targets.length > 0) {
                acknowledgements.push(
                  `Switching to ${op.garmentClass}s${op.slotIds ? ` for ${daysOf(targets.map((slot) => slot.slotId))}` : ''}.`,
                );
              }
              changed = true;
              break;
            }
            case 'no_repeat':
              codes.add(`no_repeat:${op.role}`);
              codes.delete(`rewear_ok:${op.role}`);
              acknowledgements.push(`No repeated ${ROLE_NOUNS[op.role] ?? op.role}.`);
              changed = true;
              break;
            case 'rewear_ok':
              codes.add(`rewear_ok:${op.role}`);
              codes.delete(`no_repeat:${op.role}`);
              rebalance = true;
              acknowledgements.push(`Noted, ${ROLE_NOUNS[op.role] ?? op.role} can be worn again.`);
              changed = true;
              break;
            case 'alternative':
              for (const slot of targetSlots(op.slotIds)) {
                if (pinnedSlotIds.has(slot.slotId)) {
                  if (op.slotIds) lockedConflict(slot);
                  continue;
                }
                regenerate!.add(slot.slotId);
                avoidLooks.push({ slotId: slot.slotId, itemIds: carried.get(slot.slotId) ?? [] });
              }
              changed = true;
              break;
            case 'color': {
              for (const code of [...codes]) if (code.startsWith('color:')) codes.delete(code);
              for (const value of [...op.preference.families, ...op.preference.tokens]) codes.add(`color:${value}`);
              explicitStyleNote = op.preference.families.includes('warm')
                ? 'bright colours'
                : [...op.preference.families, ...op.preference.tokens].join(', ');
              for (const slot of targetSlots(op.slotIds)) {
                if (!pinnedSlotIds.has(slot.slotId)) regenerate!.add(slot.slotId);
              }
              acknowledgements.push(`Leaning into ${explicitStyleNote}.`);
              changed = true;
              break;
            }
            case 'condition':
              codes.add(`condition:${op.condition}`);
              acknowledgements.push(`Noted, planning for ${op.condition}.`);
              changed = true;
              break;
            case 'laundry':
              codes.delete('laundry:available');
              codes.delete('laundry:unavailable');
              codes.add(op.available ? 'laundry:available' : 'laundry:unavailable');
              acknowledgements.push(op.available ? 'Noted, you can do laundry.' : 'Noted, no laundry on this trip.');
              changed = true;
              break;
            case 'owned_only':
              codes.add('owned_only');
              codes.delete('allow_shopping');
              acknowledgements.push('Packing only from your Closet.');
              changed = true;
              break;
            case 'allow_shopping':
              if (codes.delete('owned_only')) {
                acknowledgements.push(
                  "Earlier you asked for Closet-only packing. I'll include ideas to buy, only for real gaps.",
                );
              }
              codes.add('allow_shopping');
              changed = true;
              break;
            case 'pack_light':
              codes.add('pack_light');
              rebalance = true;
              acknowledgements.push('Packing lighter: more repeats, fewer pieces.');
              changed = true;
              break;
            case 'free_text':
              for (const slot of targetSlots(op.slotIds)) {
                if (!pinnedSlotIds.has(slot.slotId)) regenerate!.add(slot.slotId);
              }
              freeNotes.push(op.note);
              changed = true;
              break;
          }
        }
        for (const phrase of interpretation.notInCloset) {
          conflicts.push(`I don't see ${escapePlain(phrase)} in your Closet, so I haven't added it.`);
        }
        for (const word of interpretation.notInPlan) {
          conflicts.push(`Nothing in this plan matches "${escapePlain(word)}".`);
        }
        for (const word of interpretation.notRejected) {
          conflicts.push(`Nothing to bring back: I hadn't removed any ${escapePlain(word)}.`);
        }
      }
    }
  }
  // Pinned slots are never regenerated.
  if (regenerate) for (const slotId of pinnedSlotIds) regenerate.delete(slotId);

  const view = readActiveConstraints([...codes]);
  const explicitColor = colorPreferenceFromCodes(view.colors);
  const needsModel = !clarification && (regenerate === null || regenerate.size > 0);

  // ── The one model call, only for slots that need new styling ──────────────
  const proposals = new Map<string, string[]>();
  const activityProposals = new Map<PackingActivity, string[][]>();
  const modelReasons = new Map<string, string | null>();
  const itemReasons = new Map<string, string | null>();
  const modelAssumptions: string[] = [];
  let providerInvoked = false;
  let absenceDrops = 0;

  if (needsModel) {
    const regenSlots = regenerate === null ? slots : slots.filter((slot) => regenerate!.has(slot.slotId));
    const refining = regenerate !== null;
    const selection = selectPackingCandidates({
      candidates: retrieval.candidates,
      trip: { ...trip, activities: [...new Set(regenSlots.map((slot) => slot.activity))] },
      constraints: request.constraints,
      shortlistTarget: refining ? 8 : PACKING_LIMITS.shortlistTarget,
      signals: {
        explicitColor,
        signatureColor: args.signatureColor,
        rejectedItemIds: new Set(rejections.keys()),
        rejectedClasses,
      },
    });
    const shortlist = [...selection.shortlist];
    const lockedLooks: Array<{ slotId: string; itemIds: string[] }> = [];
    if (refining) {
      const inShortlist = new Set(shortlist.map((candidate) => candidate.canonicalResourceIds.itemId?.toLowerCase()));
      for (const slot of slots) {
        if (regenerate!.has(slot.slotId)) continue;
        const itemIds = carried.get(slot.slotId) ?? [];
        if (itemIds.length === 0) continue;
        lockedLooks.push({ slotId: slot.slotId, itemIds });
        // Reusable pieces of locked looks are offered to the model so the
        // changed slot can share them, bounded by the shortlist hard max.
        for (const id of itemIds) {
          const candidate = authorized.get(id);
          if (!candidate || inShortlist.has(id) || rejections.has(id)) continue;
          if (!['shoe', 'outer', 'bottom', 'accessory', 'mid'].includes(candidate.layeringRole ?? '')) continue;
          if (shortlist.length >= 12) break;
          shortlist.push(candidate);
          inShortlist.add(id);
        }
      }
    }

    // Locked and avoided looks are referenced by shortlist position (#n), not
    // by 36-character id: the model can only cite listed items anyway, and a
    // piece it cannot cite needs no mention. This is most of what keeps a local
    // refinement's context below the initial plan's.
    const refOf = new Map<string, string>();
    shortlist.forEach((candidate, index) => {
      const id = candidate.canonicalResourceIds.itemId?.toLowerCase();
      if (id) refOf.set(id, `#${index + 1}`);
    });
    const asRefs = (itemIds: string[]) => itemIds.map((id) => refOf.get(id)).filter((ref): ref is string => Boolean(ref));

    const userPrompt = buildPackingPlannerPrompt({
      trip,
      constraints: {
        ...request.constraints,
        packLight: view.packLight,
        notes: refining ? [] : request.constraints.notes,
      },
      shortlist,
      weather: args.weatherPrompt,
      signatureStyleBlock: args.signatureStyleBlock,
      slots: regenSlots.map((slot) => ({
        slotId: slot.slotId,
        label: slotLabel(slot, allDates),
        instruction: slotInstructions.get(slot.slotId) ?? null,
      })),
      lockedLooks: lockedLooks
        .map((look) => ({ slotId: look.slotId, itemIds: asRefs(look.itemIds) }))
        .filter((look) => look.itemIds.length > 0),
      avoidLooks: avoidLooks.map((look) => ({ slotId: look.slotId, itemIds: asRefs(look.itemIds) })),
      statedConditions: view.conditions,
      explicitStyleNote,
      refinementNote: freeNotes.length > 0 ? freeNotes.join(' / ') : null,
    });
    telemetry.promptChars = PACKING_SYSTEM_PROMPT_V2.length + userPrompt.length;
    telemetry.promptVersion = PACKING_PROMPT_VERSION_V2;
    telemetry.shortlistCount = shortlist.length;

    const reservation = await args.reserveDailyGeneration();
    if (reservation.status === 'limit_reached') {
      telemetry.failureClass = 'quota_limit_reached';
      return {
        httpStatus: 200,
        body: {
          status: 'error',
          message: "You've used today's Elise generations. Your packing plan will be here tomorrow.",
          plan: null,
          clarification: null,
          errorCode: 'PACKING_LIMIT_REACHED',
        },
        providerInvoked: false,
      };
    }
    if (reservation.status === 'check_failed') {
      telemetry.failureClass = 'quota_check_failed';
      return {
        httpStatus: 500,
        body: {
          status: 'error',
          message: 'I could not check your daily usage just now. Please try again.',
          plan: null,
          clarification: null,
          errorCode: 'PACKING_USAGE_CHECK_FAILED',
        },
        providerInvoked: false,
      };
    }

    const providerStartedAt = args.now();
    let raw: unknown = null;
    providerInvoked = true;
    try {
      raw = await args.callProvider(PACKING_SYSTEM_PROMPT_V2, userPrompt);
    } catch (error) {
      telemetry.failureClass =
        error instanceof Error && error.message ? error.message.slice(0, 40) : 'provider_error';
      raw = null;
    }
    telemetry.providerLatencyMs = args.now() - providerStartedAt;

    const validation = raw == null ? null : validatePackingModelOutput({
      raw,
      planId: args.planId,
      shortlist,
      trip,
      constraints: { ...request.constraints, excludeItemIds: [...rejections.keys()] },
      weather: args.weather,
      closetRoleCensus: args.selection.closetRoleCensus,
      censusComplete: retrieval.censusComplete,
      gaps: [],
      maxOutfits: PACKING_LIMITS.maxSlots,
      maxPackedItems: 30,
      allowedSlotIds: new Set(regenSlots.map((slot) => slot.slotId)),
    });
    if (validation) {
      telemetry.modelItemRefs = validation.telemetry.modelItemRefs;
      telemetry.rejectedItemRefs = validation.telemetry.rejectedItemRefs;
      telemetry.constraintViolationsDropped = validation.telemetry.constraintViolationsDropped;
      absenceDrops = validation.telemetry.absenceClaimsDropped;
      telemetry.absenceClaimsDropped = absenceDrops;
    }

    if (!validation?.ok || !validation.plan) {
      if (!refining) {
        telemetry.failureClass ??= validation?.failureReason ?? 'provider_error';
        return {
          httpStatus: 200,
          body: {
            status: raw == null ? 'error' : 'no_result',
            message: raw == null
              ? 'I could not finish your packing plan just now. Your trip details are still here — try again.'
              : "I couldn't build a plan from your Closet for this trip yet. Try again, or add a few more pieces to your Closet.",
            plan: null,
            clarification: null,
            errorCode: raw == null ? 'PACKING_GENERATION_FAILED' : 'PACKING_NO_RESULT',
          },
          providerInvoked,
        };
      }
      // A failed restyle never erases the looks it was asked to change.
      conflicts.push(`I couldn't restyle ${daysOf([...regenerate!])} just now, so it's unchanged. Try again in a moment.`);
      regenerate = new Set();
    } else {
      for (const outfit of validation.plan.outfits) {
        if (outfit.slotId && !proposals.has(outfit.slotId)) {
          proposals.set(outfit.slotId, outfit.itemIds);
          modelReasons.set(outfit.slotId, outfit.reason);
        } else if (outfit.activity) {
          const queue = activityProposals.get(outfit.activity) ?? [];
          queue.push(outfit.itemIds);
          activityProposals.set(outfit.activity, queue);
        }
      }
      for (const item of validation.plan.packedItems) itemReasons.set(item.itemId, item.reason);
      modelAssumptions.push(
        ...validation.plan.assumptions.filter((line) => !line.startsWith('Weather was not applied')),
      );
    }
  }

  // ── Deterministic trip-level planning ─────────────────────────────────────
  const planner: PackingPlannerResult = planPackingTrip({
    slots,
    repeats: slotPlan.repeats,
    proposals,
    activityProposals,
    carried,
    regenerate: clarification ? new Set() : regenerate,
    candidates: authorized,
    order,
    rejectedItemIds: clarification ? new Set(prior?.rejections.map((entry) => entry.itemId) ?? []) : new Set(rejections.keys()),
    rejectedClasses,
    pinnedSlotIds,
    pinnedItemIds,
    protectedItemIds,
    rebalance: rebalance || regenerate === null,
    preferClasses: view.preferClasses,
    noRepeatRoles: view.noRepeatRoles,
    rewearRoles: view.rewearRoles,
    explicitColor,
    signatureColor: args.signatureColor,
    packLight: view.packLight,
    laundry: view.laundry,
  });

  // ── Gaps, graded against coverage ─────────────────────────────────────────
  const closetItems = retrieval.candidates.map((candidate) => ({
    layeringRole: candidate.layeringRole,
    band: formalityBandOf(candidate),
    rainEvidence: hasRainEvidence(candidate),
    warmthEvidence: hasWarmthEvidence(candidate),
  }));
  const gaps = derivePackingCoverageGaps({
    censusComplete: retrieval.censusComplete,
    closetRoleCensus: args.selection.closetRoleCensus,
    requiredRoles: resolveRequiredRoles(trip),
    closetItems,
    slots: planner.slots.map((slot) => ({
      slotId: slot.slotId,
      activity: slot.activity,
      coverage: slot.coverage,
      missing: slot.missing,
      strict: requirementFor(slot.activity, slot.formalityShift).strict,
    })),
    forecastSummary: args.weather.provenance === 'UNAVAILABLE' ? null : args.weather.summary,
    statedConditions: view.conditions,
  });
  const considerBuying = derivePackingExternalSuggestions({
    gaps,
    allowShopping: view.allowShopping,
    ownedOnly: view.ownedOnly,
  });

  // ── Assemble the structured plan ──────────────────────────────────────────
  const outfits: PackingPlanOutfit[] = [];
  const outfitIdBySlot = new Map<string, string>();
  for (const slot of planner.slots) {
    if (slot.itemIds.length === 0) continue;
    const outfitId = outfitIdFor(slot.slotId, slot.itemIds);
    outfitIdBySlot.set(slot.slotId, outfitId);
    const modelSet = proposals.get(slot.slotId);
    const unchangedFromModel =
      modelSet && modelSet.length === slot.itemIds.length && modelSet.every((id) => slot.itemIds.includes(id));
    outfits.push({
      outfitId,
      label: slotLabel(slot, allDates),
      activity: slot.activity,
      itemIds: slot.itemIds,
      // A reason written for a different set of pieces would be false.
      reason: unchangedFromModel ? modelReasons.get(slot.slotId) ?? null : null,
      slotId: slot.slotId,
      date: slot.date,
      coverage: slot.coverage,
    });
  }

  const usedIn = new Map<string, number>();
  for (const slot of planner.slots) for (const id of slot.itemIds) usedIn.set(id, (usedIn.get(id) ?? 0) + 1);
  const packedItems = planner.packedItemIds.map((itemId) => {
    const candidate = authorized.get(itemId)!;
    const clientId = (candidate as unknown as { closetClientId?: unknown }).closetClientId;
    return {
      itemId,
      clientId: typeof clientId === 'string' && clientId.trim() ? clientId.trim().slice(0, 200) : null,
      title: candidate.title ?? candidate.category ?? 'Closet item',
      category: candidate.category,
      subtype: candidate.subcategory,
      brand: candidate.brand,
      primaryColor: candidate.colors[0] ?? null,
      layeringRole: candidate.layeringRole,
      reason: itemReasons.get(itemId) ?? null,
      scarcitySignal: deriveScarcitySignal(
        candidate.layeringRole,
        args.selection.closetRoleCensus,
        retrieval.censusComplete,
      ),
      usedInOutfits: usedIn.get(itemId) ?? 0,
      ownership: 'owned' as const,
    };
  });

  const ownership = assertPackingOwnership({ packedItems, outfits, considerBuying }, authorized);
  if (ownership.violations.length > 0) {
    // Unreachable by construction; enforced anyway, and never rendered.
    const bad = new Set(ownership.violations);
    for (const outfit of outfits) outfit.itemIds = outfit.itemIds.filter((id) => !bad.has(id));
  }
  const safePacked = packedItems.filter((item) => !ownership.violations.includes(item.itemId));
  const safeOutfits = outfits.filter((outfit) => outfit.itemIds.length > 0);

  if (safePacked.length === 0 || safeOutfits.length === 0) {
    telemetry.failureClass = 'planner_empty';
    return {
      httpStatus: 200,
      body: {
        status: 'no_result',
        message: "I couldn't build a plan from your Closet for this trip yet. Try again, or add a few more pieces to your Closet.",
        plan: null,
        clarification: null,
        errorCode: 'PACKING_NO_RESULT',
      },
      providerInvoked,
    };
  }

  const leftHome = planner.decisions
    .filter((decision) => decision.code === 'left_home' && decision.itemId)
    .map((decision) => ({
      itemId: decision.itemId!,
      title: authorized.get(decision.itemId!)?.title ?? 'Closet item',
      coveredByItemId: decision.otherItemId,
      coveredByTitle: decision.otherItemId ? authorized.get(decision.otherItemId)?.title ?? null : null,
    }));

  const days = slotPlan.schedule.map((day) => {
    const daySlots: PackingPlanDaySlot[] = planner.slots
      .filter((slot) => slot.dayIndex === day.dayIndex)
      .map((slot) => ({
        slotId: slot.slotId,
        activity: slot.activity,
        formalityShift: slot.formalityShift,
        label: slotLabel(slot, allDates),
        outfitId: outfitIdBySlot.get(slot.slotId) ?? null,
        coverage: slot.coverage,
        missing: slot.missing,
        pinned: pinnedSlotIds.has(slot.slotId),
        repeatsSlotId: null,
      }));
    for (const repeat of planner.repeats.filter((entry) => entry.dayIndex === day.dayIndex)) {
      const source = planner.slots.find((slot) => slot.slotId === repeat.repeatsSlotId);
      daySlots.push({
        slotId: `${repeat.repeatsSlotId}-r${day.dayIndex + 1}`,
        activity: repeat.activity,
        formalityShift: source?.formalityShift ?? null,
        label: slotLabel({ date: day.date, activity: repeat.activity }, allDates),
        outfitId: outfitIdBySlot.get(repeat.repeatsSlotId) ?? null,
        coverage: source?.coverage ?? 'uncovered',
        missing: source?.missing ?? [],
        pinned: false,
        repeatsSlotId: repeat.repeatsSlotId,
      });
    }
    return { dayIndex: day.dayIndex, date: day.date, label: dayLabel(day.date), slots: daySlots };
  });

  const notes = renderPlannerNotes({
    planner,
    nameById,
    labelOf,
    totalDays: slotPlan.totalDays,
    laundry: view.laundry,
  });

  const assumptions: string[] = [];
  if (trip.scheduleSource !== 'explicit') {
    const kinds = [...new Set(slots.map((slot) => slot.activity))].map((activity) => activity.replace('_', ' '));
    assumptions.push(
      `I assumed each day follows the occasions you chose (${kinds.join(', ')}), with travel on the first and last day. Adjust the days if yours differ.`,
    );
  }
  if (slotPlan.filledDayIndexes.length > 0) {
    assumptions.push('Days without an occasion get a daytime look.');
  }
  if (args.weather.provenance === 'UNAVAILABLE') {
    assumptions.push(
      view.conditions.length > 0
        ? `No forecast was applied. I planned for the conditions you mentioned (${view.conditions.join(', ')}).`
        : 'No forecast was applied. The plan is built from your trip, the occasions and what you own.',
    );
  }
  for (const line of modelAssumptions) if (assumptions.length < 6) assumptions.push(line);

  const priorPlanVersion = prior?.planVersion ?? 0;
  const planVersion = clarification ? Math.max(1, priorPlanVersion) : priorPlanVersion + (changed || !prior ? 1 : 0);
  const state: PackingPlanState = {
    stateVersion: PACKING_STATE_VERSION,
    plannerVersion: 2,
    planVersion: Math.min(planVersion, 500),
    tripId: prior?.tripId ?? (args.planId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'trip'),
    tripKey,
    slots: planner.slots.map((slot) => ({
      slotId: slot.slotId,
      activity: slot.activity,
      originalActivity: slot.originalActivity,
      formalityShift: slot.formalityShift,
      itemIds: slot.itemIds,
    })),
    pinnedSlotIds: [...pinnedSlotIds],
    pinnedItemIds: [...pinnedItemIds],
    rejections: clarification
      ? prior?.rejections ?? []
      : [...rejections.entries()].map(([itemId, slotIds]) => ({ itemId, slotIds })),
    rejectedGarmentClasses: [...rejectedClasses],
    activeConstraints: clarification ? prior?.activeConstraints ?? [] : [...codes],
    gapCodes: gaps.map((gap) => gap.code),
  };

  const shoes = safePacked.filter((item) => item.layeringRole === 'shoe').length;
  const plan: PackingPlanV2 = {
    contractVersion: 'packing_plan_v1',
    plannerVersion: 2,
    planId: args.planId,
    mode: 'personal',
    trip: {
      destination: trip.destination,
      startDate: trip.startDate,
      endDate: trip.endDate,
      nights: trip.nights,
      tripType: trip.tripType,
      activities: [...new Set(slotPlan.schedule.flatMap((day) => day.activities))],
    },
    weather: args.weather,
    packedItems: safePacked,
    outfits: safeOutfits,
    gaps,
    assumptions,
    constraints: {
      excludedItemIds: [...rejections.keys()],
      packLight: view.packLight,
      notes: request.constraints.notes,
    },
    counts: { items: safePacked.length, outfits: safeOutfits.length, shoes, gaps: gaps.length },
    days,
    decisions: planner.decisions,
    notes,
    leftHome,
    considerBuying,
    state,
  };

  const problems = inspectPackingPlan(plan).filter((problem) => problem !== 'excluded_item_packed' || pinnedSlotIds.size === 0);
  if (problems.length > 0) {
    telemetry.failureClass = `sanity_${problems[0]}`.slice(0, 40);
    return {
      httpStatus: 200,
      body: {
        status: 'no_result',
        message: "I couldn't build a plan from your Closet for this trip yet. Try again in a moment.",
        plan: null,
        clarification: null,
        errorCode: 'PACKING_NO_RESULT',
      },
      providerInvoked,
    };
  }

  telemetry.packedItemCount = safePacked.length;
  telemetry.outfitCount = safeOutfits.length;
  telemetry.gapCount = gaps.length;

  const message = renderPlannerMessage({
    plan,
    initial: !request.refinement,
    clarification,
    acknowledgements,
    conflicts,
    carryOnQuestion,
    changedSlotIds: regenerate ? [...regenerate] : [],
    labelOf,
    nameById,
  });

  return {
    httpStatus: 200,
    body: { status: 'success', message, plan, clarification },
    providerInvoked,
  };
}

function escapePlain(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f<>`]/g, '').trim().slice(0, 60);
}

/** Customer copy for the planner's meaningful decisions (section 18). */
export function renderPlannerNotes(input: {
  planner: PackingPlannerResult;
  nameById: (id: string | null) => string;
  labelOf: (slotId: string) => string;
  totalDays: number;
  laundry: 'available' | 'unavailable' | 'unknown';
}): string[] {
  const { planner, nameById, labelOf } = input;
  const notes: string[] = [];
  const labels = (slotIds: string[]) => joinLabels(slotIds.map(labelOf));

  const wearsBySlot = new Map<string, string[]>();
  for (const slot of planner.slots) {
    for (const id of slot.itemIds) wearsBySlot.set(id, [...(wearsBySlot.get(id) ?? []), slot.slotId]);
  }
  const roleOfPacked = (id: string) =>
    planner.slots.find((slot) => slot.itemIds.includes(id)) ? id : null;
  void roleOfPacked;

  for (const decision of planner.decisions) {
    switch (decision.code) {
      case 'left_home':
        // "Can take over" -- never "is the same as". Two navy blazers are
        // functionally interchangeable here, not identical products.
        notes.push(
          `Leave the ${nameById(decision.itemId)} home: the ${nameById(decision.otherItemId)} can take over ${labels(decision.slotIds)}.`,
        );
        break;
      case 'pin_conflict': {
        const plural = decision.slotIds.length > 1;
        notes.push(
          `${labels(decision.slotIds)} ${plural ? 'are' : 'is'} locked and ${plural ? 'use' : 'uses'} the ${nameById(decision.itemId)}, so it stays packed. Unlock ${plural ? 'those looks' : 'that look'} to leave it home.`,
        );
        break;
      }
      case 'repeat_worn':
        notes.push(
          `You'll wear the ${nameById(decision.itemId)} again for ${labels(decision.slotIds)}; I didn't find another suitable piece.`,
        );
        break;
      case 'formality_adjusted':
        notes.push(
          `${labels(decision.slotIds)} ${decision.slotIds.length > 1 ? 'now use' : 'now uses'} the ${nameById(decision.otherItemId)} instead of the ${nameById(decision.itemId)}.`,
        );
        break;
      case 'formality_removed':
        notes.push(`Left the ${nameById(decision.itemId)} out of ${labels(decision.slotIds)}; not right for that occasion.`);
        break;
      case 'prefer_class_unavailable':
        notes.push(
          decision.itemId === null && decision.slotIds.length === 0
            ? `I don't see ${decision.garmentClass}s in your Closet, so I kept what was there.`
            : `${decision.garmentClass ? `${decision.garmentClass.charAt(0).toUpperCase()}${decision.garmentClass.slice(1)}s` : 'That'} didn't work for ${labels(decision.slotIds)}, so it keeps its current piece.`,
        );
        break;
      case 'laundry_assumed':
        notes.push(
          input.laundry === 'available'
            ? `For ${input.totalDays} days, later days re-wear looks from ${labels(decision.slotIds)}, since you can do laundry.`
            : `For ${input.totalDays} days, this plan assumes one laundry stop so looks from ${labels(decision.slotIds)} can be worn again.`,
        );
        break;
      case 'repeat_without_laundry':
        notes.push(
          `Without laundry, later days repeat looks from ${labels(decision.slotIds)}. Add a few more tops from your Closet if you have room.`,
        );
        break;
      default:
        break;
    }
  }

  // Deliberate reuse, stated once per piece that genuinely works hard.
  const reused = [...wearsBySlot.entries()]
    .filter(([id, slotIds]) => {
      const role = planner.slots.find((slot) => slot.itemIds.includes(id)) ? id : null;
      return role !== null && slotIds.length >= 2;
    })
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3);
  for (const [id, slotIds] of reused) {
    notes.push(`Wear the ${nameById(id)} ${timesWord(slotIds.length)}: ${labels(slotIds)}.`);
  }

  for (const slot of planner.slots) {
    if (slot.coverage === 'uncovered') {
      notes.push(
        `I couldn't find suitable ${slot.missing.map((role) => ROLE_NOUNS[role] ?? role).join(' or ')} for ${labelOf(slot.slotId)}.`,
      );
    } else if (slot.coverage === 'unconfirmed') {
      notes.push(`I couldn't confirm the pieces for ${labelOf(slot.slotId)} are dressy enough.`);
    }
  }
  return notes;
}

function renderPlannerMessage(input: {
  plan: PackingPlanV2;
  initial: boolean;
  clarification: PackingClarification | null;
  acknowledgements: string[];
  conflicts: string[];
  carryOnQuestion: boolean;
  changedSlotIds: string[];
  labelOf: (slotId: string) => string;
  nameById: (id: string | null) => string;
}): string {
  const { plan } = input;
  if (input.clarification) return input.clarification.question;

  const sentences: string[] = [];
  if (input.initial) {
    const days = plan.days.length === 1 ? '1 day' : `${plan.days.length} days`;
    const looks = plan.outfits.length === 1 ? '1 look' : `${plan.outfits.length} looks`;
    const pieces = plan.packedItems.length === 1 ? '1 piece' : `${plan.packedItems.length} pieces`;
    sentences.push(
      `I planned ${looks} across ${days} in ${escapePlain(plan.trip.destination)} with ${pieces} from your Closet.`,
    );
    const hardest = [...plan.packedItems]
      .filter((item) => item.usedInOutfits >= 2 && ['bottom', 'shoe', 'outer', 'mid'].includes(item.layeringRole ?? ''))
      .sort((a, b) => b.usedInOutfits - a.usedInOutfits)
      .slice(0, 2);
    if (hardest.length > 0) {
      sentences.push(
        `You'll wear ${hardest
          .map((item) => `the ${nameOf({ title: item.title } as EliseWardrobeCandidate)} ${timesWord(item.usedInOutfits)}`)
          .join(' and ')}.`,
      );
    }
    if (plan.leftHome.length > 0) {
      const first = plan.leftHome[0];
      sentences.push(
        `You can leave the ${nameOf({ title: first.title } as EliseWardrobeCandidate)} home${
          first.coveredByTitle
            ? `, since the ${nameOf({ title: first.coveredByTitle } as EliseWardrobeCandidate)} can take over those looks`
            : ''
        }.`,
      );
    }
  } else {
    sentences.push(...input.acknowledgements);
    const changed = input.changedSlotIds.length;
    if (changed > 0 && changed < plan.outfits.length) {
      sentences.push(`Only ${joinLabels(input.changedSlotIds.map(input.labelOf))} changed.`);
    }
  }
  sentences.push(...input.conflicts);

  const uncovered = plan.days.flatMap((day) => day.slots).filter((slot) => slot.coverage === 'uncovered' && !slot.repeatsSlotId);
  if (uncovered.length > 0) {
    sentences.push(`${joinLabels(uncovered.map((slot) => slot.label))} isn't fully covered yet.`);
  }
  const confirmedGap = plan.gaps.find((gap) => gap.certainty === 'confirmed') ?? plan.gaps[0];
  if (confirmedGap && input.initial) sentences.push(confirmedGap.rationale);

  if (input.carryOnQuestion) {
    const compact = plan.packedItems.length <= 12 && plan.counts.shoes <= 2;
    sentences.push(
      `This plan is ${plan.packedItems.length} pieces, including ${plan.counts.shoes} ${plan.counts.shoes === 1 ? 'pair' : 'pairs'} of shoes. That's ${
        compact ? 'relatively compact' : 'on the fuller side for a carry-on'
      }, but I don't have reliable item-volume data, so I can't guarantee it fits your bag. Say "pack light" and I'll cut repeats further.`,
    );
  }
  if (sentences.length === 0) sentences.push('Your plan is up to date.');
  return sentences.join(' ');
}

export type { PackingSlot };
