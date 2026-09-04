import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildExplicitStillCapture } from '../stillCapture';
import type { PhotorealBridgePayload } from '../bridgePayload';
import { requestPhotorealCapture } from '../photorealIntent';
import { MOCK_PERSON_DATA_URI, buildVtoGenerateRequestFromCapture } from '../mockBridgeAdapter';

function validPayload(): PhotorealBridgePayload {
  const captureOutcome = buildExplicitStillCapture({
    captureId: 'cap-1',
    userConfirmed: true,
    localUri: 'file:///cache/photoreal-still-1.jpg',
  });
  if (!captureOutcome.ok) throw new Error('test fixture setup failed');
  return {
    capture: captureOutcome.capture,
    garment: {
      productRef: 'prod-123',
      imageUrl: 'https://example-retailer.test/garment.jpg',
      category: 'top',
      brand: 'Example Brand',
      commerceSource: 'scan_result',
    },
    origin: 'scan_result',
    requestId: 'req-1',
  };
}

test('builds the exact vto-generate request shape from a bridge payload', () => {
  const outcome = buildVtoGenerateRequestFromCapture(validPayload());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.request, {
    requestId: 'req-1',
    origin: 'scan_result',
    person: { dataUri: MOCK_PERSON_DATA_URI },
    garment: {
      productRef: 'prod-123',
      imageUrl: 'https://example-retailer.test/garment.jpg',
      category: 'top',
      brand: 'Example Brand',
      commerceSource: 'scan_result',
    },
  });
});

test('the request shape carries no field outside what services/vto/vtoClient.ts#requestVtoGeneration actually sends', () => {
  const outcome = buildVtoGenerateRequestFromCapture(validPayload());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(Object.keys(outcome.request).sort(), ['garment', 'origin', 'person', 'requestId']);
  assert.deepEqual(Object.keys(outcome.request.garment).sort(), ['brand', 'category', 'commerceSource', 'imageUrl', 'productRef']);
  assert.deepEqual(Object.keys(outcome.request.person), ['dataUri']);
});

test('refuses with bridge_contract_mismatch when the capture has no local URI to point to', () => {
  const payload = validPayload();
  const brokenCapture = { ...payload.capture, localUri: '' };
  const outcome = buildVtoGenerateRequestFromCapture({ ...payload, capture: brokenCapture });
  assert.deepEqual(outcome, { ok: false, reason: 'bridge_contract_mismatch' });
});

test('never transmits the real localUri: the mock person dataUri is always the fixed local fixture constant', () => {
  const outcome = buildVtoGenerateRequestFromCapture(validPayload());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.request.person.dataUri, MOCK_PERSON_DATA_URI);
  assert.ok(!outcome.request.person.dataUri.includes('cache/photoreal-still'));
});

/** Strips comments before pattern-matching. This file's own doc comments
 *  legitimately DISCUSS the forbidden primitives ("Nothing in this file
 *  imports `fetch`, `XMLHttpRequest`, ...") to explain the constraint --
 *  matching against raw source text (including comments) would make this
 *  test fail on its own honest documentation. Matching against CODE is the
 *  actual property under test. Good enough for this controlled file (no
 *  string literal in it resembles a comment delimiter); not a general
 *  parser. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('static source audit: this adapter file\'s CODE (comments excluded) contains no network/transport primitive and no staging/production reference', () => {
  // This test file runs compiled from dist/__tests__/, so __dirname at
  // runtime is .../dist/__tests__ -- the .ts source (never emitted to dist)
  // lives two levels up in src/, not one level up in dist/.
  const sourcePath = path.resolve(__dirname, '..', '..', 'src', 'mockBridgeAdapter.ts');
  const code = stripComments(fs.readFileSync(sourcePath, 'utf8'));
  const forbiddenPatterns = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /\baxios\b/,
    /\bsupabase\b/i,
    /\bWebSocket\b/,
    /require\(\s*['"]https?['"]\s*\)/,
    /require\(\s*['"]net['"]\s*\)/,
    /\bstaging\b/i,
    /\bproduction\b/i,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(code, pattern, `mockBridgeAdapter.ts code must not reference ${pattern}`);
  }
});

test('end-to-end: advancing the intent state machine to GENERATIVE_HANDOFF_READY and building a request never touches a forbidden field', () => {
  let state: Parameters<typeof requestPhotorealCapture>[0] = 'LIVE_LOCAL';
  for (let i = 0; i < 3; i += 1) {
    const step = requestPhotorealCapture(state);
    assert.equal(step.ok, true);
    if (step.ok) state = step.to;
  }
  assert.equal(state, 'GENERATIVE_HANDOFF_READY');

  const outcome = buildVtoGenerateRequestFromCapture(validPayload());
  assert.equal(outcome.ok, true);
});
