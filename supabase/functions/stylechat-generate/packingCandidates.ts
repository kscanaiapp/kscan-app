// K+ Packing Intelligence V1 — deterministic candidate selection (pure).
//
// STAGE 1 OF TWO. Code narrows the authoritative Closet; the model does the
// fashion reasoning (packingPrompt.ts). This module never calls a provider and
// never decides what looks good -- it decides what the model is allowed to see.
//
// NO SECOND TAXONOMY. Every garment fact here comes from the ONE Closet
// taxonomy already normalized into EliseWardrobeCandidate by
// eliseFashionFeatures.ts: `layeringRole` (derived from category/subtype by
// inferLayeringRole) and `colorFamilies` (inferColorFamilies). This file adds
// only the smallest thing that did not exist: a mapping from a TRIP
// REQUIREMENT (dinner, beach, work) to the layering roles that requirement
// needs. That is a requirement vocabulary, not a garment vocabulary.
//
// COVERAGE BEFORE TRUNCATION. A large Closet must not be reduced by "first N",
// "latest N" or "random N" -- that is how a 200-item Closet produces a plan
// with four tops and no shoes. Selection fills each required role in
// round-robin order first, and only then spends whatever budget is left on the
// best remaining items.

import type { EliseWardrobeCandidate } from './eliseAdviceTypes.ts';
import {
  PACKING_LIMITS,
  type PackingActivity,
  type PackingConstraints,
  type PackingTripInput,
  type PackingTripType,
} from './packingContract.ts';

/**
 * The layering roles inferLayeringRole can produce. Re-stated as a local
 * constant only so the coverage tables below cannot silently reference a role
 * that does not exist; the derivation itself stays in eliseFashionFeatures.ts.
 */
export const PACKING_LAYERING_ROLES = [
  'base',
  'mid',
  'outer',
  'bottom',
  'one_piece',
  'shoe',
  'accessory',
] as const;
export type PackingLayeringRole = (typeof PACKING_LAYERING_ROLES)[number];

/**
 * Requirement -> roles. Ordered by how much the requirement depends on the role,
 * because that order is also the round-robin fill order.
 *
 * `one_piece` sits alongside `base`/`bottom` rather than replacing them: a dress
 * and a top+trousers are both legitimate answers to "dinner", and deciding
 * between them is the model's job, not this table's.
 */
const ROLES_BY_ACTIVITY: Record<PackingActivity, PackingLayeringRole[]> = {
  travel_day: ['base', 'bottom', 'shoe', 'mid', 'outer'],
  casual_day: ['base', 'bottom', 'shoe', 'mid'],
  dinner: ['base', 'bottom', 'one_piece', 'shoe', 'mid'],
  work: ['base', 'bottom', 'shoe', 'mid', 'outer'],
  beach: ['base', 'bottom', 'shoe', 'one_piece'],
  outdoors: ['base', 'bottom', 'outer', 'shoe', 'mid'],
  workout: ['base', 'bottom', 'shoe'],
  formal_event: ['one_piece', 'base', 'bottom', 'shoe', 'mid'],
  nightlife: ['base', 'one_piece', 'bottom', 'shoe', 'mid'],
};

/**
 * Fallback when the user named no activities at all. A trip still has a shape,
 * and inventing activities the user did not choose would be worse than covering
 * the general roles every trip needs.
 */
const ROLES_BY_TRIP_TYPE: Record<PackingTripType, PackingLayeringRole[]> = {
  leisure: ['base', 'bottom', 'shoe', 'mid', 'outer'],
  business: ['base', 'bottom', 'shoe', 'mid', 'outer'],
  beach: ['base', 'bottom', 'shoe', 'one_piece'],
  city: ['base', 'bottom', 'shoe', 'mid', 'outer'],
  outdoors: ['base', 'bottom', 'outer', 'shoe', 'mid'],
  event: ['one_piece', 'base', 'bottom', 'shoe', 'mid'],
  other: ['base', 'bottom', 'shoe', 'mid', 'outer'],
};

