/**
 * Checkpoint 3 wiring — one entry point, called once, at the end of the scan.
 *
 * WHY IT IS A SINGLE FUNCTION
 *
 * `scan-identify/index.ts` is ~3400 lines and is the most load-bearing deployed
 * function in the product. Threading three new features through its assembly
 * would produce a diff nobody can review against a function nobody can safely
 * break. Everything Checkpoint 3 adds happens here instead, taking the finished
 * response as input and returning a finished response.
 *
 * The consequence worth stating: this runs AFTER the legacy result is complete.
 * The legacy answer is never waited on, weakened, or made conditional. If every
 * line below were deleted, the scan would still work exactly as it does in
 * production today — which is the definition of the rollback path being intact.
 *
 * THREE FLAGS, ALL DEFAULT OFF
 *
 *   SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED  the selection state + no guess
 *   SCAN_PRODUCT_MATCH_ENABLED                   the product-match hop
 *   SCAN_SIMILAR_ITEM_FLAG_ENABLED               advisory closet comparison
 *
 * They are separate because they fail independently and roll back
 * independently. Bundling them behind one flag would mean a problem with the
 * similarity engine forces the selection fix off too, and the selection fix is
 * the one repairing a funnel that currently loses every multi-item scan.
 */

import {
  buildSelectionRequiredPayload,
  isSelectionContractEnabled,
  suppressGuessedPrimary,
  suppressV2GuessedIdentity,
  type SelectionLineage,
} from './multiItemSelectionContract.ts';
import {
  isProductMatchBridgeEnabled,
  projectIdentificationToQuery,
  requestProductMatch,
  type BridgeDependencies,
  type BridgeOutcome,
} from './productMatchBridge.ts';
import {
  deriveScanJourneyState,
  type ScanJourneyState,
} from '../_shared/scanJourneyState.ts';

export type EnvGet = (key: string) => string | undefined;

const defaultEnvGet: EnvGet = (key) => {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
};

/**
 * Advisory similarity is gated separately from the bridge.
 *
 * The flagging ENGINE is not validated yet — thresholds are uncalibrated, and
 * the false-positive and false-negative rates are unmeasured. Checkpoint 3
 * wires the plumbing and proves the flow; a dedicated pass validates the
 * quality. Until that pass runs, this flag stays off in every environment, and
 * turning it on is a decision about a known-unvalidated engine rather than an
 * incidental consequence of enabling product matching.
 */
export const SIMILAR_ITEM_FLAG_DEFAULT_ENABLED = false;

export function isSimilarItemFlagEnabled(envGet: EnvGet = defaultEnvGet): boolean {
  const raw = envGet('SCAN_SIMILAR_ITEM_FLAG_ENABLED')?.trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  return SIMILAR_ITEM_FLAG_DEFAULT_ENABLED;
}

/**
 * What the similarity validation pass will need to measure, recorded per
 * request.
 *
 * Emitted even when the flag is off (with `enabled: false`), because "how many
 * candidates would we have compared against, and from which sources" is a
 * question the calibration pass has to answer BEFORE the engine is switched on.
 * Collecting it only once the feature is live would mean tuning thresholds
 * against a population nobody had measured.
 */
export type SimilaritySeam = {
  enabled: boolean;
  /** Sources the caller actually supplied candidates from. */
  sourcesChecked: Array<'closet' | 'recent_scan'>;
  /** How many candidates were available for comparison. */
  candidatesAvailable: number;
  /** Which query attributes were non-empty and therefore usable as inputs. */
  comparisonInputs: string[];
  /** Comparisons returned. Zero is a real and expected answer. */
  flagged: number;
  durationMs: number;
};

export type ScanJourneyContractInput = {
  finalResponse: Record<string, unknown>;
  useMultiItemDetectionProvider: boolean;
  detectedGarments: Array<Record<string, unknown>>;
  scanId: string;
  scanSessionId?: string | null;
  imageDigestPrefix?: string | null;
  evidenceId?: string | null;
  recommendedProductCount: number;
  identification?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  existingItems?: unknown[];
  mode: string;
  /** Injected in tests. Production uses the real env and fetch. */
  deps?: BridgeDependencies & { envGet?: EnvGet };
};

function usableInputs(query: Record<string, unknown> | null): string[] {
  if (!query) return [];
  return Object.entries(query)
    .filter(([, value]) =>
      typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) && value.length > 0
    )
    .map(([key]) => key)
    .sort();
}

function sourcesOf(existingItems: unknown[] | undefined): Array<'closet' | 'recent_scan'> {
  const found = new Set<'closet' | 'recent_scan'>();
  for (const raw of existingItems ?? []) {
    const source = (raw as { source?: unknown } | null)?.source;
    if (source === 'closet' || source === 'recent_scan') found.add(source);
  }
  // Stable order so the seam is comparable across requests.
  return (['closet', 'recent_scan'] as const).filter((source) => found.has(source));
}

