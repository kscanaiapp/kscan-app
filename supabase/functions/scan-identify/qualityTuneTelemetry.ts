/**
 * Privacy-safe quality telemetry helpers.
 * Never emit images, base64, tokens, PII, raw prompts, or full session/digest.
 */

import {
  QUALITY_TUNE_VERSION,
  qualityTuneTreatmentBucket,
} from './qualityTuneConfig.ts';
import { COMMERCE_RELEVANCE_VERSION } from './commerceRelevanceConfig.ts';
import { sanitizeFailureReason, type FailureReason } from './commerceRelevanceFailure.ts';

export type QualityTuneMetrics = {
  request_mode: string;
  total_duration_ms: number | null;
  model_duration_ms: number | null;
  commerce_duration_ms: number | null;
  provider_outcome: string | null;
  candidate_count: number | null;
  generic_label_occurrence: number;
  normalization_correction_count: number;
  normalization_rule_ids: string[];
  primary_commerce_result_count: number | null;
  fallback_query_usage: boolean | number;
  products_before_dedupe: number | null;
  products_after_dedupe: number | null;
  category_mismatch_removals: number | null;
  empty_result_occurrence: number;
  error_category: string | null;
  quality_tune_version: string;
  treatment_bucket: 'quality_tune_on' | 'quality_tune_off';
  /** v121 intelligence extensions — only present when intelligence metrics supplied */
  category_route?: 'apparel' | 'footwear' | 'bags' | 'accessories' | 'general';
  quality_score_band?: 'high' | 'moderate' | 'low';
  quality_score_value?: number;
  consistency_conflict_count?: number;
  suppressed_attribute_count?: number;
  commerce_query_detail_level?: 'specific' | 'moderate' | 'broad';
  brand_suppressed?: boolean;
  material_suppressed?: boolean;
  /** v122 commerce relevance extensions — only when relevance metrics supplied */
  failure_reason?: FailureReason | null;
  products_before_filter?: number | null;
  products_after_filter?: number | null;
  retailer_count?: number | null;
  fallback_used?: boolean;
  duration_ms?: number | null;
  intelligence_version?: string;
  commerce_relevance_version?: string;
};

const PROHIBITED_KEY_FRAGMENTS = [
  'imagebase64',
  'base64',
  'authorization',
  'authtoken',
  'access_token',
  'refresh_token',
  'email',
  'password',
  'raw_prompt',
  'rawprompt',
  'raw_model',
  'raw_provider',
  'provider_response',
  'face',
  'plate',
  'ssn',
];

const PROHIBITED_VALUE_PATTERNS: RegExp[] = [
  /data:image\//i,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, // JWT-like
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // email
  /iVBORw0KGgo/, // png base64 header
  /\/9j\//, // jpeg base64 header
];

export type IntelligenceTelemetryInput = {
  categoryRoute: 'apparel' | 'footwear' | 'bags' | 'accessories' | 'general';
  qualityScoreBand: 'high' | 'moderate' | 'low';
  qualityScoreValue: number;
  consistencyConflictCount: number;
  suppressedAttributeCount: number;
  commerceQueryDetailLevel: 'specific' | 'moderate' | 'broad';
  brandSuppressed: boolean;
  materialSuppressed: boolean;
};

export type CommerceRelevanceTelemetryInput = {
  failureReason?: string | null;
  productsBeforeFilter?: number | null;
  productsAfterFilter?: number | null;
  retailerCount?: number | null;
  fallbackUsed?: boolean;
  durationMs?: number | null;
  intelligenceVersion?: string;
};

