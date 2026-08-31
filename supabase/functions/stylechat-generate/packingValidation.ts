// K+ Packing Intelligence V1 — post-model validation and plan assembly (pure).
//
// THIS FILE IS THE OWNERSHIP GATE. Nothing the model returns is trusted. Every
// item reference is re-resolved against the server-authorized shortlist -- the
// set built from the caller's own RLS-scoped user_closet_items rows -- so a
// hallucinated id, another account's id, a saved-scan id, or a well-formed id
// that simply was not offered all resolve to nothing and are dropped.
//
// DROPPED, NEVER PATCHED. An invalid reference is removed; it is never replaced
// with a "nearest" item. Substituting would put a garment in the traveller's
// suitcase that the model never chose and the traveller never saw chosen.
//
// The plan this builds is the AUTHORITY. The assistant's prose is rendered from
// it, never parsed back into it.

import { escapePromptData } from './promptHardening.ts';
import { deriveScarcitySignal, type PackingGap } from './packingGaps.ts';
import type { EliseWardrobeCandidate } from './eliseAdviceTypes.ts';
import {
  PACKING_ACTIVITIES,
  PACKING_ACTIVITY_LABELS,
  PACKING_CONTRACT_VERSION,
  PACKING_LIMITS,
  type PackingActivity,
  type PackingConstraints,
  type PackingTripInput,
  type PackingWeatherProvenance,
} from './packingContract.ts';

export interface PackingPlanItem {
  /** Authoritative cloud Closet row id (user_closet_items.id). */
  itemId: string;
  /** The local Closet record id, so the client can render the real photo. */
  clientId: string | null;
  title: string;
  category: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  layeringRole: string | null;
  reason: string | null;
  /**
   * A checkable fact about the Closet, not a model claim: present only when
   * the owned-role census says this is the traveller's only item in its role.
   */
  scarcitySignal: string | null;
  /** Derived from the finished plan, never asserted by the model. */
  usedInOutfits: number;
}

export interface PackingPlanOutfit {
  outfitId: string;
  label: string;
  activity: PackingActivity | null;
  itemIds: string[];
  reason: string | null;
}

export interface PackingPlanWeather {
  provenance: PackingWeatherProvenance;
  summary: string | null;
}

export interface PackingPlan {
  contractVersion: typeof PACKING_CONTRACT_VERSION;
  planId: string;
  mode: 'personal' | 'general';
  trip: {
    destination: string;
    startDate: string;
    endDate: string;
    nights: number;
    tripType: string;
    activities: PackingActivity[];
  };
  weather: PackingPlanWeather;
  packedItems: PackingPlanItem[];
  outfits: PackingPlanOutfit[];
  /**
   * Requirements this trip has that the traveller's Closet cannot meet.
   * Never rendered with owned-item styling, and never a product.
   */
  gaps: PackingGap[];
  assumptions: string[];
  constraints: {
    excludedItemIds: string[];
    packLight: boolean;
    notes: string[];
  };
  counts: {
    items: number;
    outfits: number;
    shoes: number;
    gaps: number;
  };
}

export interface PackingValidationTelemetry {
  modelItemRefs: number;
  rejectedItemRefs: number;
  rejectedOutfits: number;
  emptyOutfitsDropped: number;
  duplicateRefsDropped: number;
  constraintViolationsDropped: number;
}

export interface PackingValidationResult {
  ok: boolean;
  plan: PackingPlan | null;
  failureReason:
    | null
    | 'model_output_not_object'
    | 'no_valid_outfits'
    | 'no_valid_items';
  telemetry: PackingValidationTelemetry;
}

const MAX_REASON_CHARS = 120;
const MAX_LABEL_CHARS = 40;
const MAX_ASSUMPTION_CHARS = 160;
const MAX_ASSUMPTIONS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Model prose that will be rendered to a person. Stripped of the characters that
 * let text impersonate structure, then bounded. escapePromptData is not used
 * here: it JSON-quotes for prompt embedding, which is the wrong shape for a
 * value the UI displays.
 */
function safeDisplayText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Deterministic ids. Never Math.random / crypto here: this module is pure so a
 * given (plan seed, index) always produces the same id, which is what makes a
 * revision diff against a previous plan meaningful.
 */
function outfitId(planId: string, index: number): string {
  return `${planId}-o${index + 1}`;
}

