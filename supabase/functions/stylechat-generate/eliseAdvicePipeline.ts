/**
 * E-4 closet-aware advice pipeline orchestrator.
 */

import type { EliseVisualContextEnvelope } from './eliseVisualContextTypes.ts';
import { ELISE_ADVICE_LIMITS } from './eliseAdviceTypes.ts';
import type {
  EliseAdvicePipelineResult,
  EliseAdviceIntent,
  EliseClosetCensus,
  EliseOutfitState,
  EliseRefinementOutcome,
  EliseWardrobeContextMode,
} from './eliseAdviceTypes.ts';
import {
  classifyEliseAdviceIntent,
  intentAllowsCommerce,
} from './eliseAdviceIntents.ts';
import { resolveEliseFocusedItem } from './eliseFocusResolution.ts';
import {
  retrieveAuthorizedWardrobeCandidates,
  type EliseWardrobeDataSource,
} from './eliseWardrobeRetrieval.ts';
import { rankAndBoundCandidates } from './eliseCompatibilityScoring.ts';
import {
  analyzeWardrobeGap,
  buildMultiLooks,
  buildPurchaseAdvice,
} from './eliseWardrobeGap.ts';
import {
  buildEliseAdviceMetadata,
  buildEliseAdvicePromptBlock,
  deriveWardrobeContextMode,
} from './eliseAdvicePrompt.ts';
import {
  applyRefinementExclusions,
  constraintColors,
  continuesOutfit,
  orderForRefinement,
  planRefinement,
  projectOutfitState,
  readRefinementDirectives,
  refinementRoleOf,
} from './eliseOutfitState.ts';
import { formalityBandOf } from './packingGarmentFacts.ts';

export interface EliseAdviceFlagState {
  adviceIntentsV1: boolean;
  closetRetrievalV1: boolean;
  compatibilityScoringV1: boolean;
  wardrobeGapV1: boolean;
  purchaseAdviceV1: boolean;
  multiLookV1: boolean;
  /**
   * Build 34 / K+ Wardrobe Concierge V1. Off -> every Concierge behaviour in
   * this pipeline is bypassed and the result is the pre-Concierge one.
   */
  conciergeV1?: boolean;
}

function extractOccasionTokens(message: string): string[] {
  const tokens: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\bwork\b/i, 'work'],
    [/\bdinner\b/i, 'dinner'],
    [/\bwedding\b/i, 'wedding'],
    [/\bdate\b/i, 'date'],
    [/\bcocktail\b/i, 'cocktail'],
    [/\bformal\b/i, 'formal'],
    [/\bcausal\b|\bcasual\b/i, 'casual'],
    [/\boffice\b/i, 'office'],
  ];
  for (const [re, token] of patterns) {
    if (re.test(message)) tokens.push(token);
  }
  return tokens;
}

function extractSeasonTokens(message: string, weatherSummary?: string | null): string[] {
  const blob = `${message} ${weatherSummary ?? ''}`;
  const tokens: string[] = [];
  for (const season of ['summer', 'winter', 'spring', 'fall', 'autumn']) {
    if (new RegExp(`\\b${season}\\b`, 'i').test(blob)) {
      tokens.push(season === 'autumn' ? 'fall' : season);
    }
  }
  return tokens;
}

function extractSignatureTokens(summary?: string | null): string[] {
  if (!summary) return [];
  return summary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2)
    .slice(0, 12);
}