export function buildQualityTuneMetrics(input: {
  enabled: boolean;
  requestMode: string;
  totalDurationMs?: number | null;
  modelDurationMs?: number | null;
  commerceDurationMs?: number | null;
  providerOutcome?: string | null;
  candidateCount?: number | null;
  genericLabelOccurrence?: number;
  normalizationCorrectionCount?: number;
  normalizationRuleIds?: string[];
  primaryCommerceResultCount?: number | null;
  fallbackQueryUsage?: boolean | number;
  productsBeforeDedupe?: number | null;
  productsAfterDedupe?: number | null;
  categoryMismatchRemovals?: number | null;
  emptyResultOccurrence?: number;
  errorCategory?: string | null;
  /** When set, appends privacy-safe v121 intelligence metrics. Omit for v120-equivalent telemetry. */
  intelligence?: IntelligenceTelemetryInput | null;
  /** When set, appends privacy-safe v122 commerce relevance metrics. */
  commerceRelevance?: CommerceRelevanceTelemetryInput | null;
}): QualityTuneMetrics {
  const base: QualityTuneMetrics = {
    request_mode: String(input.requestMode || 'unknown').slice(0, 64),
    total_duration_ms: finiteOrNull(input.totalDurationMs),
    model_duration_ms: finiteOrNull(input.modelDurationMs),
    commerce_duration_ms: finiteOrNull(input.commerceDurationMs),
    provider_outcome: input.providerOutcome ? String(input.providerOutcome).slice(0, 40) : null,
    candidate_count: finiteOrNull(input.candidateCount),
    generic_label_occurrence: Math.max(0, Math.floor(input.genericLabelOccurrence ?? 0)),
    normalization_correction_count: Math.max(0, Math.floor(input.normalizationCorrectionCount ?? 0)),
    normalization_rule_ids: Array.isArray(input.normalizationRuleIds)
      ? input.normalizationRuleIds.map((x) => String(x).slice(0, 64)).slice(0, 24)
      : [],
    primary_commerce_result_count: finiteOrNull(input.primaryCommerceResultCount),
    fallback_query_usage: input.fallbackQueryUsage ?? false,
    products_before_dedupe: finiteOrNull(input.productsBeforeDedupe),
    products_after_dedupe: finiteOrNull(input.productsAfterDedupe),
    category_mismatch_removals: finiteOrNull(input.categoryMismatchRemovals),
    empty_result_occurrence: Math.max(0, Math.floor(input.emptyResultOccurrence ?? 0)),
    error_category: input.errorCategory ? String(input.errorCategory).slice(0, 64) : null,
    quality_tune_version: QUALITY_TUNE_VERSION,
    treatment_bucket: qualityTuneTreatmentBucket(input.enabled),
  };

  let metrics: QualityTuneMetrics = base;

  if (input.intelligence) {
    const route = input.intelligence.categoryRoute;
    const band = input.intelligence.qualityScoreBand;
    const detail = input.intelligence.commerceQueryDetailLevel;
    const allowedRoutes = new Set(['apparel', 'footwear', 'bags', 'accessories', 'general']);
    const allowedBands = new Set(['high', 'moderate', 'low']);
    const allowedDetail = new Set(['specific', 'moderate', 'broad']);

    metrics = {
      ...metrics,
      category_route: allowedRoutes.has(route) ? route : 'general',
      quality_score_band: allowedBands.has(band) ? band : 'low',
      quality_score_value: Math.max(0, Math.min(100, Math.floor(input.intelligence.qualityScoreValue || 0))),
      consistency_conflict_count: Math.max(0, Math.floor(input.intelligence.consistencyConflictCount || 0)),
      suppressed_attribute_count: Math.max(0, Math.floor(input.intelligence.suppressedAttributeCount || 0)),
      commerce_query_detail_level: allowedDetail.has(detail) ? detail : 'broad',
      brand_suppressed: !!input.intelligence.brandSuppressed,
      material_suppressed: !!input.intelligence.materialSuppressed,
    };
  }

  if (input.commerceRelevance) {
    const cr = input.commerceRelevance;
    metrics = {
      ...metrics,
      failure_reason: sanitizeFailureReason(cr.failureReason),
      products_before_filter: finiteOrNull(cr.productsBeforeFilter),
      products_after_filter: finiteOrNull(cr.productsAfterFilter),
      retailer_count: finiteOrNull(cr.retailerCount),
      fallback_used: !!cr.fallbackUsed,
      duration_ms: finiteOrNull(cr.durationMs ?? input.totalDurationMs),
      intelligence_version: cr.intelligenceVersion
        ? String(cr.intelligenceVersion).slice(0, 16)
        : undefined,
      commerce_relevance_version: COMMERCE_RELEVANCE_VERSION,
    };
  }

  return metrics;
}

function finiteOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Truncated one-way hash for correlation (non-reversible treatment of ids).
 * Uses Web Crypto when available; falls back to djb2 hex for unit tests.
 */
export async function privacySafeHashPrefix(value: string, chars = 12): Promise<string> {
  const input = String(value || '');
  try {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = Array.from(new Uint8Array(digest));
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, chars);
  } catch {
    let h = 5381;
    for (let i = 0; i < input.length; i++) h = ((h << 5) + h) ^ input.charCodeAt(i);
    return (h >>> 0).toString(16).padStart(chars, '0').slice(0, chars);
  }
}

/** Recursively ensure metrics object cannot carry prohibited keys/values. */
export function assertQualityMetricsPrivacy(metrics: unknown): {
  ok: boolean;
  violations: string[];
} {
  const violations: string[] = [];

  function walk(node: unknown, path: string): void {
    if (node == null) return;
    if (typeof node === 'string') {
      for (const re of PROHIBITED_VALUE_PATTERNS) {
        if (re.test(node)) violations.push(`value:${path}`);
      }
      // Full session / digest heuristics: long hex without being our short hashes
      if (/^[a-f0-9]{32,}$/i.test(node) && path.includes('session')) {
        violations.push(`full_session_like:${path}`);
      }
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const keyNorm = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const frag of PROHIBITED_KEY_FRAGMENTS) {
          if (keyNorm.includes(frag)) violations.push(`key:${path}.${k}`);
        }
        // Reject known sensitive field names even if empty
        if (['imageBase64', 'image_base64', 'email', 'authorization', 'rawPrompt', 'rawProviderResponse'].includes(k)) {
          violations.push(`key:${path}.${k}`);
        }
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  }

  walk(metrics, '');
  return { ok: violations.length === 0, violations };
}

export function logQualityTuneMetrics(metrics: QualityTuneMetrics): void {
  const privacy = assertQualityMetricsPrivacy(metrics);
  if (!privacy.ok) {
    console.warn('[scan-identify] quality_tune_metrics_privacy_block violations=%d', privacy.violations.length);
    return;
  }
  console.log('[scan-identify] quality_tune_metrics %s', JSON.stringify(metrics));
}
