/**
 * Build 5 — owned-item Look eligibility for Today with Elise V1.
 *
 * A Today Look may use only approved actor-owned Closet items. Unknown
 * ownership is never treated as owned. Recent Scans are never treated as
 * confirmed ownership. Cross-actor, deleted, and incompatible slot refs fail
 * closed.
 *
 * Build 4 confidence is optional and may only enter through
 * build4ConfidenceAdapter — this module never invents a threshold.
 */

import type { TodayWithEliseItemRef } from '../../types/todayWithElise';
import {
  adaptBuild4ConfidenceField,
  type Build4ConfidenceAdapterResult,
} from './build4ConfidenceAdapter';

export const TODAY_OWNED_PREFERRED_SLOTS = [
  'top',
  'bottom',
  'footwear',
  'outerwear',
  'accessory',
] as const;

export type TodayOwnedPreferredSlot =
  (typeof TODAY_OWNED_PREFERRED_SLOTS)[number];

export type TodayOwnershipEvidence =
  | 'exact_owned'
  | 'probable_owned'
  | 'similar_owned'
  | 'not_owned'
  | 'unknown'
  | 'deleted_reference'
  | 'incompatible_edit'
  | 'cross_actor'
  | 'recent_scan_only';

export type TodayEligibleSlotCandidate = {
  closetItemId: string;
  slot: TodayOwnedPreferredSlot | 'dress' | 'unknown';
  actorId: string | null;
  ownership: TodayOwnershipEvidence;
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  material: string | null;
  /** Optional opaque Build 4 confidence payload — never interpreted here. */
  build4Confidence: unknown;
};

export type TodayLookEligibilityInput = {
  actorId: string | null;
  /** Closet load scope attestation — required, mirrors Build 3 ownership. */
  loadedForActorId: string | null;
  candidates: readonly TodayEligibleSlotCandidate[];
  requireOuterwear: boolean;
};

export type TodayLookEligibilityOutcome =
  | {
      status: 'complete';
      itemRefs: TodayWithEliseItemRef[];
      excluded: Array<{ closetItemId: string; reason: string }>;
      confidenceAdapters: Build4ConfidenceAdapterResult[];
    }
  | {
      status: 'partial';
      itemRefs: TodayWithEliseItemRef[];
      missingSlots: string[];
      excluded: Array<{ closetItemId: string; reason: string }>;
      confidenceAdapters: Build4ConfidenceAdapterResult[];
    }
  | {
      status: 'ineligible';
      reason: string;
      excluded: Array<{ closetItemId: string; reason: string }>;
      confidenceAdapters: Build4ConfidenceAdapterResult[];
    };

const OWNED_OK: ReadonlySet<TodayOwnershipEvidence> = new Set([
  'exact_owned',
  'probable_owned',
]);