export function buildAuthorizedIndex(
  shortlist: EliseWardrobeCandidate[],
): Map<string, EliseWardrobeCandidate> {
  const index = new Map<string, EliseWardrobeCandidate>();
  for (const candidate of shortlist) {
    const itemId = candidate.canonicalResourceIds.itemId;
    if (!itemId) continue;
    // Ownership is asserted once, here: only a candidate the server itself
    // retrieved as an owned Closet row can ever become a packable item.
    if (candidate.actorRelationship !== 'owned' || candidate.sourceType !== 'closet') continue;
    index.set(itemId.toLowerCase(), candidate);
  }
  return index;
}

/**
 * Local Closet id carried alongside the cloud id so the client can render the
 * traveller's own photograph. Read from the retrieval row rather than invented.
 */
function clientIdOf(candidate: EliseWardrobeCandidate): string | null {
  const raw = (candidate as unknown as { closetClientId?: unknown }).closetClientId;
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 200) : null;
}

export function validatePackingModelOutput(input: {
  raw: unknown;
  planId: string;
  shortlist: EliseWardrobeCandidate[];
  trip: PackingTripInput;
  constraints: PackingConstraints;
  weather: PackingPlanWeather;
  /** Owned-role census (packingCandidates). Drives scarcity signals. */
  closetRoleCensus?: Record<string, number>;
  /** False when retrieval was truncated: no scarcity claim may then be made. */
  censusComplete?: boolean;
  /** Deterministically derived unmet requirements (packingGaps). */
  gaps?: PackingGap[];
}): PackingValidationResult {
  const telemetry: PackingValidationTelemetry = {
    modelItemRefs: 0,
    rejectedItemRefs: 0,
    rejectedOutfits: 0,
    emptyOutfitsDropped: 0,
    duplicateRefsDropped: 0,
    constraintViolationsDropped: 0,
  };

  if (!isRecord(input.raw)) {
    return { ok: false, plan: null, failureReason: 'model_output_not_object', telemetry };
  }

  const authorized = buildAuthorizedIndex(input.shortlist);
  const excluded = new Set(input.constraints.excludeItemIds.map((id) => id.toLowerCase()));

  const resolve = (raw: unknown): EliseWardrobeCandidate | null => {
    telemetry.modelItemRefs += 1;
    const id = normalizeId(raw);
    if (!id) {
      telemetry.rejectedItemRefs += 1;
      return null;
    }
    // A referenced id the traveller explicitly excluded is a knowing constraint
    // violation, counted separately so it is visible in telemetry rather than
    // hidden inside the generic rejection count.
    if (excluded.has(id)) {
      telemetry.constraintViolationsDropped += 1;
      return null;
    }
    const candidate = authorized.get(id);
    if (!candidate) {
      telemetry.rejectedItemRefs += 1;
      return null;
    }
    return candidate;
  };

  // ── Outfits ───────────────────────────────────────────────────────────────
  const rawOutfits = Array.isArray(input.raw.outfits) ? input.raw.outfits : [];
  const outfits: PackingPlanOutfit[] = [];
  const usageCount = new Map<string, number>();

  for (const rawOutfit of rawOutfits) {
    if (outfits.length >= PACKING_LIMITS.maxOutfits) break;
    if (!isRecord(rawOutfit)) {
      telemetry.rejectedOutfits += 1;
      continue;
    }

    const rawItemIds = Array.isArray(rawOutfit.itemIds) ? rawOutfit.itemIds : [];
    const itemIds: string[] = [];
    for (const rawItemId of rawItemIds.slice(0, PACKING_LIMITS.maxItemsPerOutfit * 2)) {
      if (itemIds.length >= PACKING_LIMITS.maxItemsPerOutfit) break;
      const candidate = resolve(rawItemId);
      if (!candidate) continue;
      const itemId = candidate.canonicalResourceIds.itemId!.toLowerCase();
      if (itemIds.includes(itemId)) {
        telemetry.duplicateRefsDropped += 1;
        continue;
      }
      itemIds.push(itemId);
    }

    // An outfit emptied by validation is DROPPED, not rendered as an empty card
    // and not back-filled with items the model did not choose.
    if (itemIds.length === 0) {
      telemetry.emptyOutfitsDropped += 1;
      continue;
    }

    const rawActivity = typeof rawOutfit.activity === 'string' ? rawOutfit.activity : null;
    const activity =
      rawActivity && (PACKING_ACTIVITIES as readonly string[]).includes(rawActivity)
        ? (rawActivity as PackingActivity)
        : null;

    const label =
      safeDisplayText(rawOutfit.label, MAX_LABEL_CHARS) ??
      (activity ? PACKING_ACTIVITY_LABELS[activity] : `Look ${outfits.length + 1}`);

    for (const itemId of itemIds) usageCount.set(itemId, (usageCount.get(itemId) ?? 0) + 1);

    outfits.push({
      outfitId: outfitId(input.planId, outfits.length),
      label,
      activity,
      itemIds,
      reason: safeDisplayText(rawOutfit.reason, MAX_REASON_CHARS),
    });
  }

  // ── Packed items ──────────────────────────────────────────────────────────
  // Union of what the model declared packed and what its surviving outfits
  // actually use, so an outfit can never reference an item the packing list
  // omits.
  const reasonByItem = new Map<string, string | null>();
  const orderedIds: string[] = [];

  const rawPacked = Array.isArray(input.raw.packedItems) ? input.raw.packedItems : [];
  for (const rawItem of rawPacked.slice(0, PACKING_LIMITS.maxPackedItems * 2)) {
    if (!isRecord(rawItem)) continue;
    const candidate = resolve(rawItem.itemId);
    if (!candidate) continue;
    const itemId = candidate.canonicalResourceIds.itemId!.toLowerCase();
    if (!reasonByItem.has(itemId)) {
      reasonByItem.set(itemId, safeDisplayText(rawItem.reason, MAX_REASON_CHARS));
      orderedIds.push(itemId);
    } else {
      telemetry.duplicateRefsDropped += 1;
    }
  }
  for (const outfit of outfits) {
    for (const itemId of outfit.itemIds) {
      if (reasonByItem.has(itemId)) continue;
      reasonByItem.set(itemId, null);
      orderedIds.push(itemId);
    }
  }

  const packedItems: PackingPlanItem[] = [];
  for (const itemId of orderedIds) {
    if (packedItems.length >= PACKING_LIMITS.maxPackedItems) break;
    const candidate = authorized.get(itemId);
    if (!candidate) continue;
    packedItems.push({
      itemId,
      clientId: clientIdOf(candidate),
      title: candidate.title ?? candidate.category ?? 'Closet item',
      category: candidate.category,
      subtype: candidate.subcategory,
      brand: candidate.brand,
      primaryColor: candidate.colors[0] ?? null,
      layeringRole: candidate.layeringRole,
      reason: reasonByItem.get(itemId) ?? null,
      scarcitySignal: deriveScarcitySignal(
        candidate.layeringRole,
        input.closetRoleCensus ?? {},
        input.censusComplete !== false,
      ),
      usedInOutfits: usageCount.get(itemId) ?? 0,
    });
  }

  if (packedItems.length === 0) {
    return { ok: false, plan: null, failureReason: 'no_valid_items', telemetry };
  }
  if (outfits.length === 0) {
    return { ok: false, plan: null, failureReason: 'no_valid_outfits', telemetry };
  }

  // Drop any outfit left referencing an item the packed-item bound trimmed away,
  // so the two halves of the plan can never disagree.
  const packedIds = new Set(packedItems.map((item) => item.itemId));
  const consistentOutfits = outfits
    .map((outfit) => ({ ...outfit, itemIds: outfit.itemIds.filter((id) => packedIds.has(id)) }))
    .filter((outfit) => outfit.itemIds.length > 0);
  if (consistentOutfits.length === 0) {
    return { ok: false, plan: null, failureReason: 'no_valid_outfits', telemetry };
  }

  // usedInOutfits is recomputed from the FINAL outfit set: a trust signal the
  // traveller reads ("works across 3 looks") must be derived from the plan they
  // are actually looking at, never from what the model claimed.
  const finalUsage = new Map<string, number>();
  for (const outfit of consistentOutfits) {
    for (const itemId of outfit.itemIds) {
      finalUsage.set(itemId, (finalUsage.get(itemId) ?? 0) + 1);
    }
  }
  for (const item of packedItems) item.usedInOutfits = finalUsage.get(item.itemId) ?? 0;

  const assumptions: string[] = [];
  const rawAssumptions = Array.isArray(input.raw.assumptions) ? input.raw.assumptions : [];
  for (const rawAssumption of rawAssumptions) {
    if (assumptions.length >= MAX_ASSUMPTIONS) break;
    const assumption = safeDisplayText(rawAssumption, MAX_ASSUMPTION_CHARS);
    if (assumption) assumptions.push(assumption);
  }
  if (input.weather.provenance === 'UNAVAILABLE') {
    assumptions.unshift(
      'Weather was not applied to this plan. It is built from your trip type, the occasions you chose, and what you own.',
    );
  }

  const shoes = packedItems.filter((item) => item.layeringRole === 'shoe').length;
  const gaps = input.gaps ?? [];

  return {
    ok: true,
    failureReason: null,
    telemetry,
    plan: {
      contractVersion: PACKING_CONTRACT_VERSION,
      planId: input.planId,
      mode: 'personal',
      trip: {
        destination: input.trip.destination,
        startDate: input.trip.startDate,
        endDate: input.trip.endDate,
        nights: input.trip.nights,
        tripType: input.trip.tripType,
        activities: input.trip.activities,
      },
      weather: input.weather,
      packedItems,
      outfits: consistentOutfits,
      gaps,
      assumptions,
      constraints: {
        excludedItemIds: input.constraints.excludeItemIds,
        packLight: input.constraints.packLight,
        notes: input.constraints.notes,
      },
      counts: {
        items: packedItems.length,
        outfits: consistentOutfits.length,
        shoes,
        gaps: gaps.length,
      },
    },
  };
}

