// modelRouting.ts — Elise / StyleChat Gemini model selection.
// Workload vars only. Generic GEMINI_MODEL must not control routing.
//
// The allowlist itself is owned by _shared/llmModelRouting.ts so Scanner,
// TextScan and Elise cannot drift apart. This module keeps the Elise-facing
// API and its failure taxonomy.
import {
  APPROVED_MODELS,
  ELISE_FALLBACK_MODEL as SHARED_ELISE_FALLBACK_MODEL,
  ELISE_PRIMARY_MODEL as SHARED_ELISE_PRIMARY_MODEL,
  isRetiredModelId as sharedIsRetiredModelId,
} from '../_shared/llmModelRouting.ts';

export const ELISE_PRIMARY_MODEL = SHARED_ELISE_PRIMARY_MODEL;
export const ELISE_FALLBACK_MODEL = SHARED_ELISE_FALLBACK_MODEL;

export const ALLOWED_MODELS = APPROVED_MODELS;

export type ProviderFailureKind =
  | 'timeout'
  | 'network'
  | 'http_429'
  | 'http_5xx'
  | 'http_unavailable'
  | 'empty_response'
  | 'malformed'
  | 'incomplete'
  | 'policy_block'
  | 'http_other';

export function readTrimmedEnvValue(
  getter: (key: string) => string | undefined,
  key: string,
): string | undefined {
  const value = getter(key)?.trim();
  return value ? value : undefined;
}

export function isRetiredModelId(model: string): boolean {
  return sharedIsRetiredModelId(model);
}

export function resolveAllowedModel(candidate: string | undefined, fallback: string): string {
  const trimmed = candidate?.trim();
  if (!trimmed) return fallback;
  if (isRetiredModelId(trimmed)) return fallback;
  if (!ALLOWED_MODELS.has(trimmed)) return fallback;
  return trimmed;
}

export function getConfiguredModel(
  getter: (key: string) => string | undefined,
  key: string,
  fallback: string,
): string {
  return resolveAllowedModel(readTrimmedEnvValue(getter, key), fallback);
}

export function resolveEliseModels(getter: (key: string) => string | undefined): {
  primaryModel: string;
  fallbackModel: string;
} {
  return {
    primaryModel: getConfiguredModel(getter, 'STYLECHAT_GEMINI_MODEL', ELISE_PRIMARY_MODEL),
    fallbackModel: getConfiguredModel(
      getter,
      'STYLECHAT_GEMINI_FALLBACK_MODEL',
      ELISE_FALLBACK_MODEL,
    ),
  };
}

export function classifyHttpFailure(status: number): ProviderFailureKind {
  if (status === 429) return 'http_429';
  if (status >= 500 && status <= 599) return 'http_5xx';
  return 'http_other';
}

/** Operational failures go directly to Lite (no primary retry). */
export function isDirectFallbackFailure(kind: ProviderFailureKind): boolean {
  return (
    kind === 'timeout' ||
    kind === 'network' ||
    kind === 'http_429' ||
    kind === 'http_5xx' ||
    kind === 'http_unavailable'
  );
}

/** Completeness / empty / malformed: same-model repair once, then Lite. */
export function isRepairableFailure(kind: ProviderFailureKind): boolean {
  return kind === 'empty_response' || kind === 'malformed' || kind === 'incomplete';
}
