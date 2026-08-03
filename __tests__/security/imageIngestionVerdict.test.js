#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { VERDICTS, userFacingMessage, sign, verify } = require('../../security/ingestion-gate/verdict');

test('userFacingMessage: never leaks internals -- every mapped message is one of five generic strings', () => {
  const allowed = new Set([
    'This image format is not supported.',
    'This image is too large.',
    'This image was rejected for safety reasons.',
    'This image could not be processed.',
    'The scanning service is temporarily unavailable. Please try again shortly.',
  ]);
  for (const code of Object.values(VERDICTS)) {
    if (code === VERDICTS.PENDING || code === VERDICTS.CLEAN) continue;
    assert.ok(allowed.has(userFacingMessage(code)), `${code} -> "${userFacingMessage(code)}" is not one of the allowed generic messages`);
  }
});

test('userFacingMessage: unknown verdict codes fall back to a generic message, never throw', () => {
  assert.equal(userFacingMessage('SOMETHING_MADE_UP'), 'This image could not be processed.');
});

test('sign/verify: a freshly signed CLEAN verdict verifies successfully', () => {
  const payload = { verdict: VERDICTS.CLEAN, sha256Original: 'abc', expiresAt: Date.now() + 60000 };
  const token = sign(payload, 'test-secret');
  const result = verify(token, 'test-secret');
  assert.equal(result.ok, true);
  assert.equal(result.payload.sha256Original, 'abc');
});

test('verify: rejects a token signed with a different secret (forged verdict)', () => {
  const payload = { verdict: VERDICTS.CLEAN, expiresAt: Date.now() + 60000 };
  const token = sign(payload, 'secret-a');
  const result = verify(token, 'secret-b');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'forged_or_tampered');
});

test('verify: rejects a token whose payload was tampered with after signing', () => {
  const payload = { verdict: VERDICTS.CLEAN, sha256Original: 'original-hash', expiresAt: Date.now() + 60000 };
  const token = sign(payload, 'test-secret');
  const [payloadB64, mac] = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, sha256Original: 'attacker-controlled-hash' })).toString('base64url');
  const tamperedToken = `${tamperedPayload}.${mac}`;
  const result = verify(tamperedToken, 'test-secret');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'forged_or_tampered');
});

test('verify: rejects an expired verdict', () => {
  const payload = { verdict: VERDICTS.CLEAN, expiresAt: Date.now() - 1000 };
  const token = sign(payload, 'test-secret');
  const result = verify(token, 'test-secret');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('verify: rejects a non-CLEAN verdict even if the signature is valid', () => {
  const payload = { verdict: VERDICTS.REJECTED_MALWARE, expiresAt: Date.now() + 60000 };
  const token = sign(payload, 'test-secret');
  const result = verify(token, 'test-secret');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_clean');
});

test('verify: rejects a malformed token string', () => {
  assert.equal(verify('not-a-real-token', 'test-secret').ok, false);
  assert.equal(verify('', 'test-secret').ok, false);
  assert.equal(verify(null, 'test-secret').ok, false);
});

test('verify: rejects when no secret is configured', () => {
  const token = sign({ verdict: VERDICTS.CLEAN, expiresAt: Date.now() + 60000 }, 'test-secret');
  const result = verify(token, '');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_secret_configured');
});

test('sign: throws if called with no secret (never emits an unsigned "verdict")', () => {
  assert.throws(() => sign({ verdict: VERDICTS.CLEAN }, ''), /requires a non-empty secret/);
  assert.throws(() => sign({ verdict: VERDICTS.CLEAN }, undefined), /requires a non-empty secret/);
});