export interface PackingCandidateSelection {
  /** The bounded set the model may reason over. */
  shortlist: EliseWardrobeCandidate[];
  /** Everything that survived filtering, before the shortlist bound. */
  usableCount: number;
  /** Rows rejected as unusable (no identifying facts at all). */
  unusableCount: number;
  /** Rows dropped because the user excluded them for this trip. */
  excludedCount: number;
  /** Required roles this Closet could not cover at all. */
  uncoveredRoles: PackingLayeringRole[];
  requiredRoles: PackingLayeringRole[];
  rolesInShortlist: Record<string, number>;
  /**
   * Every layering role present in the USABLE OWNED set, with counts --
   * not the shortlist. B4's gap derivation and the "your only X" trust
   * signal both read this: a role that exists in the Closet but lost its
   * place to the shortlist bound is not missing, and reporting it as
   * missing would tell a traveller they lack a coat they own.
   */
  closetRoleCensus: Record<string, number>;
  /** False when the Closet cannot support an honest personalized plan. */
  personalPlanPossible: boolean;
}

function roleOf(candidate: EliseWardrobeCandidate): PackingLayeringRole | null {
  const role = candidate.layeringRole;
  if (!role) return null;
  return (PACKING_LAYERING_ROLES as readonly string[]).includes(role)
    ? (role as PackingLayeringRole)
    : null;
}

/**
 * A row with no title, no category and no colour tells the model nothing and
 * would be rendered as a blank card. Ownership is not the question here --
 * every row reaching this function is already owned -- usefulness is.
 */
function isUsable(candidate: EliseWardrobeCandidate): boolean {
  if (candidate.actorRelationship !== 'owned') return false;
  if (!candidate.canonicalResourceIds.itemId) return false;
  const hasTitle = typeof candidate.title === 'string' && candidate.title.trim().length > 0;
  const hasCategory = typeof candidate.category === 'string' && candidate.category.trim().length > 0;
  return hasTitle || hasCategory || candidate.colors.length > 0;
}

/**
 * Deterministic versatility score. Small and explainable on purpose: this is a
 * tie-breaker between items competing for the same role, NOT a recommender.
 * Fashion judgement belongs to the model.
 */
function versatilityScore(candidate: EliseWardrobeCandidate, trip: PackingTripInput): number {
  let score = 0;

  // Neutrals combine with more of the rest of the suitcase.
  if (candidate.colorFamilies.includes('neutral')) score += 3;
  else if (candidate.colorFamilies.includes('earth')) score += 1;

  // A described item is a better prompt citizen than a bare one.
  if (candidate.category) score += 1;
  if (candidate.subcategory) score += 1;
  if (candidate.materials.length > 0) score += 1;
  if (candidate.brand) score += 1;

  // Weak, honest trip affinity from material words the Closet actually stores.
  const materials = candidate.materials.join(' ').toLowerCase();
  const warmTrip = trip.tripType === 'beach' || trip.activities.includes('beach');
  const coldTrip = trip.tripType === 'outdoors' || trip.activities.includes('outdoors');
  if (warmTrip && /linen|cotton|seersucker|jersey/.test(materials)) score += 2;
  if (coldTrip && /wool|fleece|down|cashmere|flannel/.test(materials)) score += 2;

  return score;
}

/** Newest first. Recency is only ever a tie-break, never the sole criterion. */
function recencyRank(candidate: EliseWardrobeCandidate, order: Map<string, number>): number {
  return order.get(candidate.candidateId) ?? Number.MAX_SAFE_INTEGER;
}

export function resolveRequiredRoles(trip: PackingTripInput): PackingLayeringRole[] {
  const roles: PackingLayeringRole[] = [];
  const push = (role: PackingLayeringRole) => {
    if (!roles.includes(role)) roles.push(role);
  };

  if (trip.activities.length > 0) {
    // Interleave so the FIRST role of every activity is required before the
    // second role of any activity: a trip with dinner and a beach day must not
    // spend its whole budget on dinner because dinner was listed first.
    const lists = trip.activities.map((activity) => ROLES_BY_ACTIVITY[activity]);
    const depth = Math.max(...lists.map((list) => list.length));
    for (let index = 0; index < depth; index += 1) {
      for (const list of lists) {
        if (index < list.length) push(list[index]);
      }
    }
  } else {
    for (const role of ROLES_BY_TRIP_TYPE[trip.tripType]) push(role);
  }

  // Shoes are required by every trip, including one whose activities somehow
  // did not mention them.
  push('shoe');
  return roles;
}