/**
 * Applies the Checkpoint 3 contracts to a completed response.
 *
 * Never throws: a failure here would discard a valid scan result. Every branch
 * either adds fields or leaves the response exactly as it found it.
 */
export async function applyScanJourneyContract(
  input: ScanJourneyContractInput,
): Promise<Record<string, unknown>> {
  const envGet = input.deps?.envGet ?? defaultEnvGet;
  let response = input.finalResponse;

  try {
    const lineage: SelectionLineage = {
      scanId: input.scanId,
      scanSessionId: input.scanSessionId ?? null,
      imageDigestPrefix: input.imageDigestPrefix ?? null,
      evidenceId: input.evidenceId ?? null,
    };

    // ── 1. Multi-item selection ───────────────────────────────────────────
    let selectionRequired = false;
    if (input.useMultiItemDetectionProvider && isSelectionContractEnabled(envGet)) {
      const payload = buildSelectionRequiredPayload({
        detectedGarments: input.detectedGarments,
        lineage,
      });
      if (payload) {
        selectionRequired = true;
        // Suppression happens BEFORE the merge so the guessed primary cannot
        // survive by being re-added from the spread.
        response = { ...suppressGuessedPrimary(response), ...payload };
        // …and again one level down. A V2 envelope treats
        // `multiple_items_need_selection` as identity-bearing, so it carries
        // the same guessed category/subtype/brand that was just stripped from
        // the legacy fields. Stripping only the top level would move the guess
        // rather than remove it.
        if (response.identificationV2) {
          response = {
            ...response,
            identificationV2: suppressV2GuessedIdentity(response.identificationV2),
          };
        }
      }
    }

    // ── 2. Product match ──────────────────────────────────────────────────
    const query = selectionRequired
      ? null
      : projectIdentificationToQuery(input.identification, input.attributes);

    let bridge: BridgeOutcome | null = null;
    if (isProductMatchBridgeEnabled(envGet)) {
      const similarityEnabled = isSimilarItemFlagEnabled(envGet);
      bridge = await requestProductMatch(
        {
          query,
          selectionRequired,
          // Candidates are only forwarded when the similarity flag is on. With
          // it off the endpoint receives no closet data at all, rather than
          // receiving it and declining to use it.
          ...(similarityEnabled && input.existingItems?.length
            ? { existingItems: input.existingItems }
            : {}),
          correlationId: input.scanId.slice(0, 64),
        },
        input.deps ?? {},
      );
      if (bridge.productMatch) {
        response = { ...response, productMatch: bridge.productMatch };
      }
    }

    // ── 3. Similarity seam ────────────────────────────────────────────────
    const productMatch = bridge?.productMatch as
      | { potentialSimilarItems?: unknown[] }
      | undefined;
    const similarity: SimilaritySeam = {
      enabled: isSimilarItemFlagEnabled(envGet),
      sourcesChecked: sourcesOf(input.existingItems),
      candidatesAvailable: Array.isArray(input.existingItems) ? input.existingItems.length : 0,
      comparisonInputs: usableInputs(query as Record<string, unknown> | null),
      flagged: Array.isArray(productMatch?.potentialSimilarItems)
        ? productMatch.potentialSimilarItems.length
        : 0,
      durationMs: 0,
    };

    // ── 4. Journey state ──────────────────────────────────────────────────
    const enriched = Boolean(productMatch);
    const confidentMatch = typeof (productMatch as { tier?: unknown } | undefined)?.tier === 'string'
      && (productMatch as { tier: string }).tier !== 'NO_CONFIDENT_MATCH';

    const applicationState: ScanJourneyState = deriveScanJourneyState({
      failed: response.status === 'failed',
      selectionRequired,
      identified: Boolean(input.identification),
      candidateCount: input.recommendedProductCount,
      enriched,
      confidentMatch,
    });

    response = {
      ...response,
      applicationState,
      scanJourney: {
        state: applicationState,
        selectionRequired,
        productMatch: bridge
          ? {
            attempted: bridge.attempted,
            durationMs: bridge.durationMs,
            ...(bridge.skipReason ? { skipReason: bridge.skipReason } : {}),
          }
          : { attempted: false, durationMs: 0, skipReason: 'disabled' as const },
        similarity,
      },
    };

    return response;
  } catch (error) {
    // A contract-layer defect must never cost the user their scan result.
    console.warn(
      '[scan-identify] scan_journey_contract_failed name=%s',
      error instanceof Error ? error.name : 'unknown',
    );
    return input.finalResponse;
  }
}
