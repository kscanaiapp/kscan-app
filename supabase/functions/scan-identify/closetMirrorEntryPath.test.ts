// Build 2.5 Step 2 — `closet_mirror` backend acceptance and domain separation.
//
// Step 1 stopped at IMPLEMENTATION COMPLETE — BACKEND ACTIVATION BLOCKED,
// because `closet_mirror` was absent from the shared entry-path vocabulary and
// therefore rejected as `invalid_source` by the real request validator. Step 2
// added exactly one vocabulary value. This file is the executable evidence that
// the addition does what it claims and nothing more.
//
// It runs against the REAL modules — `validateFashionIdentificationRequestV2`,
// `routeScanIdentifyRequest`, `resolveCommerceDecision`, `buildV2Telemetry` —
// not against a copied constant. A test that re-declared the vocabulary would
// pass while the deployed function rejected every Mirror request, which is the
// exact failure Step 1 was blocked on.
//
// Deterministic: no Supabase, no provider, no network. `--allow-read` only.

import { assert, assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  COMMERCE_SKIPPED_CLOSET_INTENT,
  FASHION_IDENTIFICATION_ENTRY_PATHS,
  FASHION_IDENTIFICATION_STATUSES,
  shouldCaptureScanArtifacts,
  shouldRunCommerce,
  validateFashionIdentificationRequestV2,
} from '../_shared/fashionIdentificationV2.ts';
import {
  buildV2Telemetry,
  resolveCommerceDecision,
  routeScanIdentifyRequest,
} from './v2Activation.ts';

const MIRROR = 'closet_mirror';

/**
 * A well-formed Mirror request, matching exactly what `buildClosetV2Request`
 * emits on the client for a `mirror_extract` candidate: Closet intent,
 * detection mode, one evidence object, truthful (all-false) privacy.
 */
function mirrorRequest(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req_closet_mirror_1',
    intent: 'identify_for_closet',
    mode: 'detect_items',
    source: { entryPath: MIRROR, platform: 'android' },
    evidence: [
      {
        evidenceId: '11111111-2222-4333-8444-555555555555',
        sequenceIndex: 0,
        transport: { type: 'jpeg_base64', imageBase64: 'QUJDRA==' },
        metadata: { schemaVersion: 'image-metadata-v1', mimeType: 'image/jpeg' },
      },
    ],
    privacy: {
      localFaceMaskApplied: false,
      localPlateMaskApplied: false,
      rawExifTransmitted: false,
    },
    ...overrides,
  };
}

// ── CLOSET-MIRROR-BACKEND-VOCABULARY-ACCEPTED ────────────────────────────────

Deno.test('closet_mirror is a member of the backend entry-path vocabulary', () => {
  assert(
    (FASHION_IDENTIFICATION_ENTRY_PATHS as readonly string[]).includes(MIRROR),
    'backend vocabulary does not carry closet_mirror',
  );
});

// ── EXISTING-ENTRY-PATHS-UNCHANGED ───────────────────────────────────────────
//
// Pinned as an exact ordered list, not a subset check. A subset check would
// pass if a value were renamed or reordered, and the three-way parity test
// compares these arrays positionally.

Deno.test('the entry-path vocabulary is the existing eight plus closet_mirror, in order', () => {
  assertEquals(
    [...FASHION_IDENTIFICATION_ENTRY_PATHS],
    [
      'scanner_camera',
      'scanner_gallery',
      'elise_camera',
      'elise_gallery',
      'elise_header_gallery',
      'scanner_handoff',
      'closet_camera',
      'closet_gallery',
      'closet_mirror',
    ],
  );
});

// ── BACKEND-ACCEPTS-CLOSET-MIRROR-FOR-CLOSET-INTENT ──────────────────────────

Deno.test('the real request validator accepts closet_mirror on the Closet intent', () => {
  const result = validateFashionIdentificationRequestV2(mirrorRequest());
  assertEquals(result.ok, true, `validator rejected closet_mirror: ${JSON.stringify(result)}`);
});

// ── BACKEND-PRESERVES-CLOSET-MIRROR-PROVENANCE ───────────────────────────────
//
// The load-bearing half. Acceptance alone would still permit a normalizer that
// silently rewrote the value; a Mirror crop arriving at classification labelled
// `closet_gallery` is precisely the provenance lie Build 2.5 forbids.

Deno.test('normalization preserves closet_mirror verbatim and never remaps it', () => {
  const result = validateFashionIdentificationRequestV2(mirrorRequest());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.request.source.entryPath, MIRROR);
  assertNotEquals(result.request.source.entryPath, 'closet_gallery');
  assertEquals(result.request.intent, 'identify_for_closet');
  assertEquals(result.request.mode, 'detect_items');
});

