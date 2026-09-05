import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCorrectionTriage } from '../src/correctionTriage';
import { TERMINAL_REJECTION_CODES } from '../src/types';

test('classifyCorrectionTriage: null rejection (e.g. a system error, or no rejection at all) is UNKNOWN', () => {
  assert.equal(classifyCorrectionTriage(null), 'UNKNOWN');
});

test('classifyCorrectionTriage: every terminal rejection code resolves to a real, defined classification', () => {
  for (const code of TERMINAL_REJECTION_CODES) {
    const result = classifyCorrectionTriage(code);
    assert.ok(['POTENTIALLY_CORRECTABLE', 'NOT_ECONOMICALLY_CORRECTABLE', 'UNKNOWN'].includes(result), `${code} produced an invalid triage class: ${result}`);
  }
});

test('classifyCorrectionTriage: examples from the brief are correctable', () => {
  assert.equal(classifyCorrectionTriage('EXTRACTION_UNRELIABLE'), 'POTENTIALLY_CORRECTABLE');
  assert.equal(classifyCorrectionTriage('ANCHORS_INCOMPLETE'), 'POTENTIALLY_CORRECTABLE');
  assert.equal(classifyCorrectionTriage('CROP_INCOMPLETE'), 'POTENTIALLY_CORRECTABLE');
});

test('classifyCorrectionTriage: examples from the brief are not economically correctable', () => {
  assert.equal(classifyCorrectionTriage('OCCLUSION_TOO_HIGH'), 'NOT_ECONOMICALLY_CORRECTABLE');
  assert.equal(classifyCorrectionTriage('MULTIPLE_GARMENTS'), 'NOT_ECONOMICALLY_CORRECTABLE');
  assert.equal(classifyCorrectionTriage('UNSUPPORTED_CATEGORY'), 'NOT_ECONOMICALLY_CORRECTABLE');
  assert.equal(classifyCorrectionTriage('PRODUCT_FIDELITY_FAILED'), 'NOT_ECONOMICALLY_CORRECTABLE');
});
