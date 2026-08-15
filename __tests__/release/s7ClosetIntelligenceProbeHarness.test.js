const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const probe = require('../../security/release/run-s7-closet-intelligence-live-probe.js');

test('S7 probe stages expose the exact incremental effective flag state', () => {
  assert.deepEqual(probe.expectedCapabilities('retrieval'), {
    adviceIntentsV1: true,
    closetRetrievalV1: true,
    compatibilityScoringV1: false,
    wardrobeGapV1: false,
    purchaseAdviceV1: false,
    multiLookV1: false,
  });
  assert.deepEqual(probe.expectedCapabilities('multi_look'), Object.fromEntries(
    probe.FLAG_KEYS.map((key) => [key, true]),
  ));
  assert.equal(probe.expectedCapabilities('rollback_multi').multiLookV1, false);
  assert.equal(probe.expectedCapabilities('rollback_multi').purchaseAdviceV1, true);
  assert.throws(() => probe.expectedCapabilities('production'), /UNKNOWN_STAGE/);
});

test('S7 probe capability readback is exact and refuses missing/extra fields', () => {
  const expected = probe.expectedCapabilities('compatibility');
  assert.equal(probe.exactCapabilities({ ...expected }, expected), true);
  assert.equal(probe.exactCapabilities({ ...expected, extra: false }, expected), false);
  const missing = { ...expected };
  delete missing.closetRetrievalV1;
  assert.equal(probe.exactCapabilities(missing, expected), false);
  assert.equal(probe.exactCapabilities({ ...expected, compatibilityScoringV1: false }, expected), false);
});

test('S7 probe evidence allowlist rejects content-bearing and unknown fields', () => {
  const safe = {
    adviceIntent: 'purchase_advice',
    closetInventoryState: 'complete',
    ownedClosetCandidateCount: 0,
    recentScanCandidateCount: 1,
    compatibilityScoringRan: true,
    compatibilityWarningCodes: [],
    wardrobeGapEvidence: 'not_applicable',
    wardrobeGapCount: 0,
    purchaseVerdict: 'consider',
    purchaseReasonCodes: ['balanced_utility'],
    multiLookCount: 0,
    multiLookUngroundedCandidateCount: 0,
    multiLookRepeatedWithinLookCount: 0,
  };
  assert.deepEqual(probe.safeRuntimeEvidence(safe), safe);
  assert.equal(probe.safeRuntimeEvidence({ ...safe, prompt: 'secret' }), null);
  assert.equal(probe.safeRuntimeEvidence(null), null);
});

test('S7 probe Closet wire context has a frozen contract discriminator', () => {
  assert.deepEqual(probe.closetContext('unavailable', []), {
    contractVersion: 'closet_intelligence_context_v1',
    inventoryState: 'unavailable',
    items: [],
  });
});

test('S7 credentialed workflow executes trusted master source and never candidate source', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '.github', 'workflows', 'staging-s7-closet-intelligence-live-probe.yml'),
    'utf8',
  );
  assert.match(workflow, /ref:\s*master/);
  assert.match(workflow, /Resolve candidate provenance \(no checkout, no execution\)/);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*inputs\.candidate_ref\s*\}\}/);
  assert.match(workflow, /KSCAN_S7_PROBE_STAGE:\s*\$\{\{\s*inputs\.stage\s*\}\}/);
  assert.match(workflow, /PRODUCTION_REF:\s*wyyuqfdxucjksghsmhry/);
});

test('governed staging workflow explicitly exposes every reversible S7 flag', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '.github', 'workflows', 'staging-runtime-flag.yml'),
    'utf8',
  );
  const flags = [
    'ELISE_ADVICE_INTENTS_V1_ENABLED',
    'ELISE_CLOSET_RETRIEVAL_V1_ENABLED',
    'ELISE_COMPATIBILITY_SCORING_V1_ENABLED',
    'ELISE_WARDROBE_GAP_V1_ENABLED',
    'ELISE_PURCHASE_ADVICE_V1_ENABLED',
    'ELISE_MULTI_LOOK_V1_ENABLED',
  ];
  for (const flag of flags) {
    const matches = workflow.match(new RegExp(`- ${flag}\\b`, 'g')) || [];
    assert.equal(matches.length, 1, `${flag} must be an explicit single choice`);
  }
  assert.match(workflow, /options:\s*\n\s*- 'true'[\s\S]*?\n\s*- 'false'/);
  assert.doesNotMatch(workflow, /ELISE_\*|\^ELISE_/);
});