export function selectPackingCandidates(input: {
  candidates: EliseWardrobeCandidate[];
  trip: PackingTripInput;
  constraints: PackingConstraints;
  shortlistTarget?: number;
}): PackingCandidateSelection {
  const target = Math.min(
    input.shortlistTarget ?? PACKING_LIMITS.shortlistTarget,
    PACKING_LIMITS.shortlistHardMax,
  );
  const excluded = new Set(input.constraints.excludeItemIds.map((id) => id.toLowerCase()));

  // Retrieval order is the caller's (updated_at desc); capture it before any
  // sort so recency survives as a tie-break.
  const retrievalOrder = new Map<string, number>();
  input.candidates.forEach((candidate, index) => retrievalOrder.set(candidate.candidateId, index));

  let excludedCount = 0;
  let unusableCount = 0;
  const usable: EliseWardrobeCandidate[] = [];
  for (const candidate of input.candidates) {
    const itemId = candidate.canonicalResourceIds.itemId?.toLowerCase() ?? '';
    if (itemId && excluded.has(itemId)) {
      excludedCount += 1;
      continue;
    }
    if (!isUsable(candidate)) {
      unusableCount += 1;
      continue;
    }
    usable.push(candidate);
  }

  const closetRoleCensus: Record<string, number> = {};
  for (const candidate of usable) {
    const role = roleOf(candidate);
    if (!role) continue;
    closetRoleCensus[role] = (closetRoleCensus[role] ?? 0) + 1;
  }

  const requiredRoles = resolveRequiredRoles(input.trip);

  const byRole = new Map<PackingLayeringRole, EliseWardrobeCandidate[]>();
  const unroled: EliseWardrobeCandidate[] = [];
  for (const candidate of usable) {
    const role = roleOf(candidate);
    if (!role) {
      unroled.push(candidate);
      continue;
    }
    const bucket = byRole.get(role);
    if (bucket) bucket.push(candidate);
    else byRole.set(role, [candidate]);
  }
  for (const bucket of byRole.values()) {
    bucket.sort((a, b) => {
      const delta = versatilityScore(b, input.trip) - versatilityScore(a, input.trip);
      if (delta !== 0) return delta;
      return recencyRank(a, retrievalOrder) - recencyRank(b, retrievalOrder);
    });
  }

  const chosen: EliseWardrobeCandidate[] = [];
  const taken = new Set<string>();
  const cursor = new Map<PackingLayeringRole, number>();

  // Pass 1 -- coverage. One item per required role, in requirement order, then
  // a second, then a third, until the budget runs out. Every required role gets
  // its first item before any role gets its second.
  let progressed = true;
  while (chosen.length < target && progressed) {
    progressed = false;
    for (const role of requiredRoles) {
      if (chosen.length >= target) break;
      const bucket = byRole.get(role);
      if (!bucket) continue;
      const index = cursor.get(role) ?? 0;
      if (index >= bucket.length) continue;
      cursor.set(role, index + 1);
      const candidate = bucket[index];
      if (taken.has(candidate.candidateId)) {
        progressed = true;
        continue;
      }
      taken.add(candidate.candidateId);
      chosen.push(candidate);
      progressed = true;
    }
  }

  // Pass 2 -- spend anything left on the best remaining items, including roles
  // the trip did not explicitly require (an accessory can still earn its place)
  // and items whose category the Closet could not reduce to a role at all.
  if (chosen.length < target) {
    const leftovers = [...usable, ...unroled]
      .filter((candidate) => !taken.has(candidate.candidateId))
      .sort((a, b) => {
        const delta = versatilityScore(b, input.trip) - versatilityScore(a, input.trip);
        if (delta !== 0) return delta;
        return recencyRank(a, retrievalOrder) - recencyRank(b, retrievalOrder);
      });
    for (const candidate of leftovers) {
      if (chosen.length >= target) break;
      if (taken.has(candidate.candidateId)) continue;
      taken.add(candidate.candidateId);
      chosen.push(candidate);
    }
  }

  const rolesInShortlist: Record<string, number> = {};
  for (const candidate of chosen) {
    const role = roleOf(candidate) ?? 'unknown';
    rolesInShortlist[role] = (rolesInShortlist[role] ?? 0) + 1;
  }

  const uncoveredRoles = requiredRoles.filter((role) => !(rolesInShortlist[role] > 0));

  return {
    shortlist: chosen,
    usableCount: usable.length,
    unusableCount,
    excludedCount,
    uncoveredRoles,
    requiredRoles,
    rolesInShortlist,
    closetRoleCensus,
    personalPlanPossible: usable.length >= PACKING_LIMITS.minCandidatesForPersonalPlan,
  };
}
