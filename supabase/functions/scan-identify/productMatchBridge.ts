/**
 * scan-identify → product-match bridge.
 *
 * WHY AN HTTP HOP RATHER THAN AN IMPORT
 *
 * Importing the product-match modules directly would avoid a network call, but
 * it would merge the two dependency closures: `scan-identify`'s governed
 * manifest would grow by a dozen files, the two would have to be deployed
 * together forever, and a product-match defect would become a scan-identify
 * incident. The endpoint was designed for service-to-service use — it already
 * has an internal-secret gate — so the hop is what the design is for.
 *
 * The cost is real and is measured: `productMatchBridgeMs` is reported to the
 * caller and logged, so the hop shows up in stage attribution rather than
 * hiding inside the scan total.
 *
 * ADDITIVE ONLY — THE LEGACY PATH IS THE ROLLBACK PATH
 *
 * This bridge never removes, replaces or rewrites a legacy response field. It
 * returns a payload the caller merges alongside `recommendedProducts`,
 * `products` and `commerce`. Consequently:
 *
 *   - flag off  → byte-identical legacy behaviour
 *   - flag on, endpoint unreachable → legacy behaviour, plus a recorded reason
 *   - flag on, endpoint returns garbage → legacy behaviour, plus a reason
 *
 * There is no failure mode in which enabling this makes the scan worse than it
 * is today, because the legacy result is computed first and stands on its own.
 * That property is the whole point of building it this way, and
 * `requestProductMatch` is written to never throw so that it cannot be
 * violated by an unhandled rejection.
 */

export const PRODUCT_MATCH_BRIDGE_VERSION = 'scan-product-match-bridge-v1';

export type EnvGet = (key: string) => string | undefined;

const defaultEnvGet: EnvGet = (key) => {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
};

/**
 * Default OFF, and off is not merely a default here.
 *
 * `product-match` is not deployed. Turning this on before that function exists
 * produces one failed fetch per scan — harmless because of the additive design,
 * but pure waste. The activation order is: deploy product-match → set its
 * secret → enable it → THEN enable this bridge.
 */
export const PRODUCT_MATCH_BRIDGE_DEFAULT_ENABLED = false;

export function isProductMatchBridgeEnabled(envGet: EnvGet = defaultEnvGet): boolean {
  const raw = envGet('SCAN_PRODUCT_MATCH_ENABLED')?.trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  return PRODUCT_MATCH_BRIDGE_DEFAULT_ENABLED;
}

/**
 * Hang guard, not a latency budget.
 *
 * Consistent with the product-match ceilings: generous enough that a slow call
 * is MEASURED rather than truncated into an unattributable timeout. The scan
 * does not wait on this to produce its legacy answer.
 */
export const BRIDGE_DEADLINE_MS = 20000;

export type BridgeSkipReason =
  | 'disabled'
  | 'not_configured'
  | 'no_identification'
  | 'selection_required'
  | 'unreachable'
  | 'rejected'
  | 'malformed_response'
  | 'timeout';

export type BridgeOutcome = {
  attempted: boolean;
  /** Present when nothing usable came back. Never a provider message. */
  skipReason?: BridgeSkipReason;
  /** Wall clock for the hop, milliseconds. Recorded even on failure. */
  durationMs: number;
  /** The product-match response body, verbatim, when one arrived. */
  productMatch?: unknown;
};

/** Text attributes only — the same boundary product-match declares. */
export type BridgeQuery = {
  brand?: string | null;
  visibleBrandText?: string | null;
  model?: string | null;
  canonicalCategory?: string | null;
  /** Phase 7. See `ProductMatchQuery.clothingType` in product-match/contracts.ts. */
  clothingType?: string | null;
  color?: string | null;
  material?: string | null;
  silhouette?: string | null;
  pattern?: string | null;
  styleTags?: string[];
  searchQueries?: string[];
};

/**
 * Projects a scanner identification into the product-match query shape.
 *
 * Explicitly field-by-field rather than a spread. The scanner's identification
 * object carries far more than this — visual observations, confidence blocks,
 * raw model output — and a spread would forward all of it to a service that
 * documents itself as accepting text attributes only. Naming each field is what
 * keeps the privacy boundary a boundary instead of a comment.
 */
