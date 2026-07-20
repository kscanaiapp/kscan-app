/**
 * Privacy-safe quality telemetry helpers.
 * Never emit images, base64, tokens, PII, raw prompts, or full session/digest.
 */

import {
  QUALITY_TUNE_VERSION,
  qualityTuneTreatmentBucket,
} from './qualityTuneConfig.ts';

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
}): QualityTuneMetrics {
  return {
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
