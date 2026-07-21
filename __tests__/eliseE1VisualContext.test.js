const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('E-1 typed visual-context modules exist and are wired behind the flag', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  const pipeline = read('supabase/functions/stylechat-generate/eliseVisualContextPipeline.ts');
  const types = read('supabase/functions/stylechat-generate/eliseVisualContextTypes.ts');
  const resolvers = read('supabase/functions/stylechat-generate/eliseResourceResolvers.ts');

  assert.match(types, /elise_visual_context_v1/);
  assert.match(types, /EliseVisualContextEnvelope/);
  assert.match(pipeline, /buildEliseVisualContextEnvelope/);
  assert.match(pipeline, /serializeEliseVisualContextPrompt/);
  assert.match(resolvers, /resolveClosetItem/);
  assert.match(resolvers, /resolveSharedRoomItem/);
  assert.match(index, /buildEliseVisualContextEnvelope/);
  assert.match(index, /visualContextPromptBlock/);
  assert.match(index, /contextNormalizationV1/);
});

test('E-1 flag OFF path still uses legacy parseActiveContext / buildActiveContextBlock', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  assert.match(index, /parseActiveContext\(body\.activeContext\)/);
  assert.match(
    index,
    /config\.flags\.contextNormalizationV1\s*\n\s*\? \(visualContextPromptBlock/,
  );
  assert.match(index, /buildActiveContextBlock\(activeContext\)/);
});

test('E-1 ownership is never trusted from client relationship fields', () => {
  const pipeline = read('supabase/functions/stylechat-generate/eliseVisualContextPipeline.ts');
  assert.match(pipeline, /Client relationship claims are ignored/);
  assert.doesNotMatch(pipeline, /raw\.actorRelationship/);
  assert.match(resolversOwnershipSafe(), /owned/);

  function resolversOwnershipSafe() {
    return read('supabase/functions/stylechat-generate/eliseResourceResolvers.ts');
  }
});

test('E-1 prompt path never emits signed URLs or storage paths', () => {
  const pipeline = read('supabase/functions/stylechat-generate/eliseVisualContextPipeline.ts');
  assert.match(pipeline, /Never emit canonical storage paths or signed URLs/);
  assert.match(pipeline, /hasCanonicalStorageReference/);
  assert.doesNotMatch(pipeline, /canonicalStorageReference\}/);
});

test('E-1 fixtures remain redacted and require no new mobile fields', () => {
  const camera = JSON.parse(read('__tests__/fixtures/eliseE1CameraRequest.json'));
  const mixed = JSON.parse(read('__tests__/fixtures/eliseE1MixedProvenanceRequest.json'));
  const legacy = JSON.parse(read('__tests__/fixtures/legacyActiveContextPayload.json'));
  assert.equal(camera.contractVersion, undefined);
  assert.equal(mixed.provenanceVersion, undefined);
  assert.ok(legacy);
  assert.equal(mixed.visualCollection.evidence.length, 3);
});

test('E-1 telemetry allowlist includes normalization counters only', () => {
  const telemetry = read('supabase/functions/stylechat-generate/telemetry.ts');
  assert.match(telemetry, /normalizationLatencyMs/);
  assert.match(telemetry, /resolverOutcomeCounts/);
  assert.match(telemetry, /ALLOWED_KEYS/);
  assert.doesNotMatch(telemetry, /'title'/);
  assert.doesNotMatch(telemetry, /'summary'/);
});
