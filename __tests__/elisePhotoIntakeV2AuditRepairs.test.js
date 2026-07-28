// StyleChatPhotoIntake — Phase 2B.3 hostile-audit repairs (Android).
//
// Two defects are pinned here, in this suite's source-governance style
// (the intake is a modal component; its collaborators are proven behaviourally
// in eliseIdentificationV2Migration.test.js, and these assertions pin the
// component wiring that composes them):
//
//   1. LEGACY-FALLBACK REUSE — when the V2 orchestrator already performed its
//      one permitted legacy retry, the intake must consume that paid response
//      instead of purchasing a third identification of the same bytes.
//   2. DURABLE-RECORD PARITY — a flag-on save must not be strictly poorer than
//      a flag-off one. Material, silhouette, style tags and confidence are
//      enriched from the styling-safe identity; the canonical result itself is
//      deliberately NOT persisted (it carries transport correlation).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(ROOT, 'components/style-chat/StyleChatPhotoIntake.tsx'),
  'utf8',
);

test('the intake reuses the orchestrator-paid legacy response', () => {
  assert.ok(
    source.includes("outcome.kind === 'legacy_fallback' && outcome.legacyResponse !== undefined"),
    'the carried response must be captured from the legacy_fallback outcome',
  );
  assert.match(
    source,
    /const identification = paidLegacyResponse \?\? \(prepared\.base64/,
    'the legacy call must be short-circuited by the paid response',
  );
});

test('a flag-on save enriches durable metadata from the styling-safe identity', () => {
  assert.ok(
    source.includes('const savedIdentity = groundableItems(fashionContext)[0]?.identification ?? null;'),
    'enrichment reads the projection, never the canonical result',
  );
  for (const field of ['material', 'silhouette', 'styleTags', 'confidenceScore']) {
    assert.ok(
      source.includes(field),
      `the V2 save path must carry ${field} into the durable record`,
    );
  }
  assert.ok(
    !source.includes('identificationSnapshotV2: '),
    'the canonical snapshot must NOT be persisted from the intake — it carries transport correlation',
  );
});

test('the save handler closure declares every read state (stale-capture guard)', () => {
  const depsMatch = source.match(/\}, \[(title, category, color[^\]]*)\]\);/);
  assert.ok(depsMatch, 'the handleSaveAndAttach dependency array is present');
  assert.ok(
    depsMatch[1].includes('fashionContext'),
    'fashionContext is read inside the handler and must be a declared dependency',
  );
});
