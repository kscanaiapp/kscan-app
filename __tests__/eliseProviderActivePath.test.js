const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('R-001 selects exactly one production StyleChat provider path', () => {
  const hook = read('hooks/useStyleChat.ts');
  assert.match(hook, /new EdgeStyleChatProvider\(\)/);
  assert.doesNotMatch(hook, /new MockStyleChatProvider\(\)/);
  assert.equal((hook.match(/new \w+StyleChatProvider\(/g) || []).length, 1);
});

test('R-001 active client path invokes only stylechat-generate for production replies', () => {
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');
  const staleNames = ['style-chat-generate', 'stylechat_generate', 'ai-stylist-generate'];
  assert.match(provider, /const EDGE_FN\s*=\s*'stylechat-generate'/);
  for (const name of staleNames) assert.doesNotMatch(provider, new RegExp(name));
});

test('R-001 mock provider is retained as legacy/test fallback only', () => {
  const mock = read('services/style-chat/MockStyleChatProvider.ts');
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');
  assert.match(mock, /export class MockStyleChatProvider/);
  assert.match(provider, /MockStyleChatProvider remains importable/);
  assert.doesNotMatch(read('hooks/useStyleChat.ts'), /MockStyleChatProvider[^\\n]*from/);
});

test('R-010 backend Elise flags are backend-scoped and default-off for repairs', () => {
  const config = read('supabase/functions/stylechat-generate/eliseConfig.ts');
  for (const flag of [
    'ELISE_CONTEXT_NORMALIZATION_V1_ENABLED',
    'ELISE_GENERATION_SAFETY_V1_ENABLED',
    'ELISE_QUOTA_IDEMPOTENCY_V1_ENABLED',
    'ELISE_SPEECH_RESILIENCE_V1_ENABLED',
    'ELISE_SPEECH_RETRY_ENABLED',
    'ELISE_SPEECH_CIRCUIT_BREAKER_ENABLED',
    'ELISE_SPEECH_DEDUPLICATION_V1_ENABLED',
    'ELISE_SPEECH_CONCURRENCY_V1_ENABLED',
    'ELISE_TELEMETRY_V1_ENABLED',
    'ELISE_STRUCTURED_GROUNDING_V1_ENABLED',
    'ELISE_GENERATION_RETRY_V1_ENABLED',
  ]) {
    assert.match(config, new RegExp(flag));
  }
  assert.match(config, /parseBooleanEnv\(env, 'ELISE_CONTEXT_NORMALIZATION_V1_ENABLED', false\)/);
});

test('R-004/R-005 source contains durable idempotency boundaries', () => {
  const migration = read('supabase/migrations/202607200001_elise_generation_quota_idempotency.sql');
  const hook = read('hooks/useStyleChat.ts');
  const repo = read('services/style-chat/styleChatRepository.ts');
  assert.match(migration, /elise_generation_operations/);
  assert.match(migration, /unique \(user_id, operation_key\)/);
  assert.match(migration, /style_chat_assistant_source_message_unique/);
  assert.match(migration, /v_existing_status = 'failed' and not v_existing_quota_counted/);
  assert.match(hook, /sourceMessageId: persistedUserMessageId/);
  assert.match(repo, /source_message_id/);
});

test('R-008 telemetry helper uses a strict allowlist and fails open', () => {
  const telemetry = read('supabase/functions/stylechat-generate/telemetry.ts');
  assert.match(telemetry, /const ALLOWED_KEYS = new Set\(/);
  assert.match(telemetry, /if \(!ALLOWED_KEYS\.has\(key\)\) continue/);
  assert.doesNotMatch(telemetry, /FORBIDDEN_KEYS/);
  for (const allowed of ['requestId', 'actorHash', 'normalizedContextCount', 'stableErrorClass']) {
    assert.match(telemetry, new RegExp(`'${allowed}'`));
  }
  assert.match(telemetry, /Telemetry is strictly fail-open/);
});
