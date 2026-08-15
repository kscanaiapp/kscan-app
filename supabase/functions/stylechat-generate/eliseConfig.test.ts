import assert from 'node:assert/strict';

import {
  closetIntelligenceCapabilityState,
  readEliseBackendConfig,
  parseBooleanEnv,
} from './eliseConfig.ts';
import { stripUnsafeModelOutput } from './promptHardening.ts';

function env(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

Deno.test('Elise backend config defaults preserve current behavior and default repair flags off', () => {
  const config = readEliseBackendConfig(env({}));
  // Frozen model map (modelRouting.ts): production-accepted primary/fallback.
  assert.equal(config.modelName, 'gemini-3.6-flash');
  assert.equal(config.fallbackModelName, 'gemini-3.5-flash-lite');
  assert.equal(config.flags.aiEnabled, true);
  assert.equal(config.flags.contextNormalizationV1, false);
  assert.equal(config.flags.generationSafetyV1, false);
  assert.equal(config.flags.quotaIdempotencyV1, false);
  assert.equal(config.flags.speechResilienceV1, false);
  assert.equal(config.flags.telemetryV1, false);
  assert.equal(config.flags.explanations, true);
  assert.equal(config.flags.generationRetryV1, false);
  assert.equal(config.flags.structuredGroundingV1, false);
  assert.equal(config.flags.speechDeduplicationV1, false);
  assert.equal(config.flags.speechConcurrencyV1, false);
  assert.equal(config.flags.adviceIntentsV1, false);
  assert.equal(config.flags.closetRetrievalV1, false);
  assert.equal(config.flags.compatibilityScoringV1, false);
  assert.equal(config.flags.wardrobeGapV1, false);
  assert.equal(config.flags.purchaseAdviceV1, false);
  assert.equal(config.flags.multiLookV1, false);
  assert.equal(config.flags.dressingRoomAttachmentsV1, false);
  assert.equal(config.flags.sharedRoomEvidenceV1, false);
  assert.equal(config.flags.adviceMetadataClientV1, false);
});

Deno.test('S7 compatibility effective state is nested beneath Closet retrieval', () => {
  const disabledByDependency = readEliseBackendConfig(env({
    ELISE_CLOSET_RETRIEVAL_V1_ENABLED: 'false',
    ELISE_COMPATIBILITY_SCORING_V1_ENABLED: 'true',
  }));
  assert.equal(disabledByDependency.flags.compatibilityScoringV1, false);

  const enabled = readEliseBackendConfig(env({
    ELISE_ADVICE_INTENTS_V1_ENABLED: 'true',
    ELISE_CLOSET_RETRIEVAL_V1_ENABLED: 'true',
    ELISE_COMPATIBILITY_SCORING_V1_ENABLED: 'true',
    ELISE_WARDROBE_GAP_V1_ENABLED: 'true',
    ELISE_PURCHASE_ADVICE_V1_ENABLED: 'true',
    ELISE_MULTI_LOOK_V1_ENABLED: 'true',
  }));
  assert.deepEqual(closetIntelligenceCapabilityState(enabled.flags), {
    adviceIntentsV1: true,
    closetRetrievalV1: true,
    compatibilityScoringV1: true,
    wardrobeGapV1: true,
    purchaseAdviceV1: true,
    multiLookV1: true,
  });
});

Deno.test('Elise backend config supports independent valid overrides and safe invalid fallback', () => {
  assert.equal(parseBooleanEnv(env({ FLAG: 'yes' }), 'FLAG', false), true);
  assert.equal(parseBooleanEnv(env({ FLAG: 'off' }), 'FLAG', true), false);
  assert.equal(parseBooleanEnv(env({ FLAG: 'definitely' }), 'FLAG', true), true);
  const config = readEliseBackendConfig(env({
    STYLECHAT_AI_ENABLED: 'false',
    STYLECHAT_GEMINI_MODEL: 'custom-model',
    STYLECHAT_BURST_LIMIT_PER_MINUTE: '999',
    ELISE_CONTEXT_NORMALIZATION_V1_ENABLED: 'true',
  }));
  assert.equal(config.flags.aiEnabled, false);
  assert.equal(config.flags.contextNormalizationV1, true);
  assert.equal(config.flags.generationSafetyV1, false);
  // Allowlist routing: unknown model ids fall back to the frozen primary;
  // retired ids are rejected; only allowlisted overrides take effect.
  assert.equal(config.modelName, 'gemini-3.6-flash');
  assert.equal(config.burstLimitPerMinute, 60);
  const allowlisted = readEliseBackendConfig(env({
    STYLECHAT_GEMINI_MODEL: 'gemini-3.5-flash-lite',
    STYLECHAT_GEMINI_FALLBACK_MODEL: 'gemini-1.5-flash',
  }));
  assert.equal(allowlisted.modelName, 'gemini-3.5-flash-lite');
  assert.equal(allowlisted.fallbackModelName, 'gemini-3.5-flash-lite', 'retired fallback id must be rejected');
});

Deno.test('prompt hardening strips structured mutation attempts from model output', () => {
  const output = stripUnsafeModelOutput('Try navy trousers.\n```sql\nselect * from users\n```\nrpc: mutate');
  assert.match(output, /Try navy trousers/);
  assert.doesNotMatch(output, /select \*/i);
  assert.doesNotMatch(output, /rpc: mutate/i);
});
