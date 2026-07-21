const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('E-4 modules and flags are present and default OFF', () => {
  const config = read('supabase/functions/stylechat-generate/eliseConfig.ts');
  const index = read('supabase/functions/stylechat-generate/index.ts');
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');

  for (const flag of [
    'ELISE_ADVICE_INTENTS_V1_ENABLED',
    'ELISE_CLOSET_RETRIEVAL_V1_ENABLED',
    'ELISE_COMPATIBILITY_SCORING_V1_ENABLED',
    'ELISE_WARDROBE_GAP_V1_ENABLED',
    'ELISE_PURCHASE_ADVICE_V1_ENABLED',
    'ELISE_MULTI_LOOK_V1_ENABLED',
  ]) {
    assert.match(config, new RegExp(flag));
    assert.match(config, new RegExp(`${flag}', false`));
  }

  assert.match(index, /runEliseAdvicePipeline/);
  assert.match(index, /adviceMetadata/);
  assert.match(index, /advicePromptBlock/);
  assert.match(index, /__shared_access/);
  assert.match(index, /recipient_user_id/);
  assert.doesNotMatch(index, /member_user_id/);

  assert.match(provider, /adviceMetadata/);
  assert.match(provider, /adviceContractVersion/);
});

test('E-4 does not invent Closet items in prompt builder', () => {
  const prompt = read('supabase/functions/stylechat-generate/eliseAdvicePrompt.ts');
  assert.match(prompt, /Do not invent Closet or saved items/);
  assert.match(prompt, /Saved is not owned/);
  assert.match(prompt, /Do not execute purchases/);
});

test('E-4 retrieval enforces actor authorization markers', () => {
  const retrieval = read('supabase/functions/stylechat-generate/eliseWardrobeRetrieval.ts');
  assert.match(retrieval, /ownerMatches/);
  assert.match(retrieval, /__shared_access/);
  assert.match(retrieval, /__room_owned_by_actor/);
  assert.match(retrieval, /rejectedCount/);
});

test('E-4 scoring is deterministic and ownership-weighted', () => {
  const scoring = read('supabase/functions/stylechat-generate/eliseCompatibilityScoring.ts');
  assert.match(scoring, /ownershipPriority/);
  assert.match(scoring, /redundancyPenalty/);
  assert.match(scoring, /neutral_pairing/);
  assert.doesNotMatch(scoring, /commission/);
});

test('E-4 telemetry allowlist excludes Closet contents and URLs', () => {
  const telemetry = read('supabase/functions/stylechat-generate/telemetry.ts');
  assert.match(telemetry, /elise_advice_outcome/);
  assert.match(telemetry, /adviceIntent/);
  assert.match(telemetry, /groundedCandidateCount/);
  assert.doesNotMatch(telemetry, /itemName/);
  assert.doesNotMatch(telemetry, /imageUrl/);
});

test('E-4 client type contract is additive and optional', () => {
  const types = read('types/eliseAdvice.ts');
  assert.match(types, /elise_advice_v1/);
  assert.match(types, /EliseAdviceMetadataClient/);
  assert.match(types, /purchaseAdvice/);
});

test('E-4 fixtures cover required synthetic scenarios', () => {
  const fixtures = read('__tests__/fixtures/eliseE4AdviceScenarios.json');
  const parsed = JSON.parse(fixtures);
  assert.ok(Array.isArray(parsed.scenarios));
  const ids = new Set(parsed.scenarios.map((s) => s.id));
  for (const required of [
    'scanned_jacket_owned_pants',
    'scanned_dress_owned_shoes',
    'purchase_advice_owned_duplicate',
    'wardrobe_gap_request',
    'three_look_request',
    'unauthorized_closet_item',
    'large_closet_candidate_set',
  ]) {
    assert.ok(ids.has(required), `missing fixture ${required}`);
  }
});
