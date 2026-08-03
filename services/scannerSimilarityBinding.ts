/**
 * Checkpoint 5A — the ANDROID binding between the scanner and the shared
 * similarity attachment.
 *
 * WHY THIS FILE IS PER-PLATFORM AND DELIBERATELY THIN
 *
 * `scannerSimilarityAttachment.ts` and `similarItemCandidateProvider.ts` are
 * byte-identical across both platform lines. They stay that way because the
 * modules they would otherwise have to import — `services/library.js`,
 * `services/savedScansCloud.ts` — are exactly the ones that genuinely diverge
 * (this line refuses ownerless scan writes; the iOS line supports a durable
 * ownerless partition, and `deleteScan` has a different parameter contract).
 *
 * So the platform-specific part is isolated HERE: which loaders this line has,
 * and how this line resolves its actor. Everything else is shared.
 *
 * ACCOUNT ISOLATION IS THE POINT OF THIS FILE
 *
 * `loadClosetTyped()` and `loadLibrary()` called with NO argument return EVERY
 * partition of EVERY account — that is a documented test-only affordance, and
 * the API fails OPEN. This module therefore never calls either loader without
 * an explicit actor argument, and refuses to build a binding at all when it has
 * not been given one. A missing session produces NO candidates; it never
 * produces an unfiltered read.
 */

import { loadClosetTyped } from './closetLibrary';
import { loadLibrary } from './library';
import { createActorRequest, isActorRequestCurrent } from './actorContext';
import { SCAN_SIMILAR_ITEM_ENABLED } from '../constants/featureFlags';
import type { ClientScanQuery } from './similarItemCandidates';
import type { SimilarityBinding } from './scannerSimilarityAttachment';
import type { SimilarityLedger } from './similarityRequestLedger';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstText(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = text(entry);
      if (found) return found;
    }
    return null;
  }
  return text(value);
}

/**
 * Projects the garment the user actually chose into the scan-side query.
 *
 * READ FROM THE SELECTED GARMENT, NEVER FROM THE IMAGE.
 *
 * A multi-item photo has image-level `attributes` describing the whole outfit.
 * Using those to prune candidates for ONE selected garment would compare a
 * jacket against the colour of the trousers beside it — the "guessed garment"
 * failure in a subtler form. Only the garment's own detected fields are read.
 *
 * Returns an empty query when the garment carries nothing comparable, which
 * the attachment layer treats as "no resolved identity" and declines to load.
 */
export function buildSimilarityQueryFromGarment(garment: unknown): ClientScanQuery {
  if (!garment || typeof garment !== 'object') return {};
  const g = garment as Record<string, unknown>;
  const attributes = (g.attributes ?? {}) as Record<string, unknown>;
  const identification = (g.identification ?? {}) as Record<string, unknown>;

  const query: ClientScanQuery = {
    brand: text(identification.brand_guess),
    visibleBrandText: text(identification.visible_brand_text),
    canonicalCategory: text(g.category) ?? text(attributes.category),
    subtype: text(g.subtype) ?? text(identification.subtype) ?? text(attributes.itemType),
    color: text(identification.primary_color) ?? firstText(attributes.colorPalette),
    material: text(identification.material_estimate) ?? text(attributes.materialEstimate),
    silhouette: text(identification.silhouette) ?? text(attributes.silhouette),
    pattern: text(identification.pattern) ?? text(attributes.pattern),
  };

  // Drop nulls so the query carries only what was actually observed.
  for (const key of Object.keys(query) as Array<keyof ClientScanQuery>) {
    if (query[key] === null || query[key] === undefined) delete query[key];
  }
  return query;
}

export type BuildBindingInput = {
  /** The signed-in actor. `null` is the ownerless device-local partition. */
  actorId: string | null;
  /** Correlates this candidate set to this scan. */
  scanId: string;
  /** The garment the user selected, as detected. */
  garment: unknown;
  ledger?: SimilarityLedger | null;
  /** Overridable so a test can drive both flag states without touching env. */
  enabled?: boolean;
  onInstrumentation?: SimilarityBinding['onInstrumentation'];
};

/**
 * Builds the binding, or returns null when similarity must not run.
 *
 * Null (rather than a disabled binding) when there is nothing to correlate,
 * so the request carries no similarity field at all and is byte-identical to
 * the pre-mount one.
 */
export function buildScannerSimilarityBinding(
  input: BuildBindingInput,
): SimilarityBinding | null {
  const enabled = input.enabled ?? SCAN_SIMILAR_ITEM_ENABLED;
  if (!enabled) return null;
  if (!text(input.scanId)) return null;

  const query = buildSimilarityQueryFromGarment(input.garment);
  if (Object.keys(query).length === 0) return null;

  // `actorId === undefined` would make both loaders read every account. The
  // parameter is typed `string | null`, and this guard makes the fail-open
  // default unreachable from this path regardless of what a caller passes.
  const actorId: string | null =
    typeof input.actorId === 'string' && input.actorId.trim() ? input.actorId.trim() : null;

  // One request captured for the whole attachment. Both loaders re-validate it
  // after their await, so a sign-out or actor switch mid-load yields no
  // records instead of another actor's wardrobe.
  const actorRequest = createActorRequest();

  return {
    enabled: true,
    scanId: input.scanId,
    query,
    loadClosetRecords: async () => {
      const result = await loadClosetTyped(actorId, { actorRequest });
      if (!isActorRequestCurrent(actorRequest)) return [];
      return result?.ok && Array.isArray(result.items) ? result.items : [];
    },
    loadRecentScanRecords: async () => {
      const records = await loadLibrary(actorId);
      if (!isActorRequestCurrent(actorRequest)) return [];
      return Array.isArray(records) ? records : [];
    },
    ledger: input.ledger ?? null,
    ...(input.onInstrumentation ? { onInstrumentation: input.onInstrumentation } : {}),
  };
}