export async function runEliseAdvicePipeline(input: {
  message: string;
  actorId: string;
  envelope: EliseVisualContextEnvelope | null;
  data: EliseWardrobeDataSource;
  flags: EliseAdviceFlagState;
  weatherSummary?: string | null;
  signatureStyleSummary?: string | null;
  /**
   * C2 sections 26/27. Deterministic Closet census, when the caller could
   * compute one. Null is a normal state (no K+, flag off, query failed) and
   * degrades gap claims to bounded scope rather than failing the turn.
   */
  census?: EliseClosetCensus | null;
  /**
   * Build 36 / V2. The styling decision that was active when this turn arrived,
   * restored from the previous assistant message. UNTRUSTED by contract (it
   * round-trips through the client), and safe for exactly that reason: it can
   * only remove candidates from this turn's shortlist, never add or own one.
   * Null on a first turn, a new outfit, or a block that failed validation.
   */
  priorOutfitState?: EliseOutfitState | null;
  /**
   * Injected id for a NEW outfit, so this pipeline stays deterministic under
   * test. Callers pass `crypto.randomUUID()`.
   */
  newOutfitId?: string;
}): Promise<EliseAdvicePipelineResult | null> {
  const flags = input.flags;
  if (!flags.adviceIntentsV1) return null;
  const conciergeV1 = Boolean(flags.conciergeV1);

  const noShopping = /\b(without\s+buying|no\s+shopping|closet\s+only)\b/i.test(input.message);
  // Build 35. The refinement is read BEFORE the intent: "different shoes" on
  // an outfit is still the outfit's task, not a new shoe-only question, and it
  // is still for the occasion that outfit was for. A new question starts over.
  const directives = readRefinementDirectives(input.message);
  const priorState = conciergeV1 ? input.priorOutfitState ?? null : null;
  const messageOccasions = extractOccasionTokens(input.message);
  const continuing = continuesOutfit({ prior: priorState, directives, messageOccasionTokens: messageOccasions });
  const intent: EliseAdviceIntent = continuing && priorState?.intent
    ? priorState.intent
    : classifyEliseAdviceIntent(input.message, {
        preferClosetFirst: true,
        noShopping,
      });
  const occasionTokens = continuing
    ? [...new Set([...(priorState?.occasionTokens ?? []), ...messageOccasions])]
    : messageOccasions;
  // An explicit colour wish ("make it red") must be able to surface a piece
  // the scorer ranked just outside the grounded shortlist -- Signature Style
  // cannot be allowed to hide it. The SAME scorer ranks a slightly wider
  // window; the wish reorders it; the result is cut back to the usual bound.
  const wishedColors = conciergeV1
    ? constraintColors(
        continuing ? [...(priorState?.activeConstraints ?? []), ...directives.constraints] : directives.constraints,
        'prefer_color',
      )
    : [];

  let shortlist = [] as ReturnType<typeof rankAndBoundCandidates>;
  let retrievalLatencyMs = 0;
  let scoringLatencyMs = 0;
  let authorizedCount = 0;
  let rejectedCount = 0;
  let countsBySource: Record<string, number> = {};
  let ownershipSourceCounts: Record<string, number> = {};
  let partialFailure = false;
  let inventoryCount = 0;

  // C2 section 20. Retrieval runs BEFORE focus resolution because a possessive
  // phrase ("my brown loafers") can only be matched against candidates the
  // actor is already authorized for. Retrieval never consults the focus, so
  // reordering these two is behaviour-preserving; scoring, which does consult
  // it, still runs after both.
  let authorizedCandidates: Awaited<
    ReturnType<typeof retrieveAuthorizedWardrobeCandidates>
  >['candidates'] = [];

  if (flags.closetRetrievalV1) {
    const retrieval = await retrieveAuthorizedWardrobeCandidates({
      actorId: input.actorId,
      intent,
      message: input.message,
      data: input.data,
    });
    retrievalLatencyMs = retrieval.retrievalLatencyMs;
    authorizedCount = retrieval.authorizedCount;
    rejectedCount = retrieval.rejectedCount;
    countsBySource = retrieval.countsBySource;
    ownershipSourceCounts = retrieval.ownershipSourceCounts;
    partialFailure = retrieval.partialFailure;
    inventoryCount = retrieval.candidates.length;
    authorizedCandidates = retrieval.candidates;
  }

  const focused = resolveEliseFocusedItem({
    envelope: input.envelope,
    message: input.message,
    authorizedCandidates,
    conciergeV1,
  });

  if (flags.closetRetrievalV1) {
    const retrieval = { candidates: authorizedCandidates };
    if (flags.compatibilityScoringV1) {
      const scoreStarted = Date.now();
      shortlist = rankAndBoundCandidates({
        focus: focused,
        candidates: retrieval.candidates,
        intent,
        occasionTokens,
        seasonTokens: extractSeasonTokens(input.message, input.weatherSummary),
        signatureStyleTokens: extractSignatureTokens(input.signatureStyleSummary),
        ...(wishedColors.length ? { limit: ELISE_ADVICE_LIMITS.groundedShortlist + 6 } : {}),
      });
      scoringLatencyMs = Date.now() - scoreStarted;
    } else {
      // Retrieval without scoring: owned-first bounded shortlist.
      shortlist = retrieval.candidates.slice(0, 10).map((candidate, index) => ({
        candidate,
        score: {
          total: Math.max(0.1, 1 - index * 0.05),
          dimensions: {
            categoryRole: 0.5,
            colorHarmony: 0.5,
            silhouetteBalance: 0.5,
            materialTexture: 0.5,
            formality: 0.5,
            season: 0.5,
            occasion: 0.5,
            signatureStyle: 0.5,
            ownershipPriority: candidate.actorRelationship === 'owned' ? 1 : 0.5,
            redundancyPenalty: 0.7,
          },
          reasons: ['retrieval_order_only'],
          warnings: [],
        },
        recommendationRole: index === 0 ? 'primary' : 'alternative',
      }));
    }
  }

  // Enforce commerce deferral when shopping not requested.
  if (!intentAllowsCommerce(intent, input.message)) {
    shortlist = shortlist.filter((s) => s.candidate.actorRelationship !== 'discovered');
  }

  // Build 36 / V2 -- REFINEMENT.
  //
  // Applied here, after retrieval/scoring and after commerce deferral, and
  // before gap analysis and look building. That position is load-bearing in
  // both directions: exclusions must act on the ranked list the answer would
  // otherwise have used, and the gap/look logic downstream must reason about
  // what is ACTUALLY left after a rejection rather than about a shortlist the
  // customer has already turned down.
  //
  // Concierge-gated: with the flag off the plan is empty, no candidate is
  // excluded, and the result is byte-identical to the pre-V2 one.
  // Build 35: "no leather" is a material only when this Closet's own records
  // use the word -- there is no second material vocabulary to consult.
  if (conciergeV1 && directives.negatedTerms.length) {
    const recorded = new Set(
      authorizedCandidates.flatMap((candidate) =>
        `${candidate.materials.join(' ')} ${candidate.title ?? ''}`.toLowerCase().split(/[^a-z]+/)
      ),
    );
    for (const term of directives.negatedTerms) {
      if (recorded.has(term)) directives.constraints.push(`not_material:${term}`.slice(0, 32));
    }
  }
  const plan = conciergeV1
    ? planRefinement({
        prior: priorState,
        directives,
        candidates: authorizedCandidates,
        messageOccasionTokens: messageOccasions,
      })
    : {
        continued: false,
        excludedCandidateIds: [],
        excludedGarmentClasses: [],
        retainedCandidateIds: [],
        activeConstraints: [],
        preservedCandidateIds: [],
        ambiguity: null,
        unresolved: [],
      };

  const exclusion = applyRefinementExclusions({
    shortlist,
    excludedCandidateIds: plan.excludedCandidateIds,
    excludedGarmentClasses: plan.excludedGarmentClasses,
    excludedColors: constraintColors(plan.activeConstraints, 'not_color'),
    excludedMaterials: plan.activeConstraints
      .filter((code) => code.startsWith('not_material:'))
      .map((code) => code.slice('not_material:'.length)),
  });
  shortlist = exclusion.shortlist;

  // Build 35 -- PRESERVE WHAT STILL WORKS. The pieces the refinement did not
  // target go first, so the deterministic look builder below composes the
  // next look around them. A formality shift moves exactly one piece -- the
  // most visible one on the wrong side, read from the item's own words by the
  // same formality facts Packing uses -- and offers a same-role piece from the
  // right side in its place. Reordering only: nothing is added.
  let keepFirst: string[] = [];
  const demote: string[] = [];
  if (conciergeV1 && plan.continued) {
    keepFirst = [...plan.retainedCandidateIds, ...plan.preservedCandidateIds]
      .filter((id, index, all) => all.indexOf(id) === index);
    const shift = directives.constraints.includes('less_formal')
      ? 'less_formal'
      : directives.constraints.includes('more_formal')
      ? 'more_formal'
      : null;
    if (shift) {
      const byId = new Map(shortlist.map((scored) => [scored.candidate.candidateId, scored.candidate]));
      const bandOf = (id: string) => {
        const candidate = byId.get(id);
        return candidate ? formalityBandOf(candidate) : null;
      };
      const wrongSide = (band: string | null) =>
        band !== null && (shift === 'less_formal' ? ['smart', 'formal'] : ['casual', 'athletic']).includes(band);
      const rightSide = (band: string | null) =>
        band !== null && (shift === 'less_formal' ? ['casual', 'athletic'] : ['smart', 'formal']).includes(band);
      for (const role of ['outer', 'shoe', 'bottom']) {
        const roleOfId = (id: string) => {
          const candidate = byId.get(id);
          return candidate ? refinementRoleOf(candidate) : null;
        };
        const piece = keepFirst.find((id) =>
          roleOfId(id) === role && !plan.retainedCandidateIds.includes(id) && wrongSide(bandOf(id))
        );
        if (!piece) continue;
        keepFirst = keepFirst.filter((id) => id !== piece);
        demote.push(piece);
        const replacement = shortlist.find((scored) =>
          refinementRoleOf(scored.candidate) === role && !keepFirst.includes(scored.candidate.candidateId) &&
          scored.candidate.candidateId !== piece && rightSide(bandOf(scored.candidate.candidateId))
        );
        if (replacement) keepFirst.push(replacement.candidate.candidateId);
        break;
      }
    }
  }
  if (conciergeV1) {
    shortlist = orderForRefinement({
      shortlist,
      keepFirst,
      preferColors: constraintColors(plan.activeConstraints, 'prefer_color'),
      demote,
    }).slice(0, ELISE_ADVICE_LIMITS.groundedShortlist);
  }

  const wardrobeGap =
    flags.wardrobeGapV1 &&
    (intent === 'wardrobe_gap' || intent === 'build_outfit' || intent === 'multi_look_generation')
      ? analyzeWardrobeGap({
          focus: focused,
          shortlist,
          inventoryCount,
          partialFailure,
          census: input.census ?? null,
          conciergeV1,
        })
      : null;

  const purchaseAdvice =
    flags.purchaseAdviceV1 && (intent === 'purchase_advice' || intent === 'wardrobe_gap')
      ? buildPurchaseAdvice({ intent, focus: focused, shortlist, wardrobeGap })
      : null;

  const looks =
    flags.multiLookV1 && (intent === 'multi_look_generation' || intent === 'build_outfit')
      ? buildMultiLooks({ intent, shortlist, wardrobeGap, conciergeV1 })
      : null;

  const projected = conciergeV1
    ? projectOutfitState({
        prior: input.priorOutfitState ?? null,
        continued: plan.continued,
        shortlist,
        excludedCandidateIds: exclusion.excludedCandidateIds,
        excludedGarmentClasses: plan.excludedGarmentClasses,
        retainedCandidateIds: plan.retainedCandidateIds,
        activeConstraints: plan.activeConstraints,
        newOutfitId: input.newOutfitId ?? 'outfit_unset',
        intent,
        occasionTokens,
        looks: looks?.map((look) => look.candidateIds) ?? null,
      })
    : null;

  const outfitState: EliseOutfitState | null = projected?.state ?? null;
  const inShortlist = new Set(shortlist.map((scored) => scored.candidate.candidateId));
  const preservedIds = plan.preservedCandidateIds.filter((id) => inShortlist.has(id) && !demote.includes(id));
  const refinement: EliseRefinementOutcome | null = projected
    ? {
        ...projected.outcome,
        action: directives.action,
        // Build 35 fields are present only when they say something, so an
        // ordinary turn's metadata is unchanged.
        ...(plan.continued && preservedIds.length ? { preservedIds } : {}),
        ...(plan.ambiguity ? { ambiguousCandidateIds: plan.ambiguity.candidateIds } : {}),
        ...(plan.unresolved.length ? { unresolved: plan.unresolved } : {}),
        ...(exclusion.unverifiedCandidateIds.length ? { unverifiedAttributeIds: exclusion.unverifiedCandidateIds } : {}),
      }
    : null;

  const promptBlock = buildEliseAdvicePromptBlock({
    intent,
    focused,
    shortlist,
    wardrobeGap,
    purchaseAdvice,
    looks,
    conciergeV1,
    outfitState,
    refinement,
  });

  const adviceMetadata = buildEliseAdviceMetadata({
    intent,
    focused,
    shortlist,
    wardrobeGap,
    purchaseAdvice,
    looks,
    conciergeV1,
    outfitState,
    refinement,
  });

  const wardrobeContextMode: EliseWardrobeContextMode = conciergeV1
    ? deriveWardrobeContextMode(shortlist, focused)
    : 'none';

  return {
    intent,
    focused,
    shortlist,
    wardrobeGap,
    purchaseAdvice,
    looks,
    wardrobeContextMode,
    census: conciergeV1 ? (input.census ?? null) : null,
    promptBlock,
    adviceMetadata,
    outfitState,
    refinement,
    telemetry: {
      adviceIntent: intent,
      candidateCountsBySource: countsBySource,
      authorizedCount,
      rejectedCount,
      retrievalLatencyMs,
      scoringLatencyMs,
      groundedCandidateCount: shortlist.length,
      ownershipSourceCounts,
      purchaseVerdict: purchaseAdvice?.verdict ?? null,
      wardrobeGapCategoryCode: wardrobeGap?.gapCodes[0] ?? null,
      multiLookCount: looks?.length ?? 0,
      flagState: {
        adviceIntentsV1: flags.adviceIntentsV1,
        closetRetrievalV1: flags.closetRetrievalV1,
        compatibilityScoringV1: flags.compatibilityScoringV1,
        wardrobeGapV1: flags.wardrobeGapV1,
        purchaseAdviceV1: flags.purchaseAdviceV1,
        multiLookV1: flags.multiLookV1,
        conciergeV1,
      },
      stableErrorClass: partialFailure ? 'retrieval_partial_failure' : null,
      // Section 54: aggregate dimensions only. Every value below is an enum, a
      // boolean or a count -- none of them can carry item text.
      wardrobeContextMode,
      focusResolutionClass: focused.resolution,
      focusAmbiguous: focused.resolution === 'closet_text_ambiguous',
      censusExhaustive: input.census?.exhaustive ?? false,
      censusTotalItems: input.census?.totalItems ?? 0,
      refinementAction: refinement?.action,
      refinementContinued: refinement?.continued ?? false,
      refinementExcludedCount: refinement?.excludedCandidateIds.length ?? 0,
      refinementRetainedCount: refinement?.honouredRetainedIds.length ?? 0,
      refinementDroppedRetainedCount: refinement?.droppedRetainedIds.length ?? 0,
      outfitTurn: outfitState?.turn ?? 0,
    },
  };
}
