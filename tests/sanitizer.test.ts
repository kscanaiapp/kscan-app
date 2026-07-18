import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Contract model for the privacy sanitizer policy.
// Mirrors the Kotlin sealed SanitizeResult: success / blocked / error.
// There is intentionally NO raw-fallback variant: a failed sanitizer can never
// produce an uploadable payload.

type SanitizeResult =
  | { kind: 'success'; sanitizedBase64: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; message: string };

type PipelineOutcome =
  | { kind: 'analyze'; dataUrl: string }
  | { kind: 'stopped'; stage: 'sanitizer'; reason: string };

// The ONLY path from capture to analyze. The analyze payload is built solely
// from sanitizer output; raw capture bytes have no route around it.
function runScanPipeline(rawBase64: string, sanitizer: (b: string) => SanitizeResult): PipelineOutcome {
  const result = sanitizer(rawBase64);
  switch (result.kind) {
    case 'success':
      return { kind: 'analyze', dataUrl: `data:image/jpeg;base64,${result.sanitizedBase64}` };
    case 'blocked':
      return { kind: 'stopped', stage: 'sanitizer', reason: result.reason };
    case 'error':
      return { kind: 'stopped', stage: 'sanitizer', reason: result.message };
  }
}

const successSanitizer = (b: string): SanitizeResult =>
  b ? { kind: 'success', sanitizedBase64: `sanitized(${b})` } : { kind: 'blocked', reason: 'Empty image payload' };

describe('privacy sanitizer policy', () => {
  it('sanitizer success proceeds to analyze with the sanitized payload', () => {
    const outcome = runScanPipeline('raw-capture', successSanitizer);
    assert.equal(outcome.kind, 'analyze');
    if (outcome.kind === 'analyze') {
      assert.ok(outcome.dataUrl.startsWith('data:image/'));
      assert.ok(outcome.dataUrl.includes('sanitized(raw-capture)'));
    }
  });

  it('sanitizer blocked stops before analyze', () => {
    const outcome = runScanPipeline('raw-capture', () => ({ kind: 'blocked', reason: 'face masking unavailable' }));
    assert.deepEqual(outcome, { kind: 'stopped', stage: 'sanitizer', reason: 'face masking unavailable' });
  });

  it('sanitizer error stops before analyze', () => {
    const outcome = runScanPipeline('raw-capture', () => ({ kind: 'error', message: 'sanitizer crashed' }));
    assert.deepEqual(outcome, { kind: 'stopped', stage: 'sanitizer', reason: 'sanitizer crashed' });
  });

  it('empty payload is blocked before analyze', () => {
    const outcome = runScanPipeline('', successSanitizer);
    assert.equal(outcome.kind, 'stopped');
  });

  it('raw fallback is impossible: analyze never receives raw capture bytes', () => {
    // Across every sanitizer outcome, no pipeline run may forward the raw input.
    const outcomes = [
      runScanPipeline('RAW-BYTES', successSanitizer),
      runScanPipeline('RAW-BYTES', () => ({ kind: 'blocked', reason: 'x' })),
      runScanPipeline('RAW-BYTES', () => ({ kind: 'error', message: 'x' })),
    ];
    for (const outcome of outcomes) {
      if (outcome.kind === 'analyze') {
        assert.ok(!outcome.dataUrl.includes('data:image/jpeg;base64,RAW-BYTES'));
      }
    }
    // And a failed sanitizer can never yield an analyze outcome at all.
    const failed = outcomes.filter((o) => o.kind === 'stopped');
    assert.equal(failed.length, 2);
  });
});
