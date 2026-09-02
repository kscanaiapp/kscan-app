/**
 * Build 34 Scanner audit — SCAN-001 backend regression.
 *
 * A multi-item DETECTION response renders two shoppable surfaces on the
 * client (the per-item commerce shelf and the Purchase Options panel), and
 * BOTH are gated on `commerce.deferred === true`. Detection never runs
 * commerce inline — that is deliberate and unchanged — but it must still
 * report the deferral rather than a bare skip, or the client states
 * "No strong shopping match found." for a search that never ran.
 *
 * Source-wiring tests, matching the convention `commerceFunnel.v127.test.ts`
 * and `multiItemCommerceCorrelation.test.ts` already use for `index.ts`
 * internals that cannot be imported directly (the file is a Deno serve()
 * entrypoint, not an importable module).
 */
import assert from 'node:assert/strict';

async function readIndexSource(): Promise<string> {
  return await Deno.readTextFile(new URL('./index.ts', import.meta.url));
}

/** The `else if (useMultiItemDetectionProvider)` commerce branch, bounded. */
async function readDetectionBranch(): Promise<string> {
  const src = await readIndexSource();
  const start = src.indexOf('} else if (useMultiItemDetectionProvider) {');
  assert.ok(start > 0, 'the multi-item detection commerce branch is missing');
  const end = src.indexOf('} else if (isV2Request && !commerceDecision.run) {', start);
  assert.ok(end > start, 'could not bound the multi-item detection commerce branch');
  return src.slice(start, end);
}

Deno.test('the detection branch marks commerce deferred when the v127 funnel is on', async () => {
  const branch = await readDetectionBranch();
  assert.ok(
    branch.includes('deferred: true'),
    'a detection response must set commerce.deferred so the client dispatches MODE B ' +
      'for the items it already renders; without it both shelves state a no-match ' +
      'result for a search that never ran',
  );
  assert.ok(
    branch.includes('commerceFunnelEnabled'),
    'the deferral must be gated on the v127 funnel — with the funnel off the MODE B ' +
      'route does not exist server-side and every per-item request would fall through ' +
      "to the image path and return 'no image provided'",
  );
});

Deno.test('the detection branch keeps exact pre-v127 behaviour when the funnel is off', async () => {
  const branch = await readDetectionBranch();
  assert.ok(
    branch.includes("'multi_item_detection_only'"),
    'the funnel-off reason string must be preserved verbatim so a rollback is byte-identical',
  );
  assert.ok(
    branch.includes("commerceFunnelEnabled ? 'deferred' : 'none'"),
    'provider must stay "none" when the funnel is off',
  );
  assert.ok(
    branch.includes("? { deferred: true, funnelVersion: COMMERCE_FUNNEL_VERSION }") &&
      branch.includes(': {}'),
    'the deferral fields must be spread conditionally, never emitted unconditionally',
  );
});

Deno.test('detection still never runs commerce inline', async () => {
  const branch = await readDetectionBranch();
  assert.ok(
    branch.includes('finalRecommendedProducts = [];'),
    'detection must still return no offers of its own',
  );
  for (const forbidden of [
    'getScanCommerceResults',
    'getFastCommerceResults',
    'buildImageSimilarityMatches',
    'await ',
  ]) {
    assert.ok(
      !branch.includes(forbidden),
      `detection must not ${forbidden.trim()} — commerce is deferred off the scan critical ` +
        'path, not moved onto it',
    );
  }
});

Deno.test('the detection branch is still evaluated before the generic funnel branch', async () => {
  const src = await readIndexSource();
  const detection = src.indexOf('} else if (useMultiItemDetectionProvider) {');
  const funnel = src.indexOf('} else if (commerceFunnelEnabled) {');
  assert.ok(detection > 0 && funnel > detection,
    'branch order is load-bearing: the generic funnel branch must stay AFTER the ' +
      'detection branch so detection keeps its own (no-inline-commerce) treatment');
});
