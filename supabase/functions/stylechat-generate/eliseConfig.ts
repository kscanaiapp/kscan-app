import {
  ELISE_FALLBACK_MODEL,
  ELISE_PRIMARY_MODEL,
  getConfiguredModel,
} from './modelRouting.ts';

export const ELISE_BACKEND_VERSION = 'elise-backend-foundation-r015';
export const ELISE_PROMPT_VERSION = 'stylechat-prompt-v1';
export const ELISE_CONTEXT_CONTRACT_VERSION = 'visual-context-v1';
export const ELISE_OUTPUT_PARSER_VERSION = 'stylechat-output-v1';

export interface EliseBackendFlags {
  aiEnabled: boolean;
  contextNormalizationV1: boolean;
  generationSafetyV1: boolean;
  quotaIdempotencyV1: boolean;
  speechResilienceV1: boolean;
  speechRetry: boolean;
  speechCircuitBreaker: boolean;
  speechDeduplicationV1: boolean;
  speechConcurrencyV1: boolean;
  telemetryV1: boolean;
  structuredGroundingV1: boolean;
  generationRetryV1: boolean;
  explanations: boolean;
  /** E-4 closet-aware styling — all default OFF. */
  adviceIntentsV1: boolean;
  closetRetrievalV1: boolean;
  compatibilityScoringV1: boolean;
  wardrobeGapV1: boolean;
  purchaseAdviceV1: boolean;
  multiLookV1: boolean;
  /** DR-2: allow owned dressing_room_item attachments (stable ID only). */
  dressingRoomAttachmentsV1: boolean;
  /** DR-2: allow shared_item / shared_room_item evidence attachments. */
  sharedRoomEvidenceV1: boolean;
  /** DR-2: client may receive adviceMetadata when object-shaped. */
  adviceMetadataClientV1: boolean;
  /**
   * Build 34 / Track B / Phase B5. THE SINGLE B5 KILL SWITCH. Gates BOTH the
   * Track B Closet wardrobe-retrieval source and the server-derived Style DNA
   * context together, not decomposed per-stage (same reasoning as every other
   * single-flag Track B phase). Independent of adviceIntentsV1/
   * closetRetrievalV1, which continue to gate the pre-Track-B Dressing-Room-
   * based retrieval unchanged. Additionally requires an ACTIVE K+ entitlement,
   * checked server-side via has_active_k_plus() on every request — this flag
   * alone never grants premium wardrobe context.
   */
  closetWardrobeContextV1: boolean;
  /**
   * Build 34 / K+ Wardrobe Concierge V1 (C1 section 14). THE SINGLE CONCIERGE
   * CAPABILITY FLAG. Default OFF.
   *
   * Boundary against the two flags it is often confused with:
   *
   *   adviceMetadataClientV1  -- TRANSPORT. Whether adviceMetadata is allowed to
   *                              reach the client at all. Predates Concierge and
   *                              keeps its existing meaning unchanged.
   *   closetWardrobeContextV1 -- SOURCE. Whether the authoritative Track B
   *                              Closet participates in retrieval (plus the
   *                              server-derived Style DNA context), K+ gated.
   *   conciergeV1             -- CAPABILITY. Whether the new customer-visible
   *                              Concierge behaviour exists: v2 display facts,
   *                              the wardrobe-context signal, text->Closet focus
   *                              resolution, census-backed gap authority,
   *                              role-aware looks and ownership prose safety.
   *
   * There is deliberately no fourth control layer. Concierge does not re-gate
   * transport or re-gate the source; it composes with both. With this flag off
   * the advice payload is byte-identical to its pre-Concierge form.
   */
  conciergeV1: boolean;
}

export interface EliseBackendConfig {
  backendVersion: string;
  promptVersion: string;
  contextContractVersion: string;
  outputParserVersion: string;
  modelName: string;
  fallbackModelName: string;
  burstLimitPerMinute: number;
  flags: EliseBackendFlags;
}

export interface EnvReader {
  get(name: string): string | undefined;
}

function readTrimmed(env: EnvReader, name: string): string | undefined {
  const value = env.get(name)?.trim();
  return value ? value : undefined;
}

export function parseBooleanEnv(
  env: EnvReader,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = readTrimmed(env, name);
  if (value == null) return defaultValue;
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parsePositiveIntEnv(
  env: EnvReader,
  name: string,
  defaultValue: number,
  maxValue: number,
): number {
  const value = readTrimmed(env, name);
  const parsed = value != null ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, maxValue)
    : defaultValue;
}

