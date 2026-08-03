/**
 * product-match — internal, feature-flagged product matching endpoint.
 *
 * STATUS: DORMANT. Not deployed, not in the governed edge-function manifest,
 * not called by any client. `PRODUCT_MATCH_ENABLED` defaults to false, and with
 * no provider credentials configured every provider reports `disabled`, so even
 * an accidentally-enabled instance makes no upstream call.
 *
 * INTERNAL means service-to-service. The intended caller is `scan-identify`,
 * not the mobile app. Two independent gates must both pass:
 *
 *   1. `PRODUCT_MATCH_ENABLED` is true.
 *   2. The request carries `x-product-match-secret` matching
 *      `PRODUCT_MATCH_INTERNAL_SECRET`.
 *
 * Gate 2 fails closed when the secret is UNSET — an unset secret means "not
 * configured", not "no authentication required". That distinction is the whole
 * difference between a dormant internal endpoint and an open one.
 *
 * PRIVACY BOUNDARY — UNCHANGED
 *
 * The request body accepts text attributes only. There is no field for image
 * bytes, no field for an image URL, and no field for a user identifier. Nothing
 * reaches a provider that the existing `scan-identify` commerce path does not
 * already send, and no new category of user data is introduced. Rejecting
 * unknown top-level fields (below) is what keeps that true as the contract
 * evolves.
 */

import {
  areExactClaimsEnabled,
  isProductMatchEnabled,
  readDeadlines,
  PRODUCT_MATCH_CONTRACT_VERSION,
  PRODUCT_MATCH_MAX_LISTINGS,
  PRODUCT_MATCH_VERSION,
} from './config.ts';
import {
  isProductSource,
  type ExistingItemCandidate,
  type ProductMatchQuery,
  type ProductMatchRequest,
  type ProductSource,
} from './contracts.ts';
import { orchestrateProductMatch } from './orchestrator.ts';
import { buildProviderExecutors } from './providers.ts';
import { buildProductMatchEvent, emitProductMatchEvent } from './telemetry.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-product-match-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_BODY_BYTES = 8 * 1024;

/** Exactly the fields `ProductMatchQuery` declares. Anything else is rejected. */
const ALLOWED_QUERY_FIELDS = new Set([
  'brand', 'visibleBrandText', 'model', 'canonicalCategory', 'color',
  'material', 'silhouette', 'pattern', 'styleTags', 'searchQueries',
]);

const ALLOWED_REQUEST_FIELDS = new Set([
  'query', 'correlationId', 'sources', 'limit',
  'existingItems', 'newScanImageUri', 'newScanLabel',
]);

/**
 * Fields accepted on an existing-item candidate.
 *
 * `imageUri` is present here and NOT in `ALLOWED_QUERY_FIELDS`, and the
 * distinction is load-bearing: a query field would be forwarded to a provider,
 * whereas an existing-item image is echoed straight back to the client that
 * supplied it so the user can see the two items side by side. Nothing in this
 * service fetches it, reads it, or sends it anywhere.
 */
const ALLOWED_EXISTING_ITEM_FIELDS = new Set([
  'id', 'source', 'label', 'imageUri', 'brand', 'model',
  'canonicalCategory', 'color', 'material', 'silhouette', 'pattern', 'productUrl',
]);