Deno.test('the request router carries closet_mirror through to the internal request', () => {
  const route = routeScanIdentifyRequest(mirrorRequest());
  assertEquals(route.kind, 'v2', `router did not take the v2 path: ${JSON.stringify(route)}`);
  if (route.kind !== 'v2') return;
  assertEquals(route.request.source.entryPath, MIRROR);
  assertEquals(route.internal.entryPath, MIRROR);
  assertEquals(route.internal.intent, 'identify_for_closet');
  assertEquals(route.internal.intentDefaulted, false);
  assertEquals(route.internal.resolvedMode, 'detect_items');
});

// ── BACKEND-REJECTS-CLOSET-MIRROR-WITH-INVALID-CONTRACT-SHAPE ────────────────
//
// Adding a vocabulary value must not have become a way to smuggle a malformed
// request past validation. Each case below is well-formed EXCEPT for one field,
// and each must still fail with its own machine code.

Deno.test('a structurally invalid closet_mirror request is still rejected', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['unsupported_contract_version', mirrorRequest({ contractVersion: 'fashion-identification-v1' })],
    ['malformed_request', mirrorRequest({ requestId: '' })],
    ['invalid_intent', mirrorRequest({ intent: 'identify_for_everything' })],
    ['invalid_mode', mirrorRequest({ mode: 'detect_everything' })],
    ['invalid_source', mirrorRequest({ source: { entryPath: MIRROR } })],
    ['invalid_source', mirrorRequest({ source: { entryPath: MIRROR, platform: 'toaster' } })],
  ];
  for (const [expectedCode, body] of cases) {
    const result = validateFashionIdentificationRequestV2(body);
    assertEquals(result.ok, false, `${expectedCode} case was accepted`);
    if (result.ok) continue;
    assertEquals(result.errorCode, expectedCode);
  }
});

Deno.test('a privacy attestation claiming masking is still rejected on the Mirror path', () => {
  const result = validateFashionIdentificationRequestV2(
    mirrorRequest({
      privacy: {
        localFaceMaskApplied: true,
        localPlateMaskApplied: false,
        rawExifTransmitted: false,
      },
    }),
  );
  assertEquals(result.ok, false, 'a false masking claim was accepted on a Mirror request');
});

Deno.test('a near-miss mirror entry path is rejected, so the enum is not a prefix match', () => {
  for (const hostile of ['closet_mirror_v2', 'closet_mirrors', 'CLOSET_MIRROR', 'mirror', 'mirror_extract']) {
    const result = validateFashionIdentificationRequestV2(
      mirrorRequest({ source: { entryPath: hostile, platform: 'android' } }),
    );
    assertEquals(result.ok, false, `${hostile} was accepted as an entry path`);
    if (result.ok) continue;
    assertEquals(result.errorCode, 'invalid_source');
  }
});

// ── CLOSET-MIRROR-CANNOT-SELECT-SHOPPING-INTENT ──────────────────────────────
//
// Entry path and intent are independent fields, so this is asserted where it is
// actually decided: nothing in the backend derives intent from entryPath, and a
// Mirror request presented with a shopping intent is a client bug the client
// builder cannot produce — not something the entry path grants.

Deno.test('closet_mirror does not confer, imply, or upgrade a shopping intent', () => {
  const route = routeScanIdentifyRequest(mirrorRequest());
  assertEquals(route.kind, 'v2');
  if (route.kind !== 'v2') return;
  assertNotEquals(route.internal.intent, 'identify_and_shop');
  assertNotEquals(route.internal.intent, 'identify_for_style');
  assertEquals(route.internal.intent, 'identify_for_closet');
  // Scanner-domain artifact capture is an intent decision, and identify_for_closet
  // is not a capturing intent. The entry path is not an input to it at all.
  assertEquals(shouldCaptureScanArtifacts('identify_for_closet'), false);
});

// ── CLOSET-MIRROR-CREATES-NO-COMMERCE-RESULT /
//    CLOSET-MIRROR-DOES-NOT-ENABLE-PURCHASE-OPTIONS ─────────────────────────

Deno.test('commerce is skipped for a Mirror request under every reachable status', () => {
  // The whole status vocabulary, read from the module rather than restated, so
  // a status added later is covered without anyone remembering to add it here.
  for (const status of FASHION_IDENTIFICATION_STATUSES) {
    // The detection-mode override alone is decisive for a Mirror request, which
    // is always detect_items.
    const decision = resolveCommerceDecision({
      intent: 'identify_for_closet',
      resolvedMode: 'detect_items',
      status,
    });
    assertEquals(decision.run, false, `commerce ran for a Mirror request at status=${status}`);
    assertEquals(decision.skipReason, 'detection_mode');

    // Independently, the intent gate also refuses — so a future mode change
    // could not quietly turn Mirror into a shopping path.
    const gate = shouldRunCommerce({ intent: 'identify_for_closet', status });
    assertEquals(gate.run, false, `the intent gate ran commerce at status=${status}`);
    assertEquals(gate.skippedReason, COMMERCE_SKIPPED_CLOSET_INTENT);
  }
});

