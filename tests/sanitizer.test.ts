import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

type SanitizeResult =
  | { ok: true; sanitizedBase64: string }
  | { ok: false; reason: string };

function mockSanitizer(base64: string): SanitizeResult {
  if (!base64) return { ok: false, reason: 'Empty image payload' };
  return { ok: true, sanitizedBase64: base64 };
}

function strictUploadGate(result: SanitizeResult, allowRawFallback: boolean): 'upload' | 'block' {
  if (result.ok) return 'upload';
  if (allowRawFallback) return 'block';
  return 'block';
}

describe('privacy sanitizer policy', () => {
  it('blocks empty payloads', () => {
    assert.equal(strictUploadGate(mockSanitizer(''), false), 'block');
  });

  it('allows mock sanitizer success', () => {
    assert.equal(strictUploadGate(mockSanitizer('abc123'), false), 'upload');
  });

  it('blocks when production sanitizer not ready', () => {
    const result: SanitizeResult = { ok: false, reason: 'ML Kit not implemented' };
    assert.equal(strictUploadGate(result, false), 'block');
  });
});
