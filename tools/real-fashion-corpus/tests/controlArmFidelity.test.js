'use strict';

/**
 * Control-arm fidelity (spec section 11).
 *
 * The mechanism this proves is NOT new: `lib/replay.js` already exists to
 * let a real Scanner response be captured once and scored offline
 * repeatedly (see its own header for why it was built rather than reusing
 * FMQ's own empty `replay/corpus/`). What this test file proves is that the
 * mechanism is V2-ready and IS the deterministic "catalog snapshot" this
 * spec section asks for:
 *
 *   - a replay record's `observedResponse.candidateProducts` is the catalog
 *     snapshot for its case - the exact array `compileCase` puts on the
 *     compiled fixture, unmodified;
 *   - that snapshot's provenance is captured on the record itself
 *     (`replayId`, `capturedAt`, `sanitization.reviewedBy` - FMQL's own
 *     `validateReplayRecord` already requires all three);
 *   - because the fixture is built once and handed to any evaluator, a
 *     future FashionCLIP-side evaluator and today's FMQ evaluator score the
 *     IDENTICAL query/candidate universe for the same case - only the
 *     scorer differs, never the input;
 *   - the whole path is offline: replay is a committed JSON record, not a
 *     live call (already proven zero-network for the compile/evaluate path
 *     in fmqIntegrationV2.test.js).
 *
 * Building a NEW recording mechanism would duplicate lib/replay.js for no
 * reason - this file documents-by-testing that the existing one already
 * satisfies the requirement.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { compileCase } = require('../lib/compile');
const { makeGarment, makeCase } = require('./fixtures/sampleRecords');

function sampleReplayRecord(overrides = {}) {
  return {
    replayId: 'REPLAY-0001',
    caseId: 'C0001',
    capturedAt: '2026-09-01T00:00:00.000Z',
    request: { evidenceId: 'ev-00000001' },
    observedResponse: {
      candidateProducts: [
        { id: 'cat-1', product_name: 'Test Quilted Jacket', canonical_category: 'outerwear', color_normalized: 'navy' },
        { id: 'cat-2', product_name: 'Similar Quilted Jacket', canonical_category: 'outerwear', color_normalized: 'black' },
      ],
    },
    sanitization: { reviewedBy: 'COL-TEST-01' },
    ...overrides,
  };
}

test('CONTROL ARM: a replay record\'s candidateProducts become the compiled fixture\'s candidate universe verbatim', () => {
  const replayRecord = sampleReplayRecord();
  const compiled = compileCase(makeGarment(), makeCase({ assetTier: 'REAL_CAPTURE', pipelineTestPurpose: undefined }), { replayRecord });
  assert.equal(compiled.ok, true, compiled.error);
  assert.deepEqual(compiled.fixture.candidateProducts, replayRecord.observedResponse.candidateProducts);
  assert.equal(compiled.fixture.realCorpusMeta.candidateSource, 'REPLAY');
});

test('CONTROL ARM: with no replay record, the candidate universe is honestly empty, not fabricated', () => {
  const compiled = compileCase(makeGarment(), makeCase({ assetTier: 'REAL_CAPTURE', pipelineTestPurpose: undefined }));
  assert.equal(compiled.ok, true, compiled.error);
  assert.deepEqual(compiled.fixture.candidateProducts, []);
  assert.equal(compiled.fixture.realCorpusMeta.candidateSource, 'NONE_SCANNER_NOT_RUN');
});

test('CONTROL ARM: two compilations of the same (garment, case, replay) triple produce an identical candidate universe', () => {
  const replayRecord = sampleReplayRecord();
  const garment = makeGarment();
  const caseRecord = makeCase({ assetTier: 'REAL_CAPTURE', pipelineTestPurpose: undefined });
  const first = compileCase(garment, caseRecord, { replayRecord });
  const second = compileCase(garment, caseRecord, { replayRecord });
  assert.deepEqual(first.fixture.candidateProducts, second.fixture.candidateProducts);
  assert.deepEqual(first.fixture.groundTruth, second.fixture.groundTruth);
  assert.deepEqual(first.fixture.garmentIdentification, second.fixture.garmentIdentification);
});

test('CONTROL ARM: the replay record carries its own capture/review provenance (FMQL\'s inherited replay schema)', () => {
  const { validateReplayRecord } = require('../../fashion-match-quality/replay/replaySchema');
  const record = sampleReplayRecord();
  const result = validateReplayRecord(record);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.ok(record.replayId);
  assert.ok(record.capturedAt);
  assert.ok(record.sanitization.reviewedBy);
});

test('CONTROL ARM: a replay record is refused if it tries to smuggle in ground truth (model output is never truth)', () => {
  const { loadReplayRecords } = require('../lib/replay');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-replay-test-'));
  try {
    const record = sampleReplayRecord({ groundTruth: { category: 'outerwear' } });
    fs.writeFileSync(path.join(dir, 'r1.json'), JSON.stringify(record));
    const loaded = loadReplayRecords({ dir });
    assert.equal(loaded.records.length, 0);
    assert.ok(loaded.errors.some((e) => /must not carry groundTruth/.test(e.message)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