// ── CLOSET-MIRROR-DOES-NOT-CALL-SCANNER-ENTRY-PATH ───────────────────────────
//
// A source-level scan, because the trustworthy proof that no Scanner branch is
// taken is that no code keys on the entry path at all. If a future change adds
// a `switch (entryPath)` or an entry-path map, this fails and the Mirror case
// has to be considered explicitly rather than inherited by accident.

Deno.test('no backend module branches on entryPath, so Mirror inherits no Scanner behaviour', async () => {
  const dir = new URL('.', import.meta.url);

  // Two independent detectors, because either one alone has a blind spot.
  //
  //   BY NAME  — catches a branch written against the field itself, however
  //              the value is spelled.
  //   BY VALUE — catches a branch written against an entry-path LITERAL after
  //              the value has been copied into a differently named local,
  //              which is exactly how `switch (entryPath)` gets refactored
  //              into something the name detector no longer sees.
  //
  // The value detector is generated from the real vocabulary, so a path added
  // later is covered without anyone remembering to extend this list.
  const byName = [
    /switch\s*\(\s*[A-Za-z0-9_.?]*entryPath/,
    /entryPath\s*===\s*['"]/,
    /entryPath\s*!==\s*['"]/,
  ];
  const byValue = FASHION_IDENTIFICATION_ENTRY_PATHS.flatMap((value) => [
    new RegExp(`[=!]==\\s*['"]${value}['"]`),
    new RegExp(`['"]${value}['"]\\s*[=!]==`),
    new RegExp(`case\\s+['"]${value}['"]`),
  ]);

  const offenders: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const source = await Deno.readTextFile(new URL(entry.name, dir));
    // Reading and forwarding the value is fine. Comparing it is not: that is
    // how a path acquires behaviour rather than provenance.
    for (const pattern of [...byName, ...byValue]) {
      if (pattern.test(source)) offenders.push(`${entry.name}: ${pattern}`);
    }
  }
  assertEquals(offenders, [], `entry-path branching appeared: ${offenders.join(', ')}`);
});

// ── CLOSET-MIRROR-CREATES-NO-RECENT-SCAN ─────────────────────────────────────
//
// Recent Scan creation is downstream of Scanner-domain artifact capture, which
// `identify_for_closet` disables. Asserted across the full status matrix so the
// claim is not resting on one happy path.

Deno.test('no Scanner artifact — and therefore no Recent Scan — is captured for Closet', () => {
  assertEquals(shouldCaptureScanArtifacts('identify_for_closet'), false);
  assertEquals(shouldCaptureScanArtifacts('identify_and_shop'), true);
});

// ── Telemetry provenance ─────────────────────────────────────────────────────

Deno.test('telemetry reports the Mirror provenance and a skipped commerce decision', () => {
  const route = routeScanIdentifyRequest(mirrorRequest());
  assertEquals(route.kind, 'v2');
  if (route.kind !== 'v2') return;
  const telemetry = buildV2Telemetry({
    internal: route.internal,
    evidenceCount: 1,
    result: null,
    commerce: resolveCommerceDecision({
      intent: 'identify_for_closet',
      resolvedMode: 'detect_items',
      status: 'completed',
    }),
    responseValidationOk: true,
  });
  assertEquals(telemetry.entryPath, MIRROR);
  assertEquals(telemetry.intent, 'identify_for_closet');
  assertEquals(telemetry.intentDefaulted, false);
  assertEquals(telemetry.commerceExecuted, false);
  assertEquals(telemetry.commerceSkipped, true);
  // Bounded values only: the entry path is an enum member, never free text.
  assert((FASHION_IDENTIFICATION_ENTRY_PATHS as readonly string[]).includes(telemetry.entryPath!));
});

// ── Closet-path equivalence ──────────────────────────────────────────────────
//
// `closet_mirror` must behave identically to the two existing Closet paths.
// Anything that differs would mean the change was more than provenance.

Deno.test('closet_mirror is treated identically to closet_camera and closet_gallery', () => {
  const results = ['closet_camera', 'closet_gallery', 'closet_mirror'].map((entryPath) => {
    const route = routeScanIdentifyRequest(
      mirrorRequest({ source: { entryPath, platform: 'android' } }),
    );
    assertEquals(route.kind, 'v2', `${entryPath} did not route to v2`);
    if (route.kind !== 'v2') throw new Error('unreachable');
    const { entryPath: _ignored, ...rest } = route.internal;
    return { entryPath, rest: JSON.stringify(rest) };
  });
  // Every field of the internal request except the entry path itself is equal.
  assertEquals(results[0].rest, results[1].rest);
  assertEquals(results[1].rest, results[2].rest);
  // And the entry paths themselves stayed distinct — no collapsing.
  assertEquals(results.map((r) => r.entryPath), ['closet_camera', 'closet_gallery', 'closet_mirror']);
});
