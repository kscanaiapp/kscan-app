import { createClient } from 'npm:@supabase/supabase-js@2';

export type ScanIntelligenceInput = {
  scanId: string;
  userId: string | null;
  mode: 'image';
  identification: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  isFashion: boolean;
  commerce?: {
    provider?: string;
    providersTried?: string[];
    query?: string;
    count?: number;
    catalogCount?: number;
  };
  recommendedProducts?: unknown[];
  imageHash: null;
  appPlatform: string | null;
  appVersion: string | null;
};

type ScanIntelligenceRow = {
  scan_id: string;
  user_id: string | null;
  mode: 'image';
  is_fashion: boolean;
  category: string | null;
  item_type: string | null;
  subtype: string | null;
  brand_guess: string | null;
  visible_brand_text: string | null;
  primary_color: string | null;
  material: string | null;
  silhouette: string | null;
  pattern: string | null;
  style_tags: string[] | null;
  search_queries: string[] | null;
  confidence: number | Record<string, unknown> | null;
  commerce_query: string | null;
  commerce_provider: string | null;
  providers_tried: string[] | null;
  commerce_result_count: number | null;
  catalog_count: number | null;
  recommended_product_sources: string[] | null;
  recommended_product_types: string[] | null;
  image_hash: null;
  app_platform: string | null;
  app_version: string | null;
};

const SCAN_INTELLIGENCE_TABLE = 'scan_intelligence_events';
const MAX_STRING_LEN = 120;
const MAX_QUERY_LEN = 200;
const MAX_LIST_ITEMS = 12;

function safeString(value: unknown, maxLen = MAX_STRING_LEN): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function safeStringArray(value: unknown, maxLen = MAX_STRING_LEN): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = safeString(entry, maxLen);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out.length ? out : null;
}

function safeFiniteNumber(value: unknown): number | null {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num)) return null;
  return num;
}

function safeConfidenceValue(
  identification: Record<string, unknown>,
  attributes?: Record<string, unknown>,
): number | Record<string, unknown> | null {
  const numeric =
    safeFiniteNumber(identification.confidence) ??
    safeFiniteNumber(identification.confidence_score) ??
    safeFiniteNumber(attributes?.confidence) ??
    safeFiniteNumber(attributes?.confidenceScore);
  if (numeric !== null) return Math.max(0, Math.min(1, numeric));

  const raw = identification.confidence;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const score = safeFiniteNumber((raw as Record<string, unknown>).score);
  const label = safeString((raw as Record<string, unknown>).label, 40);
  const out: Record<string, unknown> = {};
  if (score !== null) out.score = Math.max(0, Math.min(1, score));
  if (label) out.label = label;
  return Object.keys(out).length ? out : null;
}

function isCatalogProduct(product: Record<string, unknown>): boolean {
  const type = safeString(product.type, 20)?.toLowerCase();
  if (type === 'catalog') return true;
  return !type;
}

function summarizeRecommendedProducts(
  recommendedProducts: unknown[] | undefined,
  commerce?: ScanIntelligenceInput['commerce'],
): {
  sources: string[] | null;
  types: string[] | null;
} {
  if (!Array.isArray(recommendedProducts) || recommendedProducts.length === 0) {
    return { sources: null, types: null };
  }

  const sources = new Set<string>();
  const types = new Set<string>();
  const liveProvider =
    safeString(commerce?.provider, 20)?.toLowerCase() === 'serper'
      ? 'Serper'
      : safeString(commerce?.provider, 20)?.toLowerCase() === 'brave'
      ? 'Brave'
      : null;

  for (const rawProduct of recommendedProducts) {
    if (!rawProduct || typeof rawProduct !== 'object' || Array.isArray(rawProduct)) continue;
    const product = rawProduct as Record<string, unknown>;
    if (isCatalogProduct(product)) {
      sources.add('Catalog');
      types.add('catalog');
      continue;
    }

    const type = safeString(product.type, 20)?.toLowerCase();
    if (type === 'retail' || type === 'similar') {
      types.add(type);
    }
    if (liveProvider) {
      sources.add(liveProvider);
    }
  }

  return {
    sources: sources.size ? Array.from(sources) : null,
    types: types.size ? Array.from(types) : null,
  };
}

