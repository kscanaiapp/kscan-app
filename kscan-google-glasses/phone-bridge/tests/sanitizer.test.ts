import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Mirrors Android PrivacyImageSanitizer strict behavior at TS boundary for docs/CI.
 * Production sanitizer lives in Kotlin — this test documents expected policy.
 */

type SanitizeResult =
  | { ok: true; sanitizedBase64: string }
  | { ok: false; reason: string };

function mockSanitizer(base64: string): SanitizeResult {
  if (!base64) return { ok: false, reason: 'Empty image payload' };
  return { ok: true, sanitizedBase64: base64 };
}

function strictUploadGate(result: SanitizeResult, allowRawFallback: boolean): 'upload' | 'block' {
  if (result.ok) return 'upload';
  if (allowRawFallback) return 'block'; // production: never allow raw fallback
  return 'block';
}

describe('privacy sanitizer policy', () => {
  it('blocks empty payloads', () => {
    const result = mockSanitizer('');
    assert.equal(strictUploadGate(result, false), 'block');
  });

  it('allows mock sanitizer success', () => {
    const result = mockSanitizer('abc123');
    assert.equal(strictUploadGate(result, false), 'upload');
  });

  it('never allows raw fallback in production config', () => {
    const result: SanitizeResult = { ok: false, reason: 'ML Kit not implemented' };
    assert.equal(strictUploadGate(result, false), 'block');
  });
});