export function projectIdentificationToQuery(
  identification: Record<string, unknown> | undefined,
  attributes?: Record<string, unknown>,
): BridgeQuery | null {
  if (!identification || typeof identification !== 'object') return null;

  const pick = (source: Record<string, unknown> | undefined, ...keys: string[]): string | null => {
    if (!source) return null;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
    }
    return null;
  };

  const strings = (value: unknown, max = 8): string[] => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, max)
      .map((item) => item.trim().slice(0, 200));
  };

  const query: BridgeQuery = {
    brand: pick(identification, 'brand', 'brand_guess'),
    visibleBrandText: pick(identification, 'visible_brand_text'),
    model: pick(identification, 'model', 'subtype'),
    canonicalCategory: pick(identification, 'canonical_category', 'item_type', 'category'),
    // No fallback to category/subtype — same no-backfill rule normalizeToV2
    // follows. Absent stays absent rather than being synthesised.
    clothingType: pick(identification, 'clothing_type'),
    color: pick(identification, 'primary_color', 'color') ?? pick(attributes, 'color'),
    material: pick(identification, 'material') ?? pick(attributes, 'material', 'materialEstimate'),
    silhouette: pick(identification, 'silhouette') ?? pick(attributes, 'silhouette'),
    pattern: pick(identification, 'pattern') ?? pick(attributes, 'pattern'),
    styleTags: strings(identification.style_tags ?? attributes?.styleTags),
    searchQueries: strings(identification.search_queries, 4),
  };

  const hasSignal = Object.entries(query).some(([, value]) =>
    typeof value === 'string' ? value.length > 0 : Array.isArray(value) && value.length > 0
  );
  return hasSignal ? query : null;
}

export type BridgeDependencies = {
  envGet?: EnvGet;
  /** Injectable for tests. Never called when the bridge is disabled. */
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/**
 * Calls the internal product-match endpoint.
 *
 * NEVER THROWS. Every failure path returns a `BridgeOutcome` with a
 * `skipReason`, because the caller has already computed a valid legacy result
 * and an exception here would discard it.
 */
export async function requestProductMatch(
  input: {
    query: BridgeQuery | null;
    selectionRequired?: boolean;
    existingItems?: unknown[];
    newScanImageUri?: string | null;
    newScanLabel?: string | null;
    correlationId?: string | null;
  },
  deps: BridgeDependencies = {},
): Promise<BridgeOutcome> {
  const envGet = deps.envGet ?? defaultEnvGet;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const skip = (skipReason: BridgeSkipReason): BridgeOutcome => ({
    attempted: false,
    skipReason,
    durationMs: now() - startedAt,
  });

  if (!isProductMatchBridgeEnabled(envGet)) return skip('disabled');

  // A multi-item scan has no single item to match. Calling anyway would mean
  // matching products against a garment nobody chose — the exact guess the
  // selection contract exists to prevent.
  if (input.selectionRequired) return skip('selection_required');

  if (!input.query) return skip('no_identification');

  const baseUrl = envGet('SUPABASE_URL')?.trim();
  const secret = envGet('PRODUCT_MATCH_INTERNAL_SECRET')?.trim();
  if (!baseUrl || !secret) return skip('not_configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_DEADLINE_MS);

  try {
    const response = await (deps.fetchImpl ?? fetch)(
      `${baseUrl.replace(/\/+$/, '')}/functions/v1/product-match`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-product-match-secret': secret,
        },
        body: JSON.stringify({
          query: input.query,
          ...(input.existingItems?.length ? { existingItems: input.existingItems } : {}),
          ...(input.newScanImageUri ? { newScanImageUri: input.newScanImageUri } : {}),
          ...(input.newScanLabel ? { newScanLabel: input.newScanLabel } : {}),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        }),
        signal: controller.signal,
      },
    );

    const durationMs = now() - startedAt;

    if (!response.ok) {
      // 404 is the expected answer while product-match is dormant. Recorded as
      // `rejected` rather than logged as an error, because a dormant dependency
      // is a configuration state, not an incident.
      return { attempted: true, skipReason: 'rejected', durationMs };
    }

    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object') {
      return { attempted: true, skipReason: 'malformed_response', durationMs };
    }

    return { attempted: true, durationMs, productMatch: payload };
  } catch (error) {
    const durationMs = now() - startedAt;
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    return { attempted: true, skipReason: aborted ? 'timeout' : 'unreachable', durationMs };
  } finally {
    clearTimeout(timer);
  }
}