function normalizeActor(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isOwnedForActor(
  candidate: TodayEligibleSlotCandidate,
  actorId: string,
  loadedForActorId: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (candidate.ownership === 'recent_scan_only') {
    return { ok: false, reason: 'recent_scan_not_ownership' };
  }
  if (candidate.ownership === 'unknown') {
    return { ok: false, reason: 'unknown_ownership' };
  }
  if (candidate.ownership === 'deleted_reference') {
    return { ok: false, reason: 'deleted_reference' };
  }
  if (candidate.ownership === 'incompatible_edit') {
    return { ok: false, reason: 'incompatible_slot' };
  }
  if (candidate.ownership === 'cross_actor') {
    return { ok: false, reason: 'cross_actor' };
  }
  if (candidate.ownership === 'not_owned' || candidate.ownership === 'similar_owned') {
    return { ok: false, reason: 'not_confirmed_owned' };
  }
  if (!OWNED_OK.has(candidate.ownership)) {
    return { ok: false, reason: 'ownership_not_approved' };
  }

  const itemActor = normalizeActor(candidate.actorId);
  if (itemActor !== null && itemActor !== actorId) {
    return { ok: false, reason: 'cross_actor' };
  }
  if (itemActor === null) {
    const scoped = normalizeActor(loadedForActorId);
    if (scoped === null || scoped !== actorId) {
      return { ok: false, reason: 'missing_actor_scope' };
    }
  }
  return { ok: true };
}

/**
 * Evaluate whether a candidate set can form a Today owned-item Look.
 *
 * Complete = approved items covering top+bottom+footwear OR dress+footwear,
 * plus outerwear when requireOuterwear is true.
 * Partial = at least one approved slot item but missing required slots.
 * Ineligible = no approved items, or actor scope missing.
 */
export function evaluateTodayOwnedLookEligibility(
  input: TodayLookEligibilityInput,
): TodayLookEligibilityOutcome {
  const actorId = normalizeActor(input?.actorId);
  const adapters: Build4ConfidenceAdapterResult[] = [];
  const excluded: Array<{ closetItemId: string; reason: string }> = [];

  if (!actorId) {
    return {
      status: 'ineligible',
      reason: 'missing_actor',
      excluded,
      confidenceAdapters: adapters,
    };
  }

  const accepted: TodayWithEliseItemRef[] = [];
  const bySlot = new Map<string, TodayWithEliseItemRef>();

  for (const candidate of input.candidates ?? []) {
    const adapter = adaptBuild4ConfidenceField(candidate.build4Confidence);
    adapters.push(adapter);

    if (adapter.disposition === 'excluded_by_policy') {
      excluded.push({
        closetItemId: candidate.closetItemId,
        reason: 'build4_policy_excluded',
      });
      continue;
    }
    // absent / recognized / malformed / unsupported → do not invent thresholds;
    // continue with Build 3 ownership contract only.

    const owned = isOwnedForActor(candidate, actorId, input.loadedForActorId);
    if (owned.ok === false) {
      excluded.push({ closetItemId: candidate.closetItemId, reason: owned.reason });
      continue;
    }

    if (!candidate.closetItemId || typeof candidate.closetItemId !== 'string') {
      excluded.push({ closetItemId: String(candidate.closetItemId ?? ''), reason: 'invalid_id' });
      continue;
    }

    const slot = candidate.slot === 'unknown' ? 'unknown' : candidate.slot;
    if (slot === 'unknown') {
      excluded.push({ closetItemId: candidate.closetItemId, reason: 'unclassified_slot' });
      continue;
    }

    const ref: TodayWithEliseItemRef = {
      closetItemId: candidate.closetItemId,
      slot: slot as TodayWithEliseItemRef['slot'],
    };
    // First approved item per slot wins (deterministic input order).
    if (!bySlot.has(slot)) {
      bySlot.set(slot, ref);
      accepted.push(ref);
    }
  }

  if (accepted.length === 0) {
    return {
      status: 'ineligible',
      reason: 'no_approved_owned_items',
      excluded,
      confidenceAdapters: adapters,
    };
  }

  const hasTop = bySlot.has('top');
  const hasBottom = bySlot.has('bottom');
  const hasDress = bySlot.has('dress');
  const hasFootwear = bySlot.has('footwear');
  const hasOuterwear = bySlot.has('outerwear');

  const coreOk =
    (hasDress && hasFootwear) || (hasTop && hasBottom && hasFootwear);
  const outerwearOk = !input.requireOuterwear || hasOuterwear;

  if (coreOk && outerwearOk) {
    return {
      status: 'complete',
      itemRefs: accepted,
      excluded,
      confidenceAdapters: adapters,
    };
  }

  const missingSlots: string[] = [];
  if (!hasDress && !(hasTop && hasBottom)) {
    if (!hasTop) missingSlots.push('top');
    if (!hasBottom) missingSlots.push('bottom');
    if (!hasDress) missingSlots.push('dress');
  }
  if (!hasFootwear) missingSlots.push('footwear');
  if (input.requireOuterwear && !hasOuterwear) missingSlots.push('outerwear');

  return {
    status: 'partial',
    itemRefs: accepted,
    missingSlots,
    excluded,
    confidenceAdapters: adapters,
  };
}

/** Explicit prohibition checklist used by tests and Phase 2 reviewers. */
export const TODAY_OWNED_LOOK_PROHIBITIONS = Object.freeze([
  'recent_scans_as_ownership',
  'unknown_as_owned',
  'cross_actor_items',
  'deleted_references',
  'incompatible_slot_references',
  'silent_retailer_substitution',
  'commerce_insertion',
  'partial_described_as_complete',
  'independent_build4_confidence_threshold',
] as const);