/**
 * Deterministic sanity checks over an ALREADY-VALIDATED plan. These are not a
 * fashion evaluator -- coherence is the model's job. They catch the structural
 * nonsense a validated plan can still contain.
 */
export function inspectPackingPlan(plan: PackingPlan): string[] {
  const problems: string[] = [];
  const packedIds = new Set(plan.packedItems.map((item) => item.itemId));

  if (plan.packedItems.length === 0) problems.push('plan_has_no_items');
  if (plan.outfits.length === 0) problems.push('plan_has_no_outfits');

  for (const outfit of plan.outfits) {
    if (outfit.itemIds.length === 0) problems.push('outfit_empty');
    for (const itemId of outfit.itemIds) {
      if (!packedIds.has(itemId)) problems.push('outfit_references_unpacked_item');
    }
  }

  const excluded = new Set(plan.constraints.excludedItemIds.map((id) => id.toLowerCase()));
  for (const item of plan.packedItems) {
    if (excluded.has(item.itemId)) problems.push('excluded_item_packed');
  }

  if (plan.counts.items !== plan.packedItems.length) problems.push('item_count_mismatch');
  if (plan.counts.outfits !== plan.outfits.length) problems.push('outfit_count_mismatch');
  if (plan.counts.gaps !== plan.gaps.length) problems.push('gap_count_mismatch');

  // A gap describes something the Closet does NOT contain. If one ever named
  // a role the plan actually packed, the two halves are contradicting each
  // other and the traveller would be told to buy what they just packed.
  const packedRoles = new Set(plan.packedItems.map((item) => item.layeringRole));
  for (const gap of plan.gaps) {
    const role = gap.code.startsWith('missing_role_') ? gap.code.slice('missing_role_'.length) : null;
    if (role && packedRoles.has(role)) problems.push('gap_contradicts_packed_item');
  }

  return [...new Set(problems)];
}