export function readEliseBackendConfig(env: EnvReader): EliseBackendConfig {
  return {
    backendVersion: ELISE_BACKEND_VERSION,
    promptVersion: ELISE_PROMPT_VERSION,
    contextContractVersion: ELISE_CONTEXT_CONTRACT_VERSION,
    outputParserVersion: ELISE_OUTPUT_PARSER_VERSION,
    // Frozen model map (modelRouting.ts): explicit workload vars only, allowlist-validated.
    // Generic GEMINI_MODEL precedence and retired gemini-2.5 default removed.
    modelName: getConfiguredModel((k) => env.get(k), 'STYLECHAT_GEMINI_MODEL', ELISE_PRIMARY_MODEL),
    fallbackModelName: getConfiguredModel(
      (k) => env.get(k),
      'STYLECHAT_GEMINI_FALLBACK_MODEL',
      ELISE_FALLBACK_MODEL,
    ),
    burstLimitPerMinute: parsePositiveIntEnv(env, 'STYLECHAT_BURST_LIMIT_PER_MINUTE', 4, 60),
    flags: {
      aiEnabled: !((readTrimmed(env, 'STYLECHAT_AI_ENABLED') ?? '').toLowerCase() === 'false'),
      contextNormalizationV1: parseBooleanEnv(env, 'ELISE_CONTEXT_NORMALIZATION_V1_ENABLED', false),
      generationSafetyV1: parseBooleanEnv(env, 'ELISE_GENERATION_SAFETY_V1_ENABLED', false),
      quotaIdempotencyV1: parseBooleanEnv(env, 'ELISE_QUOTA_IDEMPOTENCY_V1_ENABLED', false),
      speechResilienceV1: parseBooleanEnv(env, 'ELISE_SPEECH_RESILIENCE_V1_ENABLED', false),
      speechRetry: parseBooleanEnv(env, 'ELISE_SPEECH_RETRY_ENABLED', false),
      speechCircuitBreaker: parseBooleanEnv(env, 'ELISE_SPEECH_CIRCUIT_BREAKER_ENABLED', false),
      speechDeduplicationV1: parseBooleanEnv(env, 'ELISE_SPEECH_DEDUPLICATION_V1_ENABLED', false),
      speechConcurrencyV1: parseBooleanEnv(env, 'ELISE_SPEECH_CONCURRENCY_V1_ENABLED', false),
      telemetryV1: parseBooleanEnv(env, 'ELISE_TELEMETRY_V1_ENABLED', false),
      structuredGroundingV1: parseBooleanEnv(env, 'ELISE_STRUCTURED_GROUNDING_V1_ENABLED', false),
      generationRetryV1: parseBooleanEnv(env, 'ELISE_GENERATION_RETRY_V1_ENABLED', false),
      explanations: parseBooleanEnv(env, 'STYLECHAT_EXPLANATIONS_ENABLED', true),
      adviceIntentsV1: parseBooleanEnv(env, 'ELISE_ADVICE_INTENTS_V1_ENABLED', false),
      closetRetrievalV1: parseBooleanEnv(env, 'ELISE_CLOSET_RETRIEVAL_V1_ENABLED', false),
      compatibilityScoringV1: parseBooleanEnv(env, 'ELISE_COMPATIBILITY_SCORING_V1_ENABLED', false),
      wardrobeGapV1: parseBooleanEnv(env, 'ELISE_WARDROBE_GAP_V1_ENABLED', false),
      purchaseAdviceV1: parseBooleanEnv(env, 'ELISE_PURCHASE_ADVICE_V1_ENABLED', false),
      multiLookV1: parseBooleanEnv(env, 'ELISE_MULTI_LOOK_V1_ENABLED', false),
      dressingRoomAttachmentsV1: parseBooleanEnv(
        env,
        'ELISE_DRESSING_ROOM_ATTACHMENTS_V1_ENABLED',
        false,
      ),
      sharedRoomEvidenceV1: parseBooleanEnv(env, 'ELISE_SHARED_ROOM_EVIDENCE_V1_ENABLED', false),
      adviceMetadataClientV1: parseBooleanEnv(env, 'ELISE_ADVICE_METADATA_CLIENT_V1_ENABLED', false),
      closetWardrobeContextV1: parseBooleanEnv(env, 'ELISE_CLOSET_WARDROBE_CONTEXT_V1_ENABLED', false),
      conciergeV1: parseBooleanEnv(env, 'ELISE_CONCIERGE_V1_ENABLED', false),
    },
  };
}
