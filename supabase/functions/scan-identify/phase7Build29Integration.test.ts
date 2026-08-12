/**
 * Scanner Phase 7 — Build 29 integration hostility.
 *
 * These cases could not exist on the legacy Phase 7 branches: they assert the
 * forward-ported recheck against the properties Build 29 added AFTER the fork —
 * the content-blind observability boundary, the single-scan transaction, and
 * the privacy-processed image path.
 *
 * The provider seam is injected, so no network, no model and no image ever
 * leave this file. All fixture content is synthetic.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

// @ts-ignore Deno local imports require explicit TypeScript extensions.
import {
  performIdentificationRecheck,
  type RecheckProvider,
} from './identificationRecheck.ts';
// @ts-ignore Deno local imports require explicit TypeScript extensions.
import {
  evaluateIdentificationGate,
  isRecheckEligibleMode,
  type RecheckReasonCode,
} from './identificationRecheckGate.ts';
// @ts-ignore Deno local imports require explicit TypeScript extensions.
import { emptyRecheckMetrics } from './identificationRecheckTelemetry.ts';
// @ts-ignore Deno local imports require explicit TypeScript extensions.
import {
  RECHECK_MAX_PROVIDER_CALLS,
  isIdentificationRecheckEnabled,
} from './identificationRecheckConfig.ts';

const IMAGE = 'c3ludGhldGljLXByb2Nlc3NlZC1pbWFnZS1ieXRlcw==';

const PROMPT_INPUT = {
  discriminatorFocus: null,
  primaryBrand: null,
  primary: { category: 'top', clothingType: 'shirt', subtype: 'oxford shirt' },
  primaryConfidence: 0.4,
  reasonCodes: ['LOW_IDENTITY_CONFIDENCE'] as RecheckReasonCode[],
  garmentContext: null,
};

function provider(result: Partial<Awaited<ReturnType<RecheckProvider>>>, onCall?: () => void): RecheckProvider {
  return (req) => {
    onCall?.();
    // The recheck must be handed the SAME processed image it was given.
    assertEquals(req.imageBase64, IMAGE);
    return Promise.resolve({
      ok: true,
      text: null,
      finishReason: 'STOP',
      usage: null,
      failureKind: null,
      ...result,
    } as Awaited<ReturnType<RecheckProvider>>);
  };
}

/* ── Bounded by construction ─────────────────────────────────────────────── */

Deno.test('B29: one recheck spends exactly one provider call, never more', async () => {
  let calls = 0;
  await performIdentificationRecheck(
    { ...PROMPT_INPUT, imageBase64: IMAGE, mimeType: 'image/jpeg' },
    provider({ text: JSON.stringify({ item_type: 'top', clothing_type: 'shirt', subtype: 'oxford shirt' }) }, () => { calls += 1; }),
  );
  assertEquals(calls, 1);
  assertEquals(RECHECK_MAX_PROVIDER_CALLS, 1);
});

Deno.test('B29: a failing recheck does not retry — it fails open on one attempt', async () => {
  let calls = 0;
  const outcome = await performIdentificationRecheck(
    { ...PROMPT_INPUT, imageBase64: IMAGE, mimeType: 'image/jpeg' },
    provider({ ok: false, failureKind: 'timeout', text: null }, () => { calls += 1; }),
  );
  assertEquals(calls, 1, 'a timeout must not be retried');
  assertEquals(outcome.status, 'failed');
});

Deno.test('B29: a provider that throws is contained, not propagated to the scan', async () => {
  const outcome = await performIdentificationRecheck(
    { ...PROMPT_INPUT, imageBase64: IMAGE, mimeType: 'image/jpeg' },
    () => Promise.reject(new Error('SYNTHETIC provider explosion')),
  );
  assertEquals(outcome.status, 'failed', 'the scan must survive a thrown provider');
});

/* ── Privacy: the recheck cannot reach an unprocessed image ──────────────── */

Deno.test('B29: the recheck performs no image retrieval of its own', () => {
  const source = Deno.readTextFileSync(
    new URL('./identificationRecheck.ts', import.meta.url),
  );
  // The only image it can ever see is the buffer handed in. Any fetch, storage
  // read or signed-URL resolution here would be a path around Privacy Lens.
  for (const forbidden of ['fetch(', 'createClient', 'storage', 'signedUrl', 'createSignedUrl', 'download(']) {
    assert(
      !source.includes(forbidden),
      `identificationRecheck must not perform I/O of its own (found ${forbidden})`,
    );
  }
});

Deno.test('B29: a scan with no image evidence is ineligible, never re-fetched', () => {
  // Mirrors the index.ts eligibility branch: no image => ineligible, and there
  // is deliberately no path that goes and finds one.
  // Only a resolved single garment is eligible: detection resolves none, and
  // text mode has no image to look at again.
  assertEquals(isRecheckEligibleMode('detection'), false);
  assertEquals(isRecheckEligibleMode('text'), false);
  assertEquals(isRecheckEligibleMode('multi_item_detection'), false);
  assert(isRecheckEligibleMode('legacy_single_item'));
  assert(isRecheckEligibleMode('selected_item'));
});

