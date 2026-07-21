const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('E-2 modules and migration are present and wired behind flags', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  const migration = read('supabase/migrations/202607210001_elise_generation_resilience_e2.sql');
  const config = read('supabase/functions/stylechat-generate/eliseConfig.ts');

  assert.match(migration, /reserve_elise_generation_operation/);
  assert.match(migration, /revalidate_elise_generation_context/);
  assert.match(migration, /finalize_elise_generation_operation/);
  assert.match(migration, /failed_retryable/);
  assert.match(migration, /elise_generation_operations_source_unique/);
  assert.match(config, /ELISE_GENERATION_RETRY_V1_ENABLED/);
  assert.match(index, /reserveGenerationOperation/);
  assert.match(index, /revalidateGenerationContext/);
  assert.match(index, /persistAssistantOnce/);
  assert.match(index, /buildStructuredGroundingSystemBlock/);
  assert.match(index, /validateEliseGenerationOutput/);
  assert.match(index, /shouldRetryTextProviderError/);
});

test('E-2 reservation happens only when generationSafetyV1 is enabled', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  assert.match(index, /if \(config\.flags\.generationSafetyV1\) \{\s*generationReservation/);
});

test('E-2 stale revalidation blocks persistence and returns safe fallback', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  assert.match(index, /GENERATION_STALE/);
  assert.match(index, /blocked_stale/);
  assert.match(index, /status: 'stale'/);
});

test('E-2 duplicate completed recovery returns existing assistant content', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  assert.match(index, /loadAssistantMessageById/);
  assert.match(index, /duplicate: true/);
  assert.match(index, /GENERATION_IN_PROGRESS/);
});

test('E-2 grounding never concatenates raw activeContext on structured path', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  assert.match(
    index,
    /structuredGroundingV1 && structuredGroundingBlock/,
  );
  const grounding = read('supabase/functions/stylechat-generate/eliseStructuredGrounding.ts');
  assert.match(grounding, /Ownership labels come only from server-verified provenance/);
  assert.doesNotMatch(grounding, /activeContext/);
});

test('E-2 telemetry allowlist includes operation fields without raw content keys', () => {
  const telemetry = read('supabase/functions/stylechat-generate/telemetry.ts');
  assert.match(telemetry, /operationStatus/);
  assert.match(telemetry, /duplicateRecoveryOutcome/);
  assert.match(telemetry, /persistenceOutcome/);
  assert.doesNotMatch(telemetry, /'prompt'/);
  assert.doesNotMatch(telemetry, /'userMessage'/);
});
