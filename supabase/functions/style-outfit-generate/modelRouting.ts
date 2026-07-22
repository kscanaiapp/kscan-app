// Approved model routing for the dormant Dressing Room outfit generator.

export const STYLE_OUTFIT_PRIMARY_MODEL = 'gemini-3.6-flash';
export const STYLE_OUTFIT_FALLBACK_MODEL = 'gemini-3.5-flash-lite';

const APPROVED_MODELS = new Set([
  STYLE_OUTFIT_PRIMARY_MODEL,
  STYLE_OUTFIT_FALLBACK_MODEL,
]);
const RETIRED_PREFIXES = ['gemini-1.5-', 'gemini-2.0-', 'gemini-2.5-'] as const;

export type OutfitProviderFailureKind =
  | 'timeout'
  | 'network'
  | 'http_429'
  | 'http_5xx'
  | 'http_other'
  | 'empty_response'
  | 'malformed_envelope'
  | 'invalid_output';

function configuredModel(
  getter: (key: string) => string | undefined,
  key: string,
  fallback: string,
): string {
  const candidate = getter(key)?.trim();
  return candidate && APPROVED_MODELS.has(candidate) ? candidate : fallback;
}

export function resolveStyleOutfitModels(
  getter: (key: string) => string | undefined,
): { primaryModel: string; fallbackModel: string } {
  return {
    primaryModel: configuredModel(
      getter,
      'STYLE_OUTFIT_GEMINI_MODEL',
      STYLE_OUTFIT_PRIMARY_MODEL,
    ),
    fallbackModel: configuredModel(
      getter,
      'STYLE_OUTFIT_GEMINI_FALLBACK_MODEL',
      STYLE_OUTFIT_FALLBACK_MODEL,
    ),
  };
}

export function isRetiredStyleOutfitModel(value: string): boolean {
  return RETIRED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function classifyStyleOutfitFailure(error: unknown): OutfitProviderFailureKind {
  if (error instanceof DOMException && error.name === 'AbortError') return 'timeout';
  const message = error instanceof Error ? error.message : String(error);
  if (/provider_http_429/.test(message)) return 'http_429';
  if (/provider_http_5\d\d/.test(message)) return 'http_5xx';
  if (/provider_http_\d+/.test(message)) return 'http_other';
  if (message === 'provider_empty') return 'empty_response';
  if (message === 'provider_non_json') return 'malformed_envelope';
  if (message === 'provider_invalid_output') return 'invalid_output';
  return 'network';
}

export function isDirectStyleOutfitFallback(
  kind: OutfitProviderFailureKind,
): boolean {
  return (
    kind === 'timeout' ||
    kind === 'network' ||
    kind === 'http_429' ||
    kind === 'http_5xx'
  );
}

export function isRepairableStyleOutfitFailure(
  kind: OutfitProviderFailureKind,
): boolean {
  return (
    kind === 'empty_response' ||
    kind === 'malformed_envelope' ||
    kind === 'invalid_output'
  );
}
