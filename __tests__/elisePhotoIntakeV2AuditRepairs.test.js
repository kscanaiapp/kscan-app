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
//   2. ATTACH-FIRST SEPARATION — identification enriches a private candidate,
//      Attach can consume that candidate without Closet promotion, and Save to
//      Closet remains a separate, retryable action.

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

test('identification enriches the private candidate from the styling-safe identity', () => {
  assert.ok(
    source.includes('const identity = groundableItems(input.context ?? null)[0]?.identification ?? null;'),
    'enrichment reads the projection, never the canonical result',
  );
  for (const field of ['clothingType', 'primaryColor', 'secondaryColors', 'material']) {
    assert.ok(
      source.includes(field),
      `the V2 candidate path must carry ${field} into private staging`,
    );
  }
  assert.ok(
    !source.includes('identificationSnapshotV2: '),
    'the canonical snapshot must NOT be persisted from the intake — it carries transport correlation',
  );
});

test('Attach and Save are independent handlers with complete context dependencies', () => {
  const attachStart = source.indexOf('const handleAttach = useCallback');
  const saveStart = source.indexOf('const handleSaveToCloset = useCallback');
  const tryAnotherStart = source.indexOf('const handleTryAnother = useCallback');
  assert.ok(attachStart >= 0 && saveStart > attachStart && tryAnotherStart > saveStart);

  const attachBlock = source.slice(attachStart, saveStart);
  const saveBlock = source.slice(saveStart, tryAnotherStart);
  assert.doesNotMatch(attachBlock, /promoteSelectedClosetCandidates/);
  assert.match(saveBlock, /promoteSelectedClosetCandidates/);
  assert.ok(
    attachBlock.includes('fashionContext') && saveBlock.includes('fashionContext'),
    'both handlers must use the current identified context',
  );
});
