/**
 * Checkpoint 5A — the iOS binding between the scanner and the shared
 * similarity attachment.
 *
 * WHY THIS FILE IS PER-PLATFORM AND DELIBERATELY THIN
 *
 * `scannerSimilarityAttachment.ts` and `similarItemCandidateProvider.ts` are
 * byte-identical across both platform lines. They stay that way because the
 * modules they would otherwise have to import — `services/library.js`,
 * `services/savedScansCloud.ts` — are exactly the ones that genuinely diverge
 * (this line supports a durable ownerless partition and its `deleteScan` takes
 * a different parameter contract than the Android line's).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ANDROID/iOS DIVERGENCE IN THIS FILE — how the actor is resolved
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Android line's `useKScan(actorId)` receives the actor from `app.js` and
 * passes it down, so its binding takes `actorId` as a required input.
 *
 * This line's `useKScan()` takes no actor at all and has no `useAuthSession`
 * usage anywhere in it. Its existing scan-save path resolves ownership through
 * the module-scoped actor context instead (`createActorRequest()` at the start
 * of the operation, `resolveWriteAuthority` inside `saveScan`). This binding
 * follows that same precedent rather than importing a React hook into a
 * service module: `getActorContext()` supplies the actor, and the captured
 * request is re-validated after every await.
 *
 * ACCOUNT ISOLATION IS THE POINT OF THIS FILE
 *
 * `loadClosetTyped()` and `loadLibrary()` called with NO argument return EVERY
 * partition of EVERY account — a documented test-only affordance, and the API
 * fails OPEN. This module therefore never calls either loader without an
 * explicit actor argument. A missing session yields the ownerless partition or
 * nothing; it never yields an unfiltered read.
 */

import { loadClosetTyped } from './closetLibrary';
import { loadLibrary } from './library';
import { createActorRequest, getActorContext, isActorRequestCurrent } from './actorContext';
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
 *
 * Byte-identical to the Android line's implementation; kept here rather than
 * shared because the surrounding actor resolution genuinely differs and
 * splitting one small pure function into a third module would obscure that.
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

  for (const key of Object.keys(query) as Array<keyof ClientScanQuery>) {
    if (query[key] === null || query[key] === undefined) delete query[key];
  }
  return query;
}

export type BuildBindingInput = {
  /**
   * Optional on this line. When omitted the actor is read from the module
   * actor context, which is how every other iOS scan-time operation resolves
   * ownership. `null` is the ownerless device-local partition, which is a real
   * durable partition on iOS.
   */
  actorId?: string | null;
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

  // One request captured for the whole attachment. Both loaders re-validate it
  // after their await, so a sign-out or actor switch mid-load yields no
  // records instead of another actor's wardrobe.
  const actorRequest = createActorRequest();

  // Explicit `undefined` would make both loaders read every account. Resolving
  // to a concrete `string | null` here makes that fail-open default
  // unreachable from this path.
  const supplied = input.actorId === undefined ? getActorContext()?.actorId : input.actorId;
  const actorId: string | null =
    typeof supplied === 'string' && supplied.trim() ? supplied.trim() : null;

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
