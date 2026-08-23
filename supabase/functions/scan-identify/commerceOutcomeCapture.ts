/**
 * Privacy-safe unified commerce outcome persistence (v123).
 * One summarized event per request. Never blocks the client response.
 *
 * Prohibited in persisted rows:
 *   images, base64, raw TextScan text, prompts, provider payloads,
 *   tokens, emails, full user/session/digest IDs, product/image/purchase URLs
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  COMMERCE_OUTCOME_CAPTURE_TIMEOUT_MS,
  COMMERCE_OUTCOME_CAPTURE_VERSION,
  isCommerceOutcomeCaptureEnabled,
} from './commerceOutcomeCaptureConfig.ts';
import { assertQualityMetricsPrivacy } from './qualityTuneTelemetry.ts';
import { sanitizeFailureReason, type FailureReason } from './commerceRelevanceFailure.ts';
import { TEXTSCAN_COMMERCE_PARITY_VERSION } from './textScanCommerceParityConfig.ts';
import { COMMERCE_RELEVANCE_VERSION } from './commerceRelevanceConfig.ts';
import { SCANNER_INTELLIGENCE_VERSION } from './scannerIntelligenceConfig.ts';
import { QUALITY_TUNE_VERSION } from './qualityTuneConfig.ts';
import { COMMERCE_IDENTITY_VERSION } from './commerceIdentityConfig.ts';
import { COMMERCE_FUNNEL_VERSION } from './commerceFunnelConfig.ts';

export const SCAN_COMMERCE_EVENTS_TABLE = 'scan_commerce_events';

export type CommerceOutcomeInput = {
  requestMode: string;
  sourceClass: string | null;
  appPlatform: string | null;
  appVersion: string | null;
  status: string;
  isFashion: boolean;
  categoryRoute: string | null;
  qualityBand: string | null;
  commerceQueryDetailLevel: string | null;
  providerOutcome: string | null;
  providersTried: string[] | null;
  primaryResultCount: number | null;
  fallbackUsed: boolean;
  productsBeforeFilter: number | null;
  productsAfterFilter: number | null;
  productsBeforeDedupe: number | null;
  productsAfterDedupe: number | null;
  categoryMismatchRemovals: number | null;
  retailerCount: number | null;
  commerceDurationMs: number | null;
  totalDurationMs: number | null;
  failureReason: string | null;
  textScanParityEnabled: boolean;
  correlationHash?: string | null;
  /**
   * Accuracy-telemetry repair (v124/v127). All optional/nullable — omitting
   * them is byte-identical to the pre-repair contract.
   *
   * queryStrategy: bounded v125 enum, never the query string.
   * topAgreementScore / topAgreementBand: the highest v122/v124 agreement
   *   score among ranked candidates, and its deterministic band — both
   *   already computed by filterAndDedupeProducts, not new scoring.
   * commerceIdentityEnabled / commerceFunnelEnabled: whether v124/v127
   *   actually ran for this request. Stamps the matching version constant
   *   only when true, mirroring textScanParityEnabled's existing pattern —
   *   not a new enablement model.
   */
  queryStrategy?: string | null;
  topAgreementScore?: number | null;
  topAgreementBand?: string | null;
  commerceIdentityEnabled?: boolean;
  commerceFunnelEnabled?: boolean;
};

export type CommerceOutcomeRow = {
  request_mode: string;
  source_class: string | null;
  app_platform: string | null;
  app_version: string | null;
  status: string;
  is_fashion: boolean;
  category_route: string | null;
  quality_band: string | null;
  commerce_query_detail_level: string | null;
  provider_outcome: string | null;
  providers_tried: string[] | null;
  primary_result_count: number | null;
  fallback_used: boolean;
  products_before_filter: number | null;
  products_after_filter: number | null;
  products_before_dedupe: number | null;
  products_after_dedupe: number | null;
  category_mismatch_removals: number | null;
  retailer_count: number | null;
  commerce_duration_ms: number | null;
  total_duration_ms: number | null;
  failure_reason: FailureReason | null;
  quality_tune_version: string;
  scanner_intelligence_version: string;
  commerce_relevance_version: string;
  textscan_parity_version: string | null;
  correlation_hash: string | null;
  query_strategy: string | null;
  top_agreement_score: number | null;
  top_agreement_band: string | null;
  commerce_identity_version: string | null;
  commerce_funnel_version: string | null;
};

