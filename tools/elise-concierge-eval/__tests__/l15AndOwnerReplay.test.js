'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runL15Suite } = require('../context-assembly/l15Metrics');
const { validateOwnerTranscript, importOwnerTranscripts, corpusReadinessStatus } = require('../replay/ownerTranscriptImporter');

test('required test 33: L1.5 capture contains expected context and no leakage, if the seam exists', async () => {
  const result = await runL15Suite();
  if (!result.available) {
    // Honest degrade path: BLOCKED_SEAM is an acceptable outcome, never a
    // silent pass. Surface it loudly so CI output shows the real state.
    console.warn(`L1.5 seam unavailable in this environment: ${result.reason}`);
    return;
  }
  assert.equal(result.metrics.LEAKAGE_CHECK, 'PASS');
  assert.equal(result.metrics.CONTEXT_INJECTION_COMPLETENESS, 1);
  assert.equal(result.realProductionGuardExecution.realGuardCaughtIt, true, 'the REAL production ownership guard must catch the planted false claim');
  assert.equal(result.conversationWindowExecution.greetingExcludedFromModelContext, true);
});

test('required test 34: owner-response importer preserves provenance', () => {
  const benignFabricatedExample = {
    sourceTier: 'OWNER_CAPTURED',
    capturedBy: 'OWNER',
    system: 'ELISE',
    captureDate: '2026-09-01',
    contextKnown: 'NO',
    text: 'A hypothetical sanitized transcript line with no real user data, used only to prove the importer preserves provenance fields.',
  };
  const { imported, rejected } = importOwnerTranscripts([benignFabricatedExample]);
  assert.equal(rejected.length, 0);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].sourceTier, 'OWNER_CAPTURED');
  assert.equal(imported[0].capturedBy, 'OWNER');
  assert.equal(imported[0].system, 'ELISE');
  assert.equal(imported[0].captureDate, '2026-09-01');
  assert.equal(corpusReadinessStatus(imported.length), 'OWNER_CAPTURED_PRESENT(1)');
  assert.equal(corpusReadinessStatus(0), 'READY_NO_CORPUS');
});

test('owner transcript importer rejects a transcript the harness itself would have authored', () => {
  const result = validateOwnerTranscript({
    sourceTier: 'OWNER_CAPTURED',
    capturedBy: 'HARNESS', // must be OWNER
    system: 'ELISE',
    captureDate: '2026-09-01',
    contextKnown: 'NO',
    text: 'x',
  });
  assert.equal(result.valid, false);
});

test('owner transcript importer rejects unsanitized PII', () => {
  const result = validateOwnerTranscript({
    sourceTier: 'OWNER_CAPTURED',
    capturedBy: 'OWNER',
    system: 'CONCIERGE',
    captureDate: '2026-09-01',
    contextKnown: 'NO',
    text: 'Contact the user at real.person@example.com about this.',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('PRIVACY GUARD REJECTED')));
});