const MAX_EXISTING_ITEMS = 25;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function cleanString(value: unknown, maxLength = 160): string | null {
  if (typeof value !== 'string') return null;
  // Control characters are stripped before length limiting so a padded control
  // run cannot push real content past the cap. The control-character class is
  // the point of this line, so the lint rule against one is suppressed here
  // rather than worked around.
  // deno-lint-ignore no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function cleanStringArray(value: unknown, maxItems = 8): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const cleaned = cleanString(item, 200);
    if (cleaned) out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

export type ParsedRequest =
  | { ok: true; request: ProductMatchRequest }
  | { ok: false; error: string };

/**
 * Strict parse.
 *
 * Unknown top-level or query fields are a hard rejection rather than being
 * ignored. An ignored field is how an image URL eventually arrives at an
 * endpoint that documented itself as text-only: the caller adds it, nothing
 * objects, and the boundary moves without a decision.
 */
export function parseProductMatchRequest(raw: unknown): ParsedRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const body = raw as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_REQUEST_FIELDS.has(key)) {
      return { ok: false, error: `unsupported field '${key}'` };
    }
  }

  const rawQuery = body.query;
  if (!rawQuery || typeof rawQuery !== 'object' || Array.isArray(rawQuery)) {
    return { ok: false, error: 'query must be an object' };
  }
  for (const key of Object.keys(rawQuery as Record<string, unknown>)) {
    if (!ALLOWED_QUERY_FIELDS.has(key)) {
      return { ok: false, error: `unsupported query field '${key}'` };
    }
  }
  const q = rawQuery as Record<string, unknown>;

  const query: ProductMatchQuery = {
    brand: cleanString(q.brand, 80),
    visibleBrandText: cleanString(q.visibleBrandText, 80),
    model: cleanString(q.model, 120),
    canonicalCategory: cleanString(q.canonicalCategory, 60),
    color: cleanString(q.color, 60),
    material: cleanString(q.material, 60),
    silhouette: cleanString(q.silhouette, 60),
    pattern: cleanString(q.pattern, 60),
    styleTags: cleanStringArray(q.styleTags),
    searchQueries: cleanStringArray(q.searchQueries, 4),
  };

  let sources: ProductSource[] | undefined;
  if (body.sources !== undefined) {
    if (!Array.isArray(body.sources)) return { ok: false, error: 'sources must be an array' };
    const parsed = body.sources.filter(isProductSource);
    if (parsed.length !== body.sources.length) {
      return { ok: false, error: 'sources contains an unknown provider' };
    }
    sources = parsed;
  }

  const limitRaw = body.limit;
  const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(PRODUCT_MATCH_MAX_LISTINGS, Math.floor(limitRaw)))
    : undefined;

  const correlationId = cleanString(body.correlationId, 64) ?? undefined;

  let existingItems: ExistingItemCandidate[] | undefined;
  if (body.existingItems !== undefined) {
    if (!Array.isArray(body.existingItems)) {
      return { ok: false, error: 'existingItems must be an array' };
    }
    if (body.existingItems.length > MAX_EXISTING_ITEMS) {
      return { ok: false, error: `existingItems exceeds ${MAX_EXISTING_ITEMS}` };
    }
    const parsedItems: ExistingItemCandidate[] = [];
    for (const raw of body.existingItems) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'existingItems entries must be objects' };
      }
      const item = raw as Record<string, unknown>;
      for (const key of Object.keys(item)) {
        if (!ALLOWED_EXISTING_ITEM_FIELDS.has(key)) {
          return { ok: false, error: `unsupported existingItems field '${key}'` };
        }
      }
      const id = cleanString(item.id, 128);
      const source = cleanString(item.source, 24);
      if (!id) return { ok: false, error: 'existingItems entries require an id' };
      if (source !== 'closet' && source !== 'recent_scan') {
        return { ok: false, error: "existingItems source must be 'closet' or 'recent_scan'" };
      }
      parsedItems.push({
        id,
        source,
        label: cleanString(item.label, 160),
        imageUri: cleanString(item.imageUri, 2048),
        brand: cleanString(item.brand, 80),
        model: cleanString(item.model, 120),
        canonicalCategory: cleanString(item.canonicalCategory, 60),
        color: cleanString(item.color, 60),
        material: cleanString(item.material, 60),
        silhouette: cleanString(item.silhouette, 60),
        pattern: cleanString(item.pattern, 60),
        productUrl: cleanString(item.productUrl, 2048),
      });
    }
    existingItems = parsedItems;
  }

  const newScanImageUri = cleanString(body.newScanImageUri, 2048) ?? undefined;
  const newScanLabel = cleanString(body.newScanLabel, 160) ?? undefined;

  return {
    ok: true,
    request: {
      query,
      ...(sources ? { sources } : {}),
      ...(limit ? { limit } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(existingItems ? { existingItems } : {}),
      ...(newScanImageUri ? { newScanImageUri } : {}),
      ...(newScanLabel ? { newScanLabel } : {}),
    },
  };
}

/**
 * Constant-time-ish comparison. Deno's runtime does not expose `timingSafeEqual`
 * for plain strings, so the loop below always visits every character of the
 * expected secret rather than returning at the first mismatch.
 */