const ALLOWED_ROUTES = new Set(['apparel', 'footwear', 'bags', 'accessories', 'general']);
const ALLOWED_BANDS = new Set(['high', 'moderate', 'low']);
const ALLOWED_DETAIL = new Set(['specific', 'moderate', 'broad']);
const ALLOWED_STATUS = new Set([
  'completed', 'non_fashion', 'failed', 'rate_limited', 'invalid', 'error',
]);
/** Mirrors CommerceQueryStrategy in commerceRetrievalConfig.ts. */
const ALLOWED_QUERY_STRATEGY = new Set([
  'exact_identity', 'brand_distinctive', 'attribute_only', 'fallback',
]);
/** Mirrors AgreementBand in commerceRelevanceAgreement.ts. */
const ALLOWED_AGREEMENT_BAND = new Set(['strong', 'usable', 'weak']);

function finiteOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

function safeShort(v: unknown, max = 40): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, max);
  return t || null;
}

function safeProviders(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const p of v) {
    if (typeof p !== 'string') continue;
    const t = p.trim().toLowerCase().slice(0, 24);
    if (!t || out.includes(t)) continue;
    out.push(t);
    if (out.length >= 8) break;
  }
  return out.length ? out : null;
}

/** Build a privacy-safe persistence row. */
export function buildCommerceOutcomeRow(input: CommerceOutcomeInput): CommerceOutcomeRow {
  const route = safeShort(input.categoryRoute, 24);
  const band = safeShort(input.qualityBand, 16);
  const detail = safeShort(input.commerceQueryDetailLevel, 16);
  const status = safeShort(input.status, 24) || 'unknown';
  const strategy = safeShort(input.queryStrategy, 24);
  const agreementBand = safeShort(input.topAgreementBand, 16);

  return {
    request_mode: safeShort(input.requestMode, 40) || 'unknown',
    source_class: safeShort(input.sourceClass, 40),
    app_platform: safeShort(input.appPlatform, 40),
    app_version: safeShort(input.appVersion, 40),
    status: ALLOWED_STATUS.has(status) ? status : 'unknown',
    is_fashion: !!input.isFashion,
    category_route: route && ALLOWED_ROUTES.has(route) ? route : (route ? 'general' : null),
    quality_band: band && ALLOWED_BANDS.has(band) ? band : null,
    commerce_query_detail_level: detail && ALLOWED_DETAIL.has(detail) ? detail : null,
    provider_outcome: safeShort(input.providerOutcome, 40),
    providers_tried: safeProviders(input.providersTried),
    primary_result_count: finiteOrNull(input.primaryResultCount),
    fallback_used: !!input.fallbackUsed,
    products_before_filter: finiteOrNull(input.productsBeforeFilter),
    products_after_filter: finiteOrNull(input.productsAfterFilter),
    products_before_dedupe: finiteOrNull(input.productsBeforeDedupe),
    products_after_dedupe: finiteOrNull(input.productsAfterDedupe),
    category_mismatch_removals: finiteOrNull(input.categoryMismatchRemovals),
    retailer_count: finiteOrNull(input.retailerCount),
    commerce_duration_ms: finiteOrNull(input.commerceDurationMs),
    total_duration_ms: finiteOrNull(input.totalDurationMs),
    failure_reason: sanitizeFailureReason(input.failureReason),
    quality_tune_version: QUALITY_TUNE_VERSION,
    scanner_intelligence_version: SCANNER_INTELLIGENCE_VERSION,
    commerce_relevance_version: COMMERCE_RELEVANCE_VERSION,
    textscan_parity_version: input.textScanParityEnabled ? TEXTSCAN_COMMERCE_PARITY_VERSION : null,
    correlation_hash: safeShort(input.correlationHash, 16),
    query_strategy: strategy && ALLOWED_QUERY_STRATEGY.has(strategy) ? strategy : null,
    top_agreement_score: finiteOrNull(input.topAgreementScore),
    top_agreement_band: agreementBand && ALLOWED_AGREEMENT_BAND.has(agreementBand) ? agreementBand : null,
    commerce_identity_version: input.commerceIdentityEnabled ? COMMERCE_IDENTITY_VERSION : null,
    commerce_funnel_version: input.commerceFunnelEnabled ? COMMERCE_FUNNEL_VERSION : null,
  };
}

