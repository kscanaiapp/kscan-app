import assert from 'node:assert/strict';

import {
  classifyProviderFailure,
  PROVIDER_ERROR_INSPECTION_LIMIT_BYTES,
  providerFailureError,
} from './providerFailure.ts';
import { StylistSpeechError } from './types.ts';

function detailBody(status: string, message = 'secret provider detail message'): string {
  return JSON.stringify({ detail: { status, message } });
}

Deno.test('classifies a 400 provider rejection as an invalid request', () => {
  const result = classifyProviderFailure(400, detailBody('invalid_request'));
  assert.equal(result.category, 'provider_invalid_request');
  assert.equal(result.code, 'PROVIDER_INVALID_REQUEST');
  assert.equal(result.clientStatus, 502);
  assert.equal(result.providerErrorStatus, 'invalid_request');
});

Deno.test('classifies a 401 provider rejection as an auth failure', () => {
  const result = classifyProviderFailure(401, detailBody('invalid_api_key'));
  assert.equal(result.category, 'provider_auth_failed');
  assert.equal(result.code, 'PROVIDER_AUTH_FAILED');
  assert.equal(result.clientStatus, 502);
});

Deno.test('classifies a 403 provider rejection as an auth failure', () => {
  const result = classifyProviderFailure(403, detailBody('missing_permissions'));
  assert.equal(result.category, 'provider_auth_failed');
  assert.equal(result.code, 'PROVIDER_AUTH_FAILED');
});

Deno.test('classifies a 403 voice-scoped rejection as voice unavailable', () => {
  const result = classifyProviderFailure(403, detailBody('voice_not_allowed'));
  assert.equal(result.category, 'provider_voice_unavailable');
  assert.equal(result.code, 'PROVIDER_VOICE_UNAVAILABLE');
});

Deno.test('classifies a 404 provider rejection as voice unavailable', () => {
  const result = classifyProviderFailure(404, detailBody('voice_not_found'));
  assert.equal(result.category, 'provider_voice_unavailable');
  assert.equal(result.code, 'PROVIDER_VOICE_UNAVAILABLE');
});

Deno.test('classifies a 422 provider rejection as an invalid request', () => {
  const result = classifyProviderFailure(422, detailBody('invalid_content'));
  assert.equal(result.category, 'provider_invalid_request');
  assert.equal(result.code, 'PROVIDER_INVALID_REQUEST');
});

Deno.test('classifies a 422 model-scoped rejection as model unavailable', () => {
  const result = classifyProviderFailure(422, detailBody('model_not_found'));
  assert.equal(result.category, 'provider_model_unavailable');
  assert.equal(result.code, 'PROVIDER_MODEL_UNAVAILABLE');
});

Deno.test('classifies a generic 429 provider rejection as rate limited, not quota', () => {
  const result = classifyProviderFailure(429, detailBody('too_many_requests'));
  assert.equal(result.category, 'provider_rate_limited');
  assert.equal(result.code, 'PROVIDER_RATE_LIMIT');
  assert.equal(result.stableErrorClass, 'RATE_LIMIT');
  assert.equal(result.clientStatus, 429);
});

Deno.test('classifies explicit 429 quota exhaustion separately', () => {
  const result = classifyProviderFailure(429, detailBody('quota_exceeded'));
  assert.equal(result.category, 'provider_quota_exceeded');
  assert.equal(result.code, 'PROVIDER_QUOTA_EXCEEDED');
  assert.equal(result.stableErrorClass, 'QUOTA_EXHAUSTED');
});

Deno.test('classifies a 5xx provider rejection as provider unavailable', () => {
  for (const status of [500, 502, 503]) {
    const result = classifyProviderFailure(status, detailBody('internal_error'));
    assert.equal(result.category, 'provider_unavailable');
    assert.equal(result.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(result.clientStatus, 502);
  }
});

Deno.test('classifies a non-JSON provider error body without leaking it', () => {
  const result = classifyProviderFailure(401, 'plain-text-provider-secret-body');
  assert.equal(result.isJson, false);
  assert.equal(result.providerErrorStatus, null);
  assert.equal(result.category, 'provider_auth_failed');
  assert.doesNotMatch(result.message, /plain-text-provider-secret-body/);
});

Deno.test('bounds an oversized provider error body to the inspection limit', () => {
  const huge = 'x'.repeat(PROVIDER_ERROR_INSPECTION_LIMIT_BYTES * 4);
  const result = classifyProviderFailure(500, huge);
  assert.ok(result.inspectedByteLength <= PROVIDER_ERROR_INSPECTION_LIMIT_BYTES);
  assert.equal(result.totalByteLength, huge.length);
  assert.equal(result.category, 'provider_unavailable');
});

Deno.test('never retains free-text or oversized tokens from the provider body', () => {
  const result = classifyProviderFailure(
    422,
    JSON.stringify({ detail: { status: 'a very long free text status that should be dropped entirely' } }),
  );
  assert.equal(result.providerErrorStatus, null);
});

Deno.test('the public error carries only a fixed sanitized message', () => {
  const classification = classifyProviderFailure(401, detailBody('invalid_api_key'));
  const error = providerFailureError(classification);
  assert.ok(error instanceof StylistSpeechError);
  assert.equal(error.status, 502);
  assert.equal(error.code, 'PROVIDER_AUTH_FAILED');
  assert.doesNotMatch(error.message, /invalid_api_key/);
  assert.doesNotMatch(error.message, /secret provider detail message/);
});