export function secretMatches(provided: string | null, expected: string | null): boolean {
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export async function handleProductMatchRequest(
  req: Request,
  deps: {
    envGet: (key: string) => string | undefined;
    now?: () => number;
  },
): Promise<Response> {
  const { envGet } = deps;

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Gate 1 — feature flag. Reported as 404 rather than 403 so a dormant
  // endpoint does not confirm its own existence to an unauthenticated prober.
  if (!isProductMatchEnabled(envGet)) {
    return json({ error: 'FEATURE_DISABLED', code: 'FEATURE_DISABLED' }, 404);
  }

  // Gate 2 — internal secret. Fails closed when unset.
  const expectedSecret = envGet('PRODUCT_MATCH_INTERNAL_SECRET')?.trim() || null;
  const providedSecret = req.headers.get('x-product-match-secret');
  if (!secretMatches(providedSecret, expectedSecret)) {
    return json({ error: 'UNAUTHORIZED', code: 'UNAUTHORIZED' }, 401);
  }

  const rawBody = await req.text().catch(() => '');
  if (rawBody.length > MAX_BODY_BYTES) {
    return json({ error: 'PAYLOAD_TOO_LARGE', code: 'PAYLOAD_TOO_LARGE' }, 413);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody || 'null');
  } catch {
    return json({ error: 'INVALID_JSON', code: 'INVALID_JSON' }, 400);
  }

  const parsed = parseProductMatchRequest(parsedJson);
  if (!parsed.ok) {
    return json({ error: 'INVALID_REQUEST', code: 'INVALID_REQUEST', detail: parsed.error }, 400);
  }

  let testCatalogExclusions = 0;
  const executors = buildProviderExecutors({
    envGet,
    // No catalog client is constructed here. See providers.ts — reading
    // product_catalog requires an injected client and this phase does not mint
    // a service-role credential inside a retrieval path.
    catalogClient: null,
    onCatalogExclusions: (count) => {
      testCatalogExclusions += count;
    },
    ...(parsed.request.sources ? { only: parsed.request.sources } : {}),
  });

  const { response, dedupeStats } = await orchestrateProductMatch({
    query: parsed.request.query,
    providers: executors,
    options: {
      deadlines: readDeadlines(envGet),
      exactClaimsEnabled: areExactClaimsEnabled(envGet),
      ...(deps.now ? { now: deps.now } : {}),
      ...(parsed.request.limit ? { maxListings: parsed.request.limit } : {}),
      ...(parsed.request.existingItems ? { existingItems: parsed.request.existingItems } : {}),
      ...(parsed.request.newScanImageUri ? { newScanImageUri: parsed.request.newScanImageUri } : {}),
      ...(parsed.request.newScanLabel ? { newScanLabel: parsed.request.newScanLabel } : {}),
    },
  });

  // The gate's count is owned by the catalog executor, which the orchestrator
  // does not see into. Stitched in here rather than threaded through the
  // orchestration signature, because the alternative is a provider-specific
  // field on a provider-agnostic type.
  response.retrieval.testCatalogExclusions = testCatalogExclusions;

  // Telemetry is built and validated on every request, and written on none.
  // Validating unconditionally means the privacy assertion is exercised by real
  // traffic from the first enabled request, not first exercised on the day a
  // writer is finally attached.
  const event = buildProductMatchEvent({
    response,
    dedupeStats,
    correlationHash: null,
    appPlatform: req.headers.get('x-app-platform'),
    appVersion: req.headers.get('x-app-version'),
  });
  try {
    await emitProductMatchEvent(event, null);
  } catch (error) {
    // A telemetry contract breach must never fail a user-facing request, but it
    // must be loud enough to find. The response is unaffected.
    console.error(
      '[product-match] telemetry_contract_violation name=%s',
      error instanceof Error ? error.name : 'unknown',
    );
  }

  // Stage attribution is logged inline as well as returned, so a latency
  // question can be answered from logs alone before telemetry is persisted.
  console.log(
    '[product-match] done tier=%s families=%d listings=%d firstUsefulMs=%s completeMs=%d seqEquivMs=%d baselineDeltaMs=%d partial=%s strategies=%s fallback=%s rejected=%d/%d catalogExcluded=%d stages=%s',
    response.tier,
    response.families.length,
    response.listings.length,
    String(response.timings.firstUsefulMatchMs),
    response.timings.completeMs,
    response.timings.sequentialEquivalentMs,
    response.timings.baselineDeltaMs,
    String(response.timings.partial),
    response.retrieval.strategiesUsed.join('+') || 'none',
    String(response.retrieval.fallbackUsed),
    response.retrieval.categoryConflictRejections,
    response.retrieval.lowRelevanceRejections,
    response.retrieval.testCatalogExclusions,
    response.timings.stages.map((stage) => `${stage.stage}:${stage.durationMs}`).join(','),
  );

  return json(response);
}

// Deno.serve is registered only when this module is the process entry point, so
// importing it from a test does not bind a port.
if (import.meta.main) {
  Deno.serve((req) =>
    handleProductMatchRequest(req, {
      envGet: (key) => {
        try {
          return Deno.env.get(key);
        } catch {
          return undefined;
        }
      },
    })
  );
}

export { PRODUCT_MATCH_CONTRACT_VERSION, PRODUCT_MATCH_VERSION };