/* ── Measurement is content-blind ────────────────────────────────────────── */

Deno.test('B29: recheck metrics carry no free text from the model or the image', async () => {
  const PROMPT_LEAK = 'SYNTHPROMPT a black wool blazer belonging to jane.doe@example.invalid';
  const metrics = emptyRecheckMetrics(true, PROMPT_INPUT.primary);
  const outcome = await performIdentificationRecheck(
    { ...PROMPT_INPUT, imageBase64: IMAGE, mimeType: 'image/jpeg' },
    provider({
      // A provider that returns prose instead of the schema.
      text: PROMPT_LEAK,
      finishReason: 'STOP',
    }),
  );
  metrics.recheckStatus = outcome.status;
  metrics.recheckFailureReason = outcome.status === 'failed' ? outcome.reason : null;

  const serialized = JSON.stringify(metrics);
  assert(!serialized.includes('SYNTHPROMPT'), 'model prose reached the metrics');
  assert(!serialized.includes('example.invalid'), 'an email reached the metrics');
  assert(!serialized.includes(IMAGE), 'image bytes reached the metrics');
  // A malformed answer is a bounded failure code, never a transcript.
  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.status === 'failed' && outcome.reason, 'malformed_output');
});

Deno.test('B29: every recheck failure reason is a bounded code, never provider text', async () => {
  for (const kind of ['timeout', 'http_error', 'network_error', 'empty_response'] as const) {
    const outcome = await performIdentificationRecheck(
      { ...PROMPT_INPUT, imageBase64: IMAGE, mimeType: 'image/jpeg' },
      provider({ ok: false, failureKind: kind, text: 'SYNTHETIC raw provider body' }),
    );
    assertEquals(outcome.status, 'failed');
    assertEquals(outcome.status === 'failed' && outcome.reason, kind);
  }
});

/* ── The gate is deterministic and provider-free ─────────────────────────── */

Deno.test('B29: the gate reaches the same verdict every time for the same input', () => {
  const input = {
    identity: { category: 'top', clothingType: null, subtype: 'wide leg jeans' },
    globalConfidence: 0.3,
    consistencyConflictCodes: [],
    qualityBand: 'low' as const,
    visualObservations: ['a garment'],
    identityBearing: true,
  };
  const first = evaluateIdentificationGate(input);
  for (let i = 0; i < 25; i += 1) {
    assertEquals(evaluateIdentificationGate(input), first);
  }
});

Deno.test('B29: a missing confidence score is never read as a low one', () => {
  const base = {
    identity: { category: 'top', clothingType: 'shirt', subtype: 'oxford shirt' },
    consistencyConflictCodes: [],
    qualityBand: null,
    visualObservations: ['a crisp cotton oxford shirt with a button-down collar'],
    identityBearing: true,
  };
  const missing = evaluateIdentificationGate({ ...base, globalConfidence: null });
  assert(
    !missing.triggeringReasonCodes.includes('LOW_IDENTITY_CONFIDENCE'),
    'a null confidence must not be treated as low confidence',
  );
});

Deno.test('B29: a corroborating reason never spends a provider call on its own', () => {
  const result = evaluateIdentificationGate({
    identity: { category: 'top', clothingType: 'shirt', subtype: 'oxford shirt' },
    globalConfidence: 0.95,
    consistencyConflictCodes: ['BRAND_IDENTITY_CONFLICT', 'MATERIAL_IDENTITY_CONFLICT'],
    qualityBand: 'high',
    visualObservations: ['a crisp cotton oxford shirt with a button-down collar'],
    identityBearing: true,
  });
  assertEquals(result.decision, 'CLEAR');
  assertEquals(result.triggeringReasonCodes.length, 0);
});

/* ── Ships dark ──────────────────────────────────────────────────────────── */

Deno.test('B29: the recheck is OFF unless explicitly enabled', () => {
  assertEquals(isIdentificationRecheckEnabled(() => undefined), false);
  assertEquals(isIdentificationRecheckEnabled(() => ''), false);
  assertEquals(isIdentificationRecheckEnabled(() => 'false'), false);
  assertEquals(isIdentificationRecheckEnabled(() => 'maybe'), false);
  assertEquals(isIdentificationRecheckEnabled(() => 'true'), true);
});

Deno.test('B29: with the flag off the metrics baseline reports a single provider call', () => {
  const metrics = emptyRecheckMetrics(false, PROMPT_INPUT.primary);
  assertEquals(metrics.flagEnabled, false);
  assertEquals(metrics.recheckTriggered, false);
  assertEquals(metrics.gateDecision, 'NOT_EVALUATED');
  assertEquals(metrics.identificationProviderCalls, 1);
  assertEquals(metrics.finalIdentity, PROMPT_INPUT.primary);
});