function isMissingTableError(err: unknown): boolean {
  const msg = err && typeof err === 'object'
    ? `${(err as { code?: string }).code || ''} ${(err as { message?: string }).message || ''}`.toLowerCase()
    : String(err || '').toLowerCase();
  return msg.includes('pgrst205') || msg.includes('does not exist') || msg.includes('schema cache');
}

/**
 * Best-effort outcome capture. Never throws into the request path.
 * At most one insert; bounded by COMMERCE_OUTCOME_CAPTURE_TIMEOUT_MS.
 */
export async function captureCommerceOutcome(
  input: CommerceOutcomeInput,
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): Promise<{ attempted: boolean; ok: boolean; reason: string | null }> {
  if (!isCommerceOutcomeCaptureEnabled(envGet)) {
    return { attempted: false, ok: true, reason: 'capture_disabled' };
  }

  const row = buildCommerceOutcomeRow(input);
  const privacy = assertQualityMetricsPrivacy(row);
  if (!privacy.ok) {
    console.warn(
      '[scan-identify] commerce_outcome_privacy_block violations=%d',
      privacy.violations.length,
    );
    return { attempted: true, ok: false, reason: 'capture_privacy_block' };
  }

  const supabaseUrl = envGet('SUPABASE_URL') || envGet('EXPO_PUBLIC_SUPABASE_URL');
  const serviceKey = envGet('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    console.warn('[scan-identify] commerce_outcome_capture_skip reason=capture_disabled');
    return { attempted: false, ok: false, reason: 'capture_disabled' };
  }

  const insertPromise = (async () => {
    try {
      const client = createClient(supabaseUrl, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await client.from(SCAN_COMMERCE_EVENTS_TABLE).insert(row);
      if (error) {
        if (isMissingTableError(error)) {
          console.warn('[scan-identify] commerce_outcome_capture_skip reason=capture_table_missing');
          return { ok: false as const, reason: 'capture_table_missing' };
        }
        console.warn('[scan-identify] commerce_outcome_capture_skip reason=capture_insert_failed');
        return { ok: false as const, reason: 'capture_insert_failed' };
      }
      return { ok: true as const, reason: null };
    } catch {
      console.warn('[scan-identify] commerce_outcome_capture_skip reason=capture_insert_failed');
      return { ok: false as const, reason: 'capture_insert_failed' };
    }
  })();

  const raced = await Promise.race([
    insertPromise,
    new Promise<{ ok: false; reason: string }>((resolve) => {
      setTimeout(
        () => resolve({ ok: false, reason: 'capture_timeout' }),
        COMMERCE_OUTCOME_CAPTURE_TIMEOUT_MS,
      );
    }),
  ]);

  if (!raced.ok && raced.reason === 'capture_timeout') {
    console.warn('[scan-identify] commerce_outcome_capture_skip reason=capture_timeout');
  }

  return {
    attempted: true,
    ok: raced.ok,
    reason: raced.reason,
  };
}

export { COMMERCE_OUTCOME_CAPTURE_VERSION };
