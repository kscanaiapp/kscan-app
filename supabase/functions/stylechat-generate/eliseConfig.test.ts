import assert from 'node:assert/strict';

import {
  readEliseBackendConfig,
  parseBooleanEnv,
} from './eliseConfig.ts';
import { stripUnsafeModelOutput } from './promptHardening.ts';

function env(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

Deno.test('Elise backend config defaults preserve current behavior and default repair flags off', () => {
  const config = readEliseBackendConfig(env({}));
  assert.equal(config.modelName, 'gemini-2.5-flash');
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
  assert.equal(config.modelName, 'custom-model');
  assert.equal(config.burstLimitPerMinute, 60);
});

Deno.test('prompt hardening strips structured mutation attempts from model output', () => {
  const output = stripUnsafeModelOutput('Try navy trousers.\n```sql\nselect * from users\n```\nrpc: mutate');
  assert.match(output, /Try navy trousers/);
  assert.doesNotMatch(output, /select \*/i);
  assert.doesNotMatch(output, /rpc: mutate/i);
});