/**
 * The assistant's visible message for a finished plan. Written from the
 * structured plan so the two can never disagree -- section 33 of the build
 * plan ("prose follows state") is enforced by there being no other source.
 */
export function renderPackingPlanMessage(plan: PackingPlan): string {
  const nights = plan.trip.nights === 1 ? '1 night' : `${plan.trip.nights} nights`;
  const looks = plan.outfits.length === 1 ? '1 look' : `${plan.outfits.length} looks`;
  const items = plan.packedItems.length === 1 ? '1 piece' : `${plan.packedItems.length} pieces`;
  const reused = plan.packedItems.filter((item) => item.usedInOutfits > 1).length;

  const sentences = [
    `I packed ${items} from your Closet for ${nights} in ${escapePlainText(plan.trip.destination)}, and built ${looks} from them.`,
  ];
  if (reused > 0) {
    sentences.push(
      reused === 1
        ? 'One piece carries more than one look, so it earns its place twice.'
        : `${reused} pieces carry more than one look each, so the suitcase stays small.`,
    );
  }
  if (plan.weather.provenance === 'UNAVAILABLE') {
    sentences.push('I planned from your trip type and occasions — no weather was applied.');
  }
  sentences.push('Tell me what to change and I will rebuild it.');
  return sentences.join(' ');
}

/** Destination is user text even on the way back out. */
function escapePlainText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f<>`]/g, '').trim();
}