export function buildScanIntelligenceRow(input: ScanIntelligenceInput): ScanIntelligenceRow {
  const identification = input.identification || {};
  const attributes = input.attributes || {};
  const recommendedSummary = summarizeRecommendedProducts(input.recommendedProducts, input.commerce);
  const palette = safeStringArray(attributes.colorPalette);

  return {
    scan_id: input.scanId,
    user_id: input.userId,
    mode: 'image',
    is_fashion: input.isFashion,
    category:
      safeString(attributes.category) ??
      safeString(identification.category) ??
      safeString(identification.item_type),
    item_type:
      safeString(identification.item_type) ??
      safeString(identification.itemType) ??
      safeString(attributes.itemType),
    subtype: safeString(identification.subtype),
    brand_guess:
      safeString(identification.brand_guess) ??
      safeString(identification.brand) ??
      safeString(attributes.brand),
    visible_brand_text: safeString(identification.visible_brand_text),
    primary_color:
      safeString(identification.primary_color) ??
      safeString(attributes.color) ??
      safeString(identification.color) ??
      (palette?.[0] ?? null),
    material:
      safeString(identification.material_estimate) ??
      safeString(attributes.material) ??
      safeString(identification.material) ??
      safeString(attributes.materialEstimate),
    silhouette: safeString(identification.silhouette) ?? safeString(attributes.silhouette),
    pattern: safeString(identification.pattern) ?? safeString(attributes.pattern),
    style_tags:
      safeStringArray(identification.style_tags) ??
      safeStringArray(attributes.styleTags),
    search_queries: safeStringArray(identification.search_queries, MAX_QUERY_LEN),
    confidence: safeConfidenceValue(identification, attributes),
    commerce_query: safeString(input.commerce?.query, MAX_QUERY_LEN),
    commerce_provider: safeString(input.commerce?.provider, 20),
    providers_tried: safeStringArray(input.commerce?.providersTried, 20),
    commerce_result_count: safeFiniteNumber(input.commerce?.count),
    catalog_count: safeFiniteNumber(input.commerce?.catalogCount),
    recommended_product_sources: recommendedSummary.sources,
    recommended_product_types: recommendedSummary.types,
    image_hash: null,
    app_platform: safeString(input.appPlatform, 40),
    app_version: safeString(input.appVersion, 40),
  };
}

function isMissingTableError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  const code = safeString(error?.code, 20)?.toUpperCase();
  const message = safeString(error?.message, 200)?.toLowerCase() ?? '';
  return code === 'PGRST205' ||
    message.includes('does not exist') ||
    message.includes('schema cache') ||
    message.includes('could not find the table');
}

export async function captureScanIntelligence(input: ScanIntelligenceInput): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      console.warn('[ScanIntelligence]', {
        event: 'service_role_unavailable',
        table: SCAN_INTELLIGENCE_TABLE,
        scanId: input.scanId,
      });
      return;
    }

    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const row = buildScanIntelligenceRow(input);
    const { error } = await client.from(SCAN_INTELLIGENCE_TABLE).insert(row);
    if (!error) return;

    if (isMissingTableError(error)) {
      console.warn('[ScanIntelligence]', {
        event: 'insert_skipped_missing_table',
        errorType: 'missing_table',
        table: SCAN_INTELLIGENCE_TABLE,
        scanId: input.scanId,
      });
      return;
    }

    console.warn('[ScanIntelligence]', {
      event: 'insert_failed',
      errorType: safeString(error.code, 30) ?? 'insert_error',
      table: SCAN_INTELLIGENCE_TABLE,
      scanId: input.scanId,
    });
  } catch (error) {
    console.warn('[ScanIntelligence]', {
      event: 'insert_failed',
      errorType: error instanceof Error ? error.name : 'unknown',
      table: SCAN_INTELLIGENCE_TABLE,
      scanId: input.scanId,
    });
  }
}
