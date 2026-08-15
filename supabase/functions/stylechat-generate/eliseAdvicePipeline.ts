/**
 * E-4 closet-aware advice pipeline orchestrator.
 */

import type { EliseVisualContextEnvelope } from './eliseVisualContextTypes.ts';
import type {
  EliseAdvicePipelineResult,
  EliseAdviceIntent,
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
import type { ClosetInventoryState } from './closetIntelligenceContext.ts';
import { rankAndBoundCandidates } from './eliseCompatibilityScoring.ts';
import {
  analyzeWardrobeGap,
  buildMultiLooks,
  buildPurchaseAdvice,
} from './eliseWardrobeGap.ts';
import {
  buildEliseAdviceMetadata,
  buildEliseAdvicePromptBlock,
} from './eliseAdvicePrompt.ts';

export interface EliseAdviceFlagState {
  adviceIntentsV1: boolean;
  closetRetrievalV1: boolean;
  compatibilityScoringV1: boolean;
  wardrobeGapV1: boolean;
  purchaseAdviceV1: boolean;
  multiLookV1: boolean;
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
  /** Server-derived room scope may require shared retrieval regardless of prose. */
  includeShared?: boolean;
  weatherSummary?: string | null;
  signatureStyleSummary?: string | null;
}): Promise<EliseAdvicePipelineResult | null> {
  const flags = input.flags;
  if (!flags.adviceIntentsV1) return null;

  const noShopping = /\b(without\s+buying|no\s+shopping|closet\s+only)\b/i.test(input.message);
  const intent: EliseAdviceIntent = classifyEliseAdviceIntent(input.message, {
    preferClosetFirst: true,
    noShopping,
  });

  const focused = resolveEliseFocusedItem({ envelope: input.envelope });

  let shortlist = [] as ReturnType<typeof rankAndBoundCandidates>;
  let retrievalLatencyMs = 0;
  let scoringLatencyMs = 0;
  let authorizedCount = 0;
  let rejectedCount = 0;
  let countsBySource: Record<string, number> = {};
  let ownershipSourceCounts: Record<string, number> = {};
  let partialFailure = false;
  let inventoryCount = 0;
  let closetInventoryState: ClosetInventoryState = 'unavailable';

  if (flags.closetRetrievalV1) {
    const retrieval = await retrieveAuthorizedWardrobeCandidates({
      actorId: input.actorId,
      intent,
      message: input.message,
      data: input.data,
      includeShared: input.includeShared,
    });
    retrievalLatencyMs = retrieval.retrievalLatencyMs;
    authorizedCount = retrieval.authorizedCount;
    rejectedCount = retrieval.rejectedCount;
    countsBySource = retrieval.countsBySource;
    ownershipSourceCounts = retrieval.ownershipSourceCounts;
    partialFailure = retrieval.partialFailure;
    closetInventoryState = retrieval.closetInventoryState;
    inventoryCount = retrieval.candidates.filter(
      (candidate) => candidate.sourceType === 'closet' && candidate.actorRelationship === 'owned',
    ).length;

    if (flags.compatibilityScoringV1) {
      const scoreStarted = Date.now();
      shortlist = rankAndBoundCandidates({
        focus: focused,
        candidates: retrieval.candidates,
        intent,
        occasionTokens: extractOccasionTokens(input.message),
        seasonTokens: extractSeasonTokens(input.message, input.weatherSummary),
        signatureStyleTokens: extractSignatureTokens(input.signatureStyleSummary),
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

  const wardrobeGap =
    flags.wardrobeGapV1 &&
    (intent === 'wardrobe_gap' || intent === 'build_outfit' || intent === 'multi_look_generation')
      ? analyzeWardrobeGap({
          focus: focused,
          shortlist: shortlist.filter(
            (row) => row.candidate.sourceType === 'closet' && row.candidate.actorRelationship === 'owned',
          ),
          inventoryCount,
          inventoryState: closetInventoryState,
        })
      : null;

  const purchaseAdvice =
    flags.purchaseAdviceV1 && (intent === 'purchase_advice' || intent === 'wardrobe_gap')
      ? buildPurchaseAdvice({ intent, focus: focused, shortlist, wardrobeGap })
      : null;

  const looks =
    flags.multiLookV1 && (intent === 'multi_look_generation' || intent === 'build_outfit')
      ? buildMultiLooks({ intent, shortlist, wardrobeGap })
      : null;

  const promptBlock = buildEliseAdvicePromptBlock({
    intent,
    focused,
    shortlist,
    wardrobeGap,
    purchaseAdvice,
    looks,
  });

  const adviceMetadata = buildEliseAdviceMetadata({
    intent,
    focused,
    shortlist,
    wardrobeGap,
    purchaseAdvice,
    looks,
  });

  return {
    intent,
    focused,
    shortlist,
    wardrobeGap,
    purchaseAdvice,
    looks,
    promptBlock,
    adviceMetadata,
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
      },
      stableErrorClass: partialFailure ? 'retrieval_partial_failure' : null,
    },
  };
}
