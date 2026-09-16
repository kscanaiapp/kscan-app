'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REQUIRED_ENV_VARS,
  hashRequestId,
  parseResolutionDiagnostic,
} = require('../security/release/run-elise-dominant-garment-live-probe');

test('live probe requires log authority for same-request resolution evidence', () => {
  assert.ok(REQUIRED_ENV_VARS.includes('SUPABASE_ACCESS_TOKEN'));
});

test('live probe parses a same-request dominant resolution diagnostic', () => {
  assert.equal(hashRequestId('req-dominant'), 'b82ef26f144d');
  assert.deepEqual(
    parseResolutionDiagnostic(
      '[scan-identify] elise_item_candidate_resolution requestHash=b82ef26f144d entryPath=elise_gallery detected=2 outcome=dominant reason=area_dominance',
    ),
    {
      requestHash: 'b82ef26f144d',
      entryPath: 'elise_gallery',
      detected: 2,
      outcome: 'dominant',
      reason: 'area_dominance',
    },
  );
});

test('live probe parses comparable-area ambiguity and ignores unrelated logs', () => {
  assert.deepEqual(
    parseResolutionDiagnostic(
      '[scan-identify] elise_item_candidate_resolution requestHash=4ac49aa3c744 entryPath=elise_gallery detected=4 outcome=ambiguous reason=comparable_area',
    ),
    {
      requestHash: '4ac49aa3c744',
      entryPath: 'elise_gallery',
      detected: 4,
      outcome: 'ambiguous',
      reason: 'comparable_area',
    },
  );
  assert.equal(parseResolutionDiagnostic('[scan-identify] unrelated event'), null);
});
