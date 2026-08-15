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
  /**
   * E4.1 Room Intelligence.
   *
   * Deliberately its own gate rather than riding on contextNormalizationV1.
   * That flag predates E4.1 and governs the legacy E-1 normalization
   * BEHAVIOUR; reusing it would have meant enabling an older pipeline just to
   * switch on room reasoning, and would have left no way to roll E4.1 back
   * without also disabling that. The two now fail independently.
   */
  roomIntelligenceV1: boolean;
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
  const config: EliseBackendConfig = {
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
      roomIntelligenceV1: parseBooleanEnv(env, 'ELISE_ROOM_INTELLIGENCE_V1_ENABLED', false),
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
      // Compatibility has no independent candidate authority. Even if its raw
      // environment flag is true, its effective state is OFF when retrieval is
      // OFF. The dependency is finalized below after both values are read.
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
    },
  };
  config.flags.compatibilityScoringV1 =
    config.flags.closetRetrievalV1 && config.flags.compatibilityScoringV1;
  return config;
}

/** Safe runtime readback: effective feature state only, never secret values. */
export function closetIntelligenceCapabilityState(flags: EliseBackendFlags) {
  return {
    adviceIntentsV1: flags.adviceIntentsV1,
    closetRetrievalV1: flags.closetRetrievalV1,
    compatibilityScoringV1: flags.compatibilityScoringV1,
    wardrobeGapV1: flags.wardrobeGapV1,
    purchaseAdviceV1: flags.purchaseAdviceV1,
    multiLookV1: flags.multiLookV1,
  };
}
