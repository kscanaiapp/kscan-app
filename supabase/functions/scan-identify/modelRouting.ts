// modelRouting.ts — Scanner + TextScan Gemini model selection for scan-identify.
//
// Explicit workload variables only. Generic GEMINI_MODEL must not control routing.
// Empty / whitespace env values are treated as absent.

export const SCANNER_PRIMARY_MODEL = 'gemini-3.6-flash';
export const SCANNER_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
export const TEXTSCAN_PRIMARY_MODEL = 'gemini-3.5-flash-lite';

export const ALLOWED_MODELS = new Set<string>([
  SCANNER_PRIMARY_MODEL,
  SCANNER_FALLBACK_MODEL,
]);

const RETIRED_MODEL_PREFIXES = ['gemini-1.5-', 'gemini-2.0-', 'gemini-2.5-'] as const;

export type VerifiedScanMode = 'image' | 'text';

export type ProviderFailureKind =
  | 'timeout'
  | 'network'
  | 'http_429'
  | 'http_5xx'
  | 'http_unavailable'
  | 'empty_response'
  | 'malformed_envelope'
  | 'unparseable_json'
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
  const normalized = model.trim().toLowerCase();
  return RETIRED_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
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

export function resolveWorkloadModels(getter: (key: string) => string | undefined): {
  scannerModel: string;
  scannerFallbackModel: string;
  textScanModel: string;
} {
  return {
    scannerModel: getConfiguredModel(getter, 'SCAN_GEMINI_MODEL', SCANNER_PRIMARY_MODEL),
    scannerFallbackModel: getConfiguredModel(
      getter,
      'SCAN_GEMINI_FALLBACK_MODEL',
      SCANNER_FALLBACK_MODEL,
    ),
    textScanModel: getConfiguredModel(getter, 'TEXTSCAN_GEMINI_MODEL', TEXTSCAN_PRIMARY_MODEL),
  };
}

/**
 * Evidence-based mode resolution:
 * - absent mode → image (mobile Scanner omits mode)
 * - "image" → image
 * - "text" → TextScan
 * - any other value → unsupported (null)
 */
export function resolveVerifiedRequestMode(modeField: unknown): VerifiedScanMode | null {
  if (modeField === undefined || modeField === null) return 'image';
  if (typeof modeField !== 'string') return null;
  const normalized = modeField.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'image' || normalized === 'text') return normalized;
  return null;
}

export function classifyHttpFailure(status: number): ProviderFailureKind {
  if (status === 429) return 'http_429';
  if (status >= 500 && status <= 599) return 'http_5xx';
  if (status === 503 || status === 504) return 'http_unavailable';
  return 'http_other';
}

/** Image: go straight to Lite for these operational failures (no primary retry). */
export function isDirectImageFallbackFailure(kind: ProviderFailureKind): boolean {
  return (
    kind === 'timeout' ||
    kind === 'network' ||
    kind === 'http_429' ||
    kind === 'http_5xx' ||
    kind === 'http_unavailable'
  );
}

/** Image: same-model repair once, then Lite if still failing. */
export function isImageRepairableFailure(kind: ProviderFailureKind): boolean {
  return (
    kind === 'empty_response' ||
    kind === 'malformed_envelope' ||
    kind === 'unparseable_json'
  );
}

/** TextScan: one same-model retry for eligible transient failures. */
export function isRetryableTextScanFailure(kind: ProviderFailureKind): boolean {
  return (
    kind === 'timeout' ||
    kind === 'network' ||
    kind === 'http_429' ||
    kind === 'http_5xx' ||
    kind === 'http_unavailable' ||
    kind === 'empty_response' ||
    kind === 'malformed_envelope' ||
    kind === 'unparseable_json'
  );
}

export function shouldNeverFallback(kind: ProviderFailureKind): boolean {
  return kind === 'policy_block' || kind === 'http_other';
}
